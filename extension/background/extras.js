// Extras detection (pure: no browser, fetch, timers or storage): the duplicate and stale tabs the preview offers to
// close, all unticked. It reads only the snapshot, and nothing from here is ever sent to the model.
// Rules: notes/m4-contracts.md ("Extras detection"); what must never be touched: notes/implementation-notes.md
// ("Zen / Firefox facts").

import { TRACKING_PARAMS, TRACKING_PARAM_PREFIXES } from "../shared/tracking-params.js";
import { DEFAULT_STALE_DAYS, holdsKey } from "./store.js";

const NO_GROUP = -1;
const DAY_MS = 86_400_000;
const TRACKING_NAMES = new Set(TRACKING_PARAMS);
// Undo can reopen only http(s) tabs, so nothing else is ever offered. Case-insensitive like apply.js's re-check, so
// both agree on every tab; a host is required too: "https:x" is no web page.
const WEB_URL_RE = /^https?:\/\/[^/?#]/i;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

// run.js may pass a value or a generator, as for buildPreview.
function resolve(value) {
  return typeof value === "function" ? value() : value;
}

// Firefox lower-cases ASCII only before it looks a name up (URLQueryStringStripper), so "MKT_TOK" matches while a
// look-alike such as the Kelvin sign in "mKt_tok" does not; String#toLowerCase would fold that one to "k".
function asciiLower(text) {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

// A parameter's name as the server reads it: the text before the first "=", percent-decoded. A malformed escape
// keeps the raw text, which then matches only if the name was spelled out plainly.
function paramName(piece) {
  const equals = piece.indexOf("=");
  const raw = equals < 0 ? piece : piece.slice(0, equals);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// True for a name on Firefox's query-stripping list or in the utm_* family (shared/tracking-params.js).
export function isTrackingParam(name) {
  if (typeof name !== "string") return false;
  const lower = asciiLower(name);
  return TRACKING_NAMES.has(lower) || TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

// The URL with its tracking parameters removed and everything else exactly as it was: scheme, host, path, the
// other parameters in their order and spelling, and the #fragment, so separate Gmail threads never match. The query
// is what lies between the first "?" and the first "#"; a "?" inside the fragment belongs to the fragment. Empty
// pieces (a bare "?", "a=1&&b=2", a trailing "&") carry no parameter and are dropped, and the "?" goes when no
// parameter is left, so "/p?utm_source=x" and "/p" compare equal.
export function normalizeUrl(url) {
  if (typeof url !== "string") return "";
  const hashAt = url.indexOf("#");
  const head = hashAt < 0 ? url : url.slice(0, hashAt);
  const fragment = hashAt < 0 ? "" : url.slice(hashAt);
  const queryAt = head.indexOf("?");
  if (queryAt < 0) return url;
  const kept = head.slice(queryAt + 1).split("&").filter((piece) => piece !== "" && !isTrackingParam(paramName(piece)));
  return `${head.slice(0, queryAt)}${kept.length ? `?${kept.join("&")}` : ""}${fragment}`;
}

// The extension's own pages (the popup or Settings open in a tab). ownOrigin is runtime.getURL(""),
// "moz-extension://<uuid>/", so the http(s) rule already keeps them out; the check keeps the contract's rule
// standing on its own for any origin a caller passes.
function ownPageTest(ownOrigin) {
  if (typeof ownOrigin !== "string" || !/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.test(ownOrigin)) return () => false;
  const prefix = ownOrigin.endsWith("/") ? ownOrigin : `${ownOrigin}/`;
  return (tab) => tab.url.startsWith(prefix);
}

// Every web page the snapshot shows, in strip order: takeSnapshot's tabs.query covers the active Space and the
// current Essentials, nothing from another Space. Duplicate sets are built from all of them, whatever their state
// (pinned, an Essential or a Zen folder tab, the active tab, a split tab, a Glance suspect, a tab in someone's own
// group), so a loose copy of the page being looked at, or of a pinned page, is found. Only candidates (canOffer) are
// ever offered. Left out: entries that are not tabs, pages that are not http(s) and the extension's own pages, none
// of which is ever offered either. A tab listed twice counts once: it would otherwise form a set with itself and be
// offered for closing, keeping itself.
function webTabs(snapshot, ownOrigin) {
  if (!isObject(snapshot)) return [];
  const isOwnPage = ownPageTest(ownOrigin);
  const seen = new Set();
  return list(snapshot.tabs).filter((tab) => {
    if (!isObject(tab) || !Number.isInteger(tab.id) || seen.has(tab.id)) return false;
    seen.add(tab.id);
    return typeof tab.url === "string" && WEB_URL_RE.test(tab.url) && !isOwnPage(tab);
  });
}

// The rule for which web tabs may be offered: loose tabs and tabs in tidy groups that are unpinned, not in a split,
// not the active tab and not a Glance suspect. A snapshot from takeSnapshot never lists a pinned or split tab as
// loose or in a tidy group; those checks still stand, because closing either is never undone safely (a split
// partner, a Zen folder tab or an Essential). Nor a page whose address holds a key-shaped string (store.js
// holdsKey): the journal that keeps a closed tab's address for undo scrubs such a string, so undo would reopen
// another address. Such a tab can still be the kept copy of a set.
function offerTest(snapshot) {
  const looseIds = new Set(list(snapshot?.looseTabIds));
  const tidyGroupOf = new Map();
  for (const group of list(snapshot?.tidyGroups)) {
    if (isObject(group)) for (const tabId of list(group.tabIds)) tidyGroupOf.set(tabId, group.id);
  }
  const splitIds = new Set(list(snapshot?.splitTabIds));
  const suspectIds = new Set(list(snapshot?.glanceSuspectIds));
  return (tab) => {
    const groupId = tab.groupId ?? NO_GROUP;
    const inScope = looseIds.has(tab.id) ? groupId === NO_GROUP : tidyGroupOf.has(tab.id) && tidyGroupOf.get(tab.id) === groupId;
    return inScope && !tab.pinned && !splitIds.has(tab.id) && !isActive(tab, snapshot) && !suspectIds.has(tab.id) &&
      !holdsKey(tab.url);
  };
}

// The active tab, by its own flag or by the snapshot's activeTabId.
function isActive(tab, snapshot) {
  return Boolean(tab.active) || tab.id === snapshot?.activeTabId;
}

// A tab with no usable lastAccessed counts as used longest ago, and is never called stale.
function accessedAt(tab) {
  return Number.isFinite(tab.lastAccessed) && tab.lastAccessed > 0 ? tab.lastAccessed : -Infinity;
}

// Which copy of a page is kept: a pinned tab first (Essentials and Zen folder tabs are pinned too), then the active
// tab, then any other, and a Glance suspect last of all. Neither of the first two is ever offered, so it stays
// whatever is ticked, and keeping it lets every offerable copy be offered: the commonest duplicate is a link opened
// again while its first copy is the tab being looked at. A Glance tab is gone after a restart, so a possible one, even
// the active tab (an open Glance preview is active) or the copy used last, is kept only when no other copy can be:
// otherwise the copy that stays could be the one that vanishes, once its twin is ticked and closed. Split tabs and
// tabs in someone's own group get no preference of their own: they are kept only as the copy used last.
function keepRanker(snapshot) {
  const suspectIds = new Set(list(snapshot?.glanceSuspectIds));
  return (tab) => {
    if (tab.pinned) return 0;
    if (suspectIds.has(tab.id)) return 3;
    return isActive(tab, snapshot) ? 1 : 2;
  };
}

// True when `a` is the better copy to keep: the lower rank, then the one used last, then the lowest id.
function keptBefore(a, b, rankOf) {
  const rankA = rankOf(a);
  const rankB = rankOf(b);
  if (rankA !== rankB) return rankA < rankB;
  const atA = accessedAt(a);
  const atB = accessedAt(b);
  return atA !== atB ? atA > atB : a.id < b.id;
}

// Sets of web tabs with equal normalizeUrl forms; in each, every copy but the kept one that may be offered is
// offered. keptIds holds the kept copy of each offered duplicate, which is then offered nowhere else.
function findDuplicates(tabs, canOffer, snapshot) {
  const sets = new Map();
  for (const tab of tabs) {
    const key = normalizeUrl(tab.url);
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(tab);
  }
  const rankOf = keepRanker(snapshot);
  const keepOf = new Map();
  for (const copies of sets.values()) {
    if (copies.length < 2) continue;
    const keep = copies.reduce((best, tab) => (keptBefore(tab, best, rankOf) ? tab : best));
    for (const tab of copies) if (tab !== keep && canOffer(tab)) keepOf.set(tab.id, keep.id);
  }
  const duplicates = tabs
    .filter((tab) => keepOf.has(tab.id))
    .map((tab) => ({ tabId: tab.id, keepTabId: keepOf.get(tab.id), url: tab.url }));
  return { duplicates, keptIds: new Set(keepOf.values()) };
}

// The day count the stale list is found with: the setting, a whole number >= 0 as store.js keeps it, or the default.
// It is also what the popup's heading "Not opened in N days" shows, which accepts only whole numbers, so a fraction
// falls back here too rather than list tabs under a heading that names another count.
function staleThreshold(staleDays) {
  return Number.isInteger(staleDays) && staleDays >= 0 ? staleDays : DEFAULT_STALE_DAYS;
}

function findStale(tabs, threshold, now) {
  if (typeof now !== "number" || !Number.isFinite(now)) return [];
  const stale = [];
  for (const tab of tabs) {
    const at = accessedAt(tab);
    if (at === -Infinity) continue;
    const age = now - at;
    // 0 days takes every tab, even one used this very millisecond or stamped later than `now` by a clock change.
    if (threshold > 0 && !(age > threshold * DAY_MS)) continue;
    stale.push({ tabId: tab.id, days: Math.max(0, Math.floor(age / DAY_MS)) });
  }
  return stale;
}

// findExtras(snapshot, { staleDays, now, ownOrigin }) returns
//   { duplicates: [{ tabId, keepTabId, url }], stale: [{ tabId, days }], staleDays }, the lists in strip order.
// Only candidates are offered: loose tabs and tabs in tidy groups, http(s), unpinned, not in a split, not the active
// tab, not a Glance suspect, not one of the extension's own pages and not a page whose address holds a key-shaped
// string (offerTest, webTabs).
// - duplicates: every web tab the snapshot shows (webTabs: the active Space and the Essentials, pinned, active,
//   split and suspect tabs included) is sorted into sets of equal normalizeUrl forms. In each set one copy is kept:
//   a pinned tab first, then the active tab, then the copy used last (highest lastAccessed), then the lowest id, a
//   Glance suspect only when nothing else is left (keepRanker, keptBefore). The other copies that are candidates are offered, with keepTabId naming the kept copy;
//   copies that are not candidates are never offered, so a set made only of them offers nothing. `url` is the
//   offered tab's own URL, exactly as the tab has it.
// - The kept copy is never offered, as a duplicate or as stale, not even at staleDays 0: "Keeps: <title>" stays true
//   whatever else is ticked, and no set of ticks can close every copy of a page. A candidate kept only against
//   copies that can't be offered heads no "Keeps" line, so it can still be stale.
// - stale: the remaining candidates last used more than staleDays days before `now`; `days` is whole days since,
//   rounded down. staleDays 0 (the dev and test override) takes every remaining candidate. A staleDays that is not a
//   whole number >= 0 falls back to the setting's default (14). Nothing is stale without a lastAccessed, or when
//   `now` (a number or a function returning one) is not a valid time: nothing is offered on a guess.
// - staleDays: the day count the stale list was found with (after that fallback), always present, so the preview
//   can carry it to the popup's "Not opened in N days" heading and the heading names the rows' own threshold.
export function findExtras(snapshot, options) {
  const { staleDays, now, ownOrigin } = options ?? {};
  const threshold = staleThreshold(staleDays);
  const tabs = webTabs(snapshot, ownOrigin);
  const canOffer = offerTest(snapshot);
  const { duplicates, keptIds } = findDuplicates(tabs, canOffer, snapshot);
  const offered = new Set(duplicates.map((entry) => entry.tabId));
  const rest = tabs.filter((tab) => canOffer(tab) && !offered.has(tab.id) && !keptIds.has(tab.id));
  return { duplicates, stale: findStale(rest, threshold, resolve(now)), staleDays: threshold };
}
