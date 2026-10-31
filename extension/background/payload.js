// Payload builder: turns a snapshot into the redacted data the model sees, plus the maps that turn
// the model's short ids back into real tab and group ids. Pure: no browser, fetch, timers or storage.
// When in doubt this module sends less (notes/implementation-notes.md, "Payload redaction").

import { SYSTEM_PROMPT, buildUserMessage } from "../shared/prompt.js";
import { PLAN_SCHEMA } from "../shared/schema.js";
import { DEFAULT_ICON } from "../shared/icons.js";
import { DEFAULT_SENSITIVE } from "../shared/sensitive-defaults.js";

export const MAX_DISPLAY_LENGTH = 60;
export const MAX_TITLE_LENGTH = 120;
export const MAX_SAMPLES = 3;

export const DEFAULT_MODEL = "claude-haiku-5-5";
export const DEFAULT_EFFORT = "low";
// Thinking off: in the M1 benchmark, two passes at effort low without thinking took ~10 s and grouped
// ~90% of 257 real tabs; adaptive thinking was 2-4x slower for a small quality gain.
export const DEFAULT_THINKING = "disabled";
export const DEFAULT_MAX_TOKENS = 16000;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Thinking turned off ("disabled" on Haiku 5.5, "between_tools" on Sonnet 5.5) is refused above effort high.
const EFFORTS_WITHOUT_THINKING = ["low", "medium", "high"];
const THINKING_MODES = ["adaptive", "disabled"];
// The models Zen Tidy can call: the three the settings page offers, the only ones store.js saves. Each turns thinking
// off its own way (`thinkingOff`, the request's `thinking` field), and a wrong one is an HTTP 400 on every tidy:
// - Haiku 5.5 takes { type: "disabled" }, at effort high or below.
// - Sonnet 5.5 refuses "disabled"; { type: "between_tools" } is its thinking off, at effort high or below, with no
//   other field beside the type.
// - Opus 5.5 can't turn thinking off ("disabled" is a 400 at every effort): null, the field is left out, so the model
//   thinks adaptively and effort is the only control.
// A model id outside the table (a newer one a stored setting holds) gets no `thinking` field either: every current
// model then runs adaptive and takes the effort.
export const MODEL_PROFILES = Object.freeze({
  "claude-haiku-5-5": Object.freeze({ thinkingOff: Object.freeze({ type: "disabled" }) }),
  "claude-sonnet-5-5": Object.freeze({ thinkingOff: Object.freeze({ type: "between_tools" }) }),
  "claude-opus-5-5": Object.freeze({ thinkingOff: null }),
});

const ELLIPSIS = "…";
// An Anthropic key must never reach a payload, wherever it hides (title, host, path, group name, prefs).
const KEY_RE = /sk-ant-[A-Za-z0-9_-]+/gi;
// Unpaired UTF-16 halves go first: JSON.stringify sends them as invalid escapes, and stripping a
// character between a lone high and a lone low half would join them into a new code point.
const LONE_SURROGATE_RE = /\p{Cs}/gu;
// Control characters become spaces, so the words around them stay apart.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;
// Everything that renders as nothing (zero-width and bidi controls, soft hyphen, variation selectors,
// Hangul fillers, and the tag block used to smuggle hidden text to a model) is dropped: it can hide
// or reorder text, and the person previewing the tabs cannot see it.
const INVISIBLE_CHARS_RE = /[\p{Default_Ignorable_Code_Point}\u180E]/gu;

// Page text as it is sent. The sensitive check reads this form too, so the two never disagree.
function cleanText(text) {
  return text
    .replace(LONE_SURROGATE_RE, "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(INVISIBLE_CHARS_RE, "")
    .replace(/\s+/gu, " ");
}

function scrubKeys(text) {
  return typeof text === "string" ? text.replace(KEY_RE, ELLIPSIS) : "";
}

function capText(text, max) {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max - 1).join("") + ELLIPSIS : text;
}

// ---------------------------------------------------------------------------------------------
// URL shortening and redaction

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_RUN_RE = /[0-9a-f]{16,}/gi;
const DIGIT_RUN_RE = /\d{6,}/g;
const TOKEN_MIN_LENGTH = 16;
// Runs of base64/base64url/hex characters ("/" too, once a %2F is decoded). Anything else (".", ";",
// ":", spaces…) ends a run, so "<id>.png", JWT parts and ids inside longer text are each checked.
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_~-]{16,}/g;
const PART_SEPARATOR_RE = /[-_+=~/]+/;
// Camel-case aware chunks: "MyFileName" -> My|File|Name, "xK9f" -> x|K|9|f.
const CHUNK_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g;
// Short slug parts that carry meaning: version and format tags ("v1", "h264", "es2015", "4k").
const VERSION_TAG_RE = /^(?:[a-z]{1,3}\d{1,4}|\d{1,4}[a-z]{1,2})$/i;
// Short words in one consistent case ("vs", "pc", "XZ", "Docs"). Random parts mix case or digits.
const SHORT_WORD_RE = /^(?:[A-Z]?[a-z]+|[A-Z]+)$/;
const SHORT_PART_LENGTH = 5;
// Letter pairs that (almost) never occur inside English words but fill random ids ("zk", "qt",
// "jn"). Common pairs from other European languages are left out (Dutch "ij", German "zw", "tz").
const RARE_BIGRAMS = new Set(
  ("bq bx bz cg cj cv cx cz dq dx dz fq fv fx fz fj fk gq gx gj gk hx hz hj hk hq hv " +
    "jb jc jd jf jg jh jj jl jm jn jp jq jr js jt jv jw jx jy jz kq kx kz kj lq lx mq mx mz " +
    "pq px pz pj qa qb qc qd qe qf qg qh qi qj qk ql qm qn qo qp qq qr qs qt qv qw qx qy qz " +
    "rx rq sx sz tq tx vb vc vd vf vg vh vj vk vm vn vp vq vt vw vx vz wq wx wz wj " +
    "xb xd xf xg xj xk xm xn xr xv xw xz yq yx yj yy zb zc zd zf zg zj zk zm zn zp zq zr zv zx").split(" "),
);
// One percent-encoded UTF-8 sequence (1 to 4 bytes).
const UTF8_ESCAPE_RE = /%[0-7][0-9a-f]|%[cd][0-9a-f]%[89ab][0-9a-f]|%e[0-9a-f](?:%[89ab][0-9a-f]){2}|%f[0-4](?:%[89ab][0-9a-f]){3}/gi;

function parseUrl(url) {
  if (typeof url !== "string" || !url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function schemeOf(url) {
  const match = typeof url === "string" ? /^([a-z][a-z0-9+.-]*):/i.exec(url.trim()) : null;
  return match ? match[1].toLowerCase() : "";
}

function hostOf(parsed) {
  return parsed.hostname.toLowerCase().replace(/\.+$/, "");
}

// Decodes what it can. One bad escape ("50%-off", "%ZZ") must not leave the rest encoded, or the
// sensitive check would read "my%20prescription" while the display shows "my prescription".
function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(UTF8_ESCAPE_RE, (sequence) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        return sequence;
      }
    });
  }
}

function rareBigramCount(lower) {
  let count = 0;
  for (let i = 1; i < lower.length; i++) if (RARE_BIGRAMS.has(lower[i - 1] + lower[i])) count++;
  return count;
}

// A pronounceable letter chunk: some vowels, no long consonant cluster, and no letter pairs that
// English words avoid (a chunk of 12+ letters may have one, for compounds and joined words).
// Common digraphs count as one consonant, so "strengths" and "nightclub" pass.
function isWordLike(chunk) {
  if (chunk.length < 3 || /\d/.test(chunk)) return false;
  const lower = chunk.toLowerCase();
  if (rareBigramCount(lower) > (lower.length >= 12 ? 1 : 0)) return false;
  // A leading "y" is a consonant ("yes"); elsewhere it can be the only vowel ("rhythm").
  const sounds = lower.replace(/^y/, "j");
  const vowels = (sounds.match(/[aeiouy]/g) ?? []).length;
  const clusters = sounds.replace(/th|sh|ch|ph|gh|ck|ng|wh/g, "z");
  return vowels / lower.length >= 0.1 && !/[^aeiouy]{5,}/.test(clusters);
}

// How many characters of one dash/underscore-separated part look like language, and whether the
// part holds a word. Short parts count only as a number, a version tag or a short single-case word,
// so chunked codes such as "X7K9-Q2LM-8TNW" earn nothing.
function partStructure(part) {
  if (/^\d+$/.test(part)) return { chars: part.length, word: false };
  if (part.length <= 6 && VERSION_TAG_RE.test(part)) return { chars: part.length, word: false };
  if (part.length <= SHORT_PART_LENGTH && SHORT_WORD_RE.test(part)) {
    const word = rareBigramCount(part.toLowerCase()) === 0;
    return { chars: word ? part.length : 0, word };
  }
  if (part.length >= TOKEN_MIN_LENGTH && /^[0-9a-f]+$/i.test(part) && /\d/.test(part)) return { chars: 0, word: false };
  const chunks = part.match(CHUNK_RE) ?? [];
  const numbers = chunks.filter((chunk) => /^\d/.test(chunk));
  // All-caps ids (base32) form long, vowel-poor chunks; several digit runs give them away.
  if (!/[a-z]/.test(part) && numbers.length >= 2) return { chars: 0, word: false };
  const mixedCase = /[a-z]/.test(part) && /[A-Z]/.test(part);
  let chars = 0;
  let words = 0;
  for (const chunk of chunks) {
    // In mixed case, only Capitalized or lower-case words count: "HTMLParser" keeps "Parser",
    // while random runs like "KLXU" or "HVRYYKP" inside an id earn nothing.
    if (mixedCase && /^[A-Z]{2,}$/.test(chunk)) continue;
    if (isWordLike(chunk)) {
      chars += chunk.length;
      words++;
    }
  }
  // A word with one short number keeps it ("ECMAScript2024Features", "windows11").
  if (words && numbers.length === 1 && numbers[0].length <= 4) chars += numbers[0].length;
  return { chars, word: words > 0 };
}

// Product keys and gift-card codes: equal chunks ("X7K9-Q2LM-8TNW-Y4BH") that mix letters and
// digits, or are capitals only. Slugs almost never split that evenly.
function looksLikeCode(parts) {
  const size = parts[0]?.length ?? 0;
  if (parts.length < 3 || size < 4 || size > 6 || parts.some((part) => part.length !== size)) return false;
  const mixed = parts.filter((part) => /\d/.test(part) && /[a-z]/i.test(part)).length;
  return mixed >= 2 || (parts.length >= 4 && parts.every((part) => /^[A-Z]+$/.test(part)));
}

// "No word structure": no word at all, or less than 60% of the characters belong to words, numbers
// and version tags. Mixed-case ids break into many tiny chunks, and lower-case ids are full of
// letter pairs that words avoid.
function looksLikeId(run) {
  if (/^[0-9a-f]+$/i.test(run) && /\d/.test(run)) return true;
  const parts = run.split(PART_SEPARATOR_RE).filter(Boolean);
  if (looksLikeCode(parts)) return true;
  let total = 0;
  let structured = 0;
  let hasWord = false;
  for (const part of parts) {
    const { chars, word } = partStructure(part);
    total += part.length;
    structured += chars;
    hasWord ||= word;
  }
  return total > 0 && (!hasWord || structured / total < 0.6);
}

function redactSegment(segment) {
  if (!segment) return segment;
  // UUIDs first, so "report-<uuid>.pdf" keeps its word; hex runs after the id check, so a slug that
  // ends in a long hash goes as a whole.
  return scrubKeys(segment)
    .replace(UUID_RE, ELLIPSIS)
    .replace(TOKEN_RUN_RE, (run) => (looksLikeId(run) ? ELLIPSIS : run))
    .replace(HEX_RUN_RE, (run) => (/\d/.test(run) && /[a-f]/i.test(run) ? ELLIPSIS : run))
    .replace(DIGIT_RUN_RE, ELLIPSIS);
}

// Decoded for readability. A "?" or "#" here was encoded, so it is part of the segment; when text
// follows it, it is most likely a nested URL's query or fragment, which is cut like any other.
// A trailing one stays encoded ("What%3F", "C%23") so the path never looks like it has a query.
function cleanSegment(segment) {
  let text = cleanText(safeDecode(segment));
  const cut = /[?#](?=.)/u.exec(text);
  if (cut) text = text.slice(0, cut.index) + ELLIPSIS;
  return text.replace(/\?/g, "%3F").replace(/#/g, "%23");
}

// ";name=value" path parameters (";jsessionid=…") do a query string's job, so they go too.
function dropPathParams(segment) {
  const semicolon = segment.indexOf(";");
  return semicolon < 0 ? segment : segment.slice(0, semicolon);
}

function redactPath(pathname) {
  if (!pathname || pathname === "/") return "";
  const path = pathname
    .split("/")
    .map((segment) => redactSegment(cleanSegment(dropPathParams(segment))))
    .join("/");
  return path === "/" ? "" : path;
}

function fileExtension(pathname) {
  const last = safeDecode(pathname.split("/").pop() ?? "");
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(last);
  return match ? match[1].toLowerCase() : "";
}

export function shortenUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed) {
    const scheme = schemeOf(url);
    return { scheme, site: "", path: "", display: scheme ? `${scheme}:` : "", kind: "other" };
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "http" || scheme === "https") {
    const site = scrubKeys(hostOf(parsed).replace(/^www\./, ""));
    const path = redactPath(parsed.pathname);
    return { scheme, site, path, display: capText(site + path, MAX_DISPLAY_LENGTH), kind: "web" };
  }
  if (scheme === "file") {
    const ext = fileExtension(parsed.pathname);
    return { scheme, site: "", path: "", display: ext ? `[local file] .${ext}` : "[local file]", kind: "file" };
  }
  return { scheme, site: "", path: "", display: `${scheme}:`, kind: "other" };
}

// ---------------------------------------------------------------------------------------------
// Sensitive detection

// Fold text into " word word " form: lower-case, accents and compatibility forms removed, and any
// run of non-letters/digits turned into one space. Whole-word matching is then a substring check.
function foldWords(text) {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Both the plain and a split form, so "onlineBanking" matches "banking", "TaxReturn2025.pdf" matches
// "tax return" and "PDFInvoice" matches "invoice", while "MyChart" and "401k" still match whole.
// Fields are joined by double spaces, so a phrase never spans two fields.
function wordForm(text) {
  if (typeof text !== "string" || !text) return " ";
  const plain = foldWords(text);
  const split = foldWords(
    text
      .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
      .replace(/(\p{L})(\p{N})/gu, "$1 $2")
      .replace(/(\p{N})(\p{L})/gu, "$1 $2"),
  );
  return split === plain ? ` ${plain} ` : ` ${plain}  ${split} `;
}

// Settings entries may be "*.x", ".x", a full URL, an IDN or "host:port". The URL parser gives the
// form tab hosts use (punycode, no port, user info or path).
function normalizeDomain(entry) {
  let domain = typeof entry === "string" ? entry.trim().toLowerCase() : "";
  if (!domain.includes("://")) domain = `http://${domain.replace(/^\*\./, "").replace(/^\.+/, "")}`;
  const host = parseUrl(domain)?.hostname ?? "";
  return host
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "")
    .replace(/^www\./, "");
}

// Host stems compare against the host with its hyphens removed, so they are kept as plain ASCII
// letters and digits; an entry with nothing left (or a dot, which would span two labels) is dropped.
function normalizeStem(entry) {
  const stem = typeof entry === "string" ? entry.trim().toLowerCase().replace(/-/g, "") : "";
  return /^[a-z0-9]+$/.test(stem) ? stem : "";
}

function compileLists(domains, keywords, hostStems) {
  return {
    domains: domains.map(normalizeDomain).filter(Boolean),
    keywords: keywords
      .map((keyword) => (typeof keyword === "string" ? foldWords(keyword) : ""))
      .filter(Boolean)
      .map((keyword) => ` ${keyword} `),
    hostStems: hostStems.map(normalizeStem).filter(Boolean),
  };
}

let compiledDefaults = null;

// A missing field (settings not loaded yet, or settings saved before host stems existed) falls back
// to the defaults instead of turning detection off. Only an explicit [] is the user's opt-out.
function compileSensitive(config) {
  const source = config ?? DEFAULT_SENSITIVE;
  if (source === DEFAULT_SENSITIVE) {
    compiledDefaults ??= compileLists(DEFAULT_SENSITIVE.domains, DEFAULT_SENSITIVE.keywords, DEFAULT_SENSITIVE.hostStems);
    return compiledDefaults;
  }
  return compileLists(
    Array.isArray(source.domains) ? source.domains : DEFAULT_SENSITIVE.domains,
    Array.isArray(source.keywords) ? source.keywords : DEFAULT_SENSITIVE.keywords,
    Array.isArray(source.hostStems) ? source.hostStems : DEFAULT_SENSITIVE.hostStems,
  );
}

// Host and the full path, decoded segment by segment, before any redaction or truncation.
function sensitiveParts(url) {
  const parsed = parseUrl(url);
  if (!parsed) return { host: "", segments: [] };
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (scheme === "view-source") return sensitiveParts(url.slice(url.indexOf(":") + 1));
  const segments = () => parsed.pathname.split("/").map(safeDecode);
  if (scheme === "http" || scheme === "https") return { host: hostOf(parsed), segments: segments() };
  if (scheme === "file") return { host: "", segments: segments() };
  return { host: "", segments: [] };
}

// An escape that could not be decoded is a word break, so its hex never sticks to the next word.
const leftoverEscapes = (text) => text.replace(/%[0-9a-f]{2}/gi, " ");

function matchSensitive(tab, compiled) {
  const { host, segments } = sensitiveParts(tab?.url);
  if (host && compiled.domains.some((domain) => host === domain || host.endsWith(`.${domain}`))) return true;
  // Host only: titles and paths are prose, where a stem can sit inside an unrelated word.
  if (host && compiled.hostStems.length) {
    const joined = host.replace(/-/g, "");
    if (compiled.hostStems.some((stem) => joined.includes(stem))) return true;
  }
  if (!compiled.keywords.length) return false;
  const title = typeof tab?.title === "string" ? tab.title : "";
  // The raw text and the cleaned text that is sent: an invisible character splits a word in the
  // first ("my\u200Bprescriptions") and joins it in the second ("Pa\u00ADtient" is sent as "Patient").
  const haystack =
    wordForm(host) +
    wordForm(leftoverEscapes(segments.join("/"))) +
    wordForm(leftoverEscapes(segments.map(cleanText).join("/"))) +
    wordForm(title) +
    wordForm(cleanText(title));
  return compiled.keywords.some((keyword) => haystack.includes(keyword));
}

export function isSensitive(tab, sensitiveConfig = DEFAULT_SENSITIVE) {
  return matchSensitive(tab, compileSensitive(sensitiveConfig));
}

// ---------------------------------------------------------------------------------------------
// Titles

// URL-like tokens. A bare "#123" or "C#" is not one: a fragment counts only after a path.
const URL_TOKEN_RES = [
  /[a-z][a-z0-9+.-]*:\/\//i, //                                     scheme://…
  /\bwww\.[a-z0-9-]+\.[a-z]/i, //                                   www.host
  /(?:^|[^\w@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#]\S/i, //   host/path, host?query, host#frag
  /\/[^\s?]*\?[^\s=]*=/, //                                         path?key=value
  /\/[^\s#]*#\S/, //                                                path#fragment
  /\b[a-z]:[\\/]/i, //                                              C:\local\path, C:/local/path
  /\\\\[^\s\\]+\\/, //                                              \\server\share
  /(?:^|[\s"'([])(?:~|\/(?:home|users|root|volumes|mnt|media|tmp))\/[^\s/]/i, // ~/x, /home/x
];

// Long addresses are often cut (by the page, or by the scan window below), so a title that holds the
// first 64 characters of the tab's URL or label counts as holding it.
const URL_FORM_PREFIX = 64;

function stripScheme(url) {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^www\./i, "");
}

function safeDecodeUri(text) {
  try {
    return decodeURI(text);
  } catch {
    return text;
  }
}

// Pages control their titles, so bound the work: only the first 120 characters are ever sent, and
// the token patterns look a little further than that to catch a token cut by the cap.
const TITLE_SCAN_LENGTH = 512;
const TITLE_KEEP_LENGTH = TITLE_SCAN_LENGTH * 4;

function titleLooksLikeUrl(title, url) {
  KEY_RE.lastIndex = 0;
  const scan = title.slice(0, TITLE_SCAN_LENGTH);
  if (KEY_RE.test(title) || URL_TOKEN_RES.some((re) => re.test(scan))) return true;
  const lower = title.toLowerCase();
  const forms = [url, stripScheme(url)];
  const parsed = parseUrl(url);
  // The tab's own "?query" and "#fragment", prefix included so "#top" doesn't catch "Top 10 …".
  if (parsed?.search.length > 3) forms.push(parsed.search);
  if (parsed?.hash.length > 3) forms.push(parsed.hash);
  return forms
    .flatMap((form) => [form, safeDecodeUri(form)])
    .map((form) => form.slice(0, URL_FORM_PREFIX).toLowerCase())
    .some((form) => form && lower.includes(form));
}

function cleanTitle(title) {
  return typeof title === "string" ? cleanText(title.slice(0, TITLE_KEEP_LENGTH)).trim() : "";
}

export function payloadTitle(tab) {
  const info = shortenUrl(tab?.url);
  if (info.kind !== "web") return null;
  const title = cleanTitle(tab?.title);
  // An empty title or one that is really an address gets the already-redacted site + path instead.
  if (!title || titleLooksLikeUrl(title, tab.url)) return info.display;
  return capText(title, MAX_TITLE_LENGTH);
}

// ---------------------------------------------------------------------------------------------
// Payload and request body

function isLooseTab(tab) {
  return !tab.pinned && (tab.groupId ?? -1) === -1;
}

// Group names and preferences go through the same cleaning as page text, then lose any key.
function cleanName(name) {
  return typeof name === "string" ? scrubKeys(cleanText(name).trim()) : "";
}

// The person's own text keeps its line breaks; only invisible characters, broken halves and keys go.
function cleanPreferences(preferences) {
  if (typeof preferences !== "string") return "";
  return scrubKeys(preferences.replace(LONE_SURROGATE_RE, "").replace(INVISIBLE_CHARS_RE, ""));
}

function samplesFor(group, tabsById, compiled, forced) {
  const samples = [];
  for (const tabId of Array.isArray(group.tabIds) ? group.tabIds : []) {
    if (samples.length >= MAX_SAMPLES) break;
    const tab = tabsById.get(tabId);
    if (!tab || forced.has(tabId) || matchSensitive(tab, compiled)) continue;
    const title = payloadTitle(tab);
    if (title && !samples.includes(title)) samples.push(title);
  }
  return samples;
}

// Tabs the model refused before (by tab key, mapped to ids by the caller) arrive as forcePrivateTabIds:
// they are sent site-only like sensitive tabs, since their titles most likely caused the refusal.
// For the same reason they are never used as group samples.
export function buildPayload(snapshot, { sensitive = DEFAULT_SENSITIVE, preferences = "", forcePrivateTabIds = [] } = {}) {
  const compiled = compileSensitive(sensitive);
  const forced = new Set(typeof forcePrivateTabIds?.[Symbol.iterator] === "function" ? forcePrivateTabIds : []);
  const allTabs = (Array.isArray(snapshot?.tabs) ? snapshot.tabs : []).filter((tab) => tab && typeof tab === "object");
  const tabsById = new Map(allTabs.map((tab) => [tab.id, tab]));
  const looseIds = new Set(Array.isArray(snapshot?.looseTabIds) ? snapshot.looseTabIds : allTabs.filter(isLooseTab).map((tab) => tab.id));
  const splitIds = new Set(Array.isArray(snapshot?.splitTabIds) ? snapshot.splitTabIds : []);

  const tabs = [];
  const idMap = {};
  const privateTabIds = [];
  const excluded = [];
  const seen = new Set();
  // Snapshot order, not looseTabIds order, so short ids follow the tab strip.
  for (const tab of allTabs) {
    if (seen.has(tab.id) || !looseIds.has(tab.id) || splitIds.has(tab.id) || !isLooseTab(tab)) continue;
    seen.add(tab.id);
    const info = shortenUrl(tab.url);
    if (info.kind !== "web") {
      excluded.push(tab.id);
      continue;
    }
    const id = tabs.length + 1;
    idMap[id] = tab.id;
    if (forced.has(tab.id) || matchSensitive(tab, compiled)) {
      tabs.push({ id, private: true, site: info.site });
      privateTabIds.push(tab.id);
    } else {
      tabs.push({ id, title: payloadTitle(tab), site: info.display });
    }
  }

  const existingGroups = [];
  const groupMap = {};
  for (const group of Array.isArray(snapshot?.tidyGroups) ? snapshot.tidyGroups : []) {
    const number = existingGroups.length + 1;
    groupMap[number] = group.id;
    existingGroups.push({
      group: number,
      name: cleanName(group.name),
      icon: group.icon || DEFAULT_ICON,
      samples: samplesFor(group, tabsById, compiled, forced),
    });
  }

  const chars = buildUserMessage({ existingGroups, tabs, preferences: cleanPreferences(preferences) }).length;
  return {
    tabs,
    existingGroups,
    idMap,
    groupMap,
    privateTabIds,
    stats: { tabs: tabs.length, private: privateTabIds.length, groups: existingGroups.length, chars, excluded },
  };
}

// The request's `thinking` field for this model, or null to leave it out: adaptive as asked, else thinking off the
// model's own way (MODEL_PROFILES).
function thinkingField(model, thinking) {
  if (thinking === "adaptive") return { type: "adaptive" };
  const off = Object.hasOwn(MODEL_PROFILES, model) ? MODEL_PROFILES[model].thinkingOff : null;
  return off ? { ...off } : null;
}

// Body for POST /v1/messages. Never temperature, top_p, top_k, budget_tokens or an assistant
// prefill: each one is an HTTP 400 on the 5.5 models.
export function buildRequestBody(payload, options = {}) {
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? DEFAULT_EFFORT;
  const thinking = options.thinking ?? DEFAULT_THINKING;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (typeof model !== "string" || !model) throw new TypeError("model must be a non-empty string");
  if (!EFFORTS.includes(effort)) throw new RangeError(`Unknown effort "${effort}"`);
  if (!THINKING_MODES.includes(thinking)) throw new RangeError(`Unknown thinking mode "${thinking}"`);
  const thinkingParam = thinkingField(model, thinking);
  if (thinkingParam && thinkingParam.type !== "adaptive" && !EFFORTS_WITHOUT_THINKING.includes(effort)) {
    throw new RangeError(`thinking "${thinkingParam.type}" needs effort low, medium or high (got "${effort}")`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) throw new RangeError("maxTokens must be a positive integer");

  const content = buildUserMessage({
    existingGroups: Array.isArray(payload?.existingGroups) ? payload.existingGroups : [],
    tabs: Array.isArray(payload?.tabs) ? payload.tabs : [],
    preferences: cleanPreferences(options.preferences),
  });
  return {
    model,
    max_tokens: maxTokens,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    output_config: { effort, format: { type: "json_schema", schema: PLAN_SCHEMA } },
    ...(thinkingParam ? { thinking: thinkingParam } : {}),
  };
}
