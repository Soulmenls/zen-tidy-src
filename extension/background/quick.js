// The toolbar button's one-click tidy. A left click tidies the active Space at once: the preview the tidy builds is
// applied unedited, as Apply right after Tidy would (popup-state.js's initEdits and toApplyRequest), so extras stay
// unticked and suspect tabs stay loose. The button then reads "Undo" for UNDO_WINDOW_MS, and a click there undoes.
// A middle click opens the popup, where the preview, the groups view and Settings are.
//
// Firefox opens the action's popup by itself on a left click whenever it has one, and only otherwise fires onClicked
// (triggerClickOrPopup in ExtensionActions.sys.mjs). So the background keeps the popup set while a click needs a
// decision: no key, other than exactly one window open (Apply asks twice then), a preview awaiting Apply, a run that
// failed, a run the popup started, or an Undo that was refused. The button's label is the action's title, set per
// window while it says something other than "Tidy". The user's CSS kit shows that label next to Zen's Clear
// (scripts/gen-css.mjs). Everywhere else Zen shows extension buttons as icons only and the title only on hover, so
// while a tidy or an undo is at work, and while Undo is offered, the icon also carries a badge, set per window with
// the title. The kit hides the badge next to Clear, where the label says it.
//
// What the button is doing lives in storage.session ("quick"), so an event page that restarts in the middle still
// knows; the label itself lives in Firefox and outlasts the page.

import { ACTIVE_STATES } from "./store.js";
import { canApply, extraTabIds, initEdits, toApplyRequest } from "../popup/popup-state.js";

export const POPUP_PATH = "popup/popup.html";
export const UNDO_WINDOW_MS = 10000;
// A click this soon after "Undo" ran out still undoes, though the button reads "Tidy" again by then: the label goes at
// the end of UNDO_WINDOW_MS, once sync has caught up, and the stored phase only this much later, so a click on "Undo"
// while it goes still finds it. Kept to about a reaction time, so a click aimed at the "Tidy" that replaced it tidies.
export const UNDO_GRACE_MS = 300;
export const NOTE_MS = 2500;
export const QUICK_KEY = "quick";
// The manifest's default_title is LABELS.idle; every other label is a window's own title.
export const LABELS = Object.freeze({
  idle: "Tidy",
  tidying: "Tidying…",
  undo: "Undo",
  undoing: "Undoing…",
  undone: "Undone",
  review: "Review",
  failed: "Tidy failed",
  undoFailed: "Undo failed",
  nothing: "Nothing to tidy",
});
// The badge a window's label brings, one glyph to read on a 16px icon: work at hand, or Undo. Every other label has
// none. The midline ellipsis (U+22EF), since "…" sits on the baseline, at the foot of the badge.
export const BADGES = Object.freeze({ [LABELS.tidying]: "⋯", [LABELS.undoing]: "⋯", [LABELS.undo]: "↶" });
// One pair for Zen's light and dark toolbars alike, since an action's badge can't follow the theme; Firefox's default
// is a warning red, a status colour Zen keeps out of its chrome. So Zen's accent at full strength: the default of
// --zen-primary-color, AccentColor (zen-theme.css:11), resolved for Windows' default accent, with AccentColorText. It
// stands over 3.5:1 against Zen's light and dark surfaces (#f4f4f4, #1f1f1f), and the glyph 4.5:1 on it. The primary
// button's mixes, #10446e and #8898a4, each read on one scheme only.
export const BADGE_COLORS = Object.freeze({ background: "#0078d4", text: "#ffffff" });
const PHASES = Object.freeze(["tidying", "undo", "undoing", "note"]);
const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

const isWindowId = (value) => Number.isInteger(value) && value >= 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
// How long a stored phase outlasts its label: only an Undo's does.
const graceOf = (quick) => (quick?.phase === "undo" ? UNDO_GRACE_MS : 0);
const badgeOf = (label) => (Object.hasOwn(BADGES, label) ? BADGES[label] : null);

// The stored "quick" value, or null when it is missing, malformed or past its `until` (plus `grace`).
export function liveQuick(quick, now, grace = 0) {
  if (!isObject(quick) || !PHASES.includes(quick.phase) || !isWindowId(quick.windowId)) return null;
  if (quick.until !== undefined && !(Number.isFinite(quick.until) && quick.until + grace > now)) return null;
  if (quick.phase === "note" && typeof quick.note !== "string") return null;
  return quick;
}

// What the button shows. { popup, windowId, label }: popup says whether a left click opens the popup; label, when
// not null, is window windowId's own title (every other window reads LABELS.idle).
// hasKey: a key is saved. windowCount: normal windows open, null when unknown. run: the stored run or null.
// quick: the stored "quick" value or null.
export function buttonView({ hasKey = false, windowCount = null, run = null, quick = null, now = 0 } = {}) {
  const state = run?.state ?? "idle";
  const live = liveQuick(quick, now);
  const ownRun = live && run?.windowId === live.windowId;
  // Before a one-click tidy or undo stores its own run, the last one is still there, finished.
  const settled = !ACTIVE_STATES.has(state) && state !== "preview" && state !== "error";
  // A one-click tidy or undo at work in its own run: the preview it is about to apply is part of it, and a click
  // meanwhile is dropped (onClicked) rather than opening a popup that would show the preview going.
  if (live?.phase === "tidying" && (settled || (ownRun && ["running", "preview", "applying"].includes(state)))) {
    return { popup: false, windowId: live.windowId, label: LABELS.tidying };
  }
  if (live?.phase === "undoing" && (settled || (ownRun && state === "undoing"))) {
    return { popup: false, windowId: live.windowId, label: LABELS.undoing };
  }
  const popup = !hasKey || windowCount !== 1 || state === "preview" || state === "error" || ACTIVE_STATES.has(state);
  if (live?.phase === "undo" && state === "applied" && run.id === live.runId && ownRun) {
    return { popup, windowId: live.windowId, label: LABELS.undo };
  }
  // A note marked popup (a refused Undo) hands the next click to the popup, which says why and still offers Undo.
  if (live?.phase === "note") return { popup: popup || live.popup === true, windowId: live.windowId, label: live.note };
  const runWindow = isWindowId(run?.windowId) ? run.windowId : null;
  if (runWindow === null) return { popup, windowId: null, label: null };
  if (state === "running" || state === "applying") return { popup, windowId: runWindow, label: LABELS.tidying };
  if (state === "undoing") return { popup, windowId: runWindow, label: LABELS.undoing };
  if (state === "preview") return { popup, windowId: runWindow, label: LABELS.review };
  if (state === "error") {
    return { popup, windowId: runWindow, label: run.error?.kind === "undo-failed" ? LABELS.undoFailed : LABELS.failed };
  }
  return { popup, windowId: null, label: null };
}

// createQuickTidy(deps) returns { init, sync, onClicked }.
// - init() sets the badge's colours, clears every window's own title and badge (ones left by an earlier page) and
//   syncs.
// - sync() sets the popup, the labels and the badges from what is stored now. Calls run one after another.
// - onClicked(tab, info) is action.onClicked's listener.
// deps: { api, store, runner, apply, undo, cancel, log, now, undoWindowMs, noteMs, setTimer, clearTimer }.
//   apply, undo and cancel are the router's own handlers (router.js), so a one-click tidy passes the same checks
//   (the preview still current, the window count, the Space, the shared lock) as the popup's Apply.
export function createQuickTidy(deps) {
  const {
    api, store, runner, apply, undo, cancel, log = SILENT, now = Date.now, undoWindowMs = UNDO_WINDOW_MS,
    noteMs = NOTE_MS, setTimer = setTimeout, clearTimer = clearTimeout,
  } = deps;
  const session = api.storage.session;
  // The windows given a title and a badge of their own by this page.
  const titled = new Set();
  let chain = Promise.resolve();
  let quickChain = Promise.resolve();
  let timer = null;
  // A click being handled: a second one meanwhile is dropped, as the runner's lock would refuse it anyway.
  let busy = false;

  async function readQuick() {
    const items = await session.get(QUICK_KEY);
    return items?.[QUICK_KEY] ?? null;
  }

  // Every change to the stored "quick" goes through here, one after another: fn(current) returns the value to store,
  // null to remove it, or undefined to leave it. So a click's write can't be lost to sync removing a phase that ran out.
  function updateQuick(fn) {
    const next = quickChain.then(async () => {
      const current = await readQuick();
      const value = fn(current);
      if (value === undefined) return current;
      await (value ? session.set({ [QUICK_KEY]: value }) : session.remove(QUICK_KEY));
      return value;
    });
    quickChain = next.catch(() => {});
    return next;
  }

  const writeQuick = (quick) => updateQuick(() => quick);

  // The add-on's popups open in that window (extension.getViews, synchronous).
  function openPopups(windowId) {
    try {
      return api.extension?.getViews?.({ type: "popup", windowId }) ?? [];
    } catch (err) {
      log.warn("could not list the open popups", { name: err?.name ?? null });
      return [];
    }
  }

  async function countWindows() {
    try {
      return (await api.windows.getAll({ windowTypes: ["normal"] })).length;
    } catch (err) {
      log.warn("could not count windows", { name: err?.name ?? null });
      return null;
    }
  }

  async function setTitle(title, windowId) {
    try {
      await api.action.setTitle({ title, windowId });
    } catch (err) {
      // The window closed meanwhile.
      log.debug("could not set the button's title", { name: err?.name ?? null });
    }
  }

  // text null clears the window's own badge, so it shows the global one, which is none.
  async function setBadge(text, windowId) {
    try {
      await api.action.setBadgeText({ text, windowId });
    } catch (err) {
      log.debug("could not set the button's badge", { name: err?.name ?? null });
    }
  }

  async function setBadgeColors() {
    try {
      await api.action.setBadgeBackgroundColor({ color: BADGE_COLORS.background });
      await api.action.setBadgeTextColor({ color: BADGE_COLORS.text });
    } catch (err) {
      log.debug("could not set the badge's colours", { name: err?.name ?? null });
    }
  }

  // Wakes sync when a stored phase runs out, so its label goes without waiting for another change, and again when an
  // Undo's grace runs out, to remove it. A phase already past both wakes it at once, to be removed.
  function schedule(quick, at) {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (!isObject(quick) || quick.until === undefined) return;
    const wake = quick.until > at ? quick.until : quick.until + graceOf(quick);
    timer = setTimer(() => {
      timer = null;
      sync();
    }, Math.max(0, wake - at));
  }

  async function syncNow() {
    // A phase that ran out is removed, so a later page never reads it. An Undo is kept UNDO_GRACE_MS past its label,
    // so a click on "Undo" while the label goes (setTitle below) still undoes rather than tidying again.
    const quick = await updateQuick((current) => (
      current && !liveQuick(current, now(), graceOf(current)) ? null : undefined
    ));
    const [key, run, windowCount] = await Promise.all([store.getKeyStatus(), store.getRun(), countWindows()]);
    const at = now();
    const view = buttonView({ hasKey: key.saved, windowCount, run, quick, now: at });
    await api.action.setPopup({ popup: view.popup ? POPUP_PATH : "" });
    for (const windowId of [...titled]) {
      if (windowId === view.windowId) continue;
      titled.delete(windowId);
      await setTitle(null, windowId);
      await setBadge(null, windowId);
    }
    if (view.label !== null) {
      titled.add(view.windowId);
      await setTitle(view.label, view.windowId);
      await setBadge(badgeOf(view.label), view.windowId);
    }
    schedule(quick, at);
  }

  function sync() {
    const next = chain.then(syncNow, syncNow);
    chain = next.catch((err) => log.warn("could not update the button", { name: err?.name ?? null }));
    return chain;
  }

  async function init() {
    // The tidy or undo a stored "tidying" or "undoing" stood for died with the page that ran it (the runner's lock is
    // in memory); its run, if any, is an interrupted error by now (runner.recover).
    try {
      await updateQuick((current) => (current?.phase === "tidying" || current?.phase === "undoing" ? null : undefined));
    } catch (err) {
      log.warn("could not read the button's state", { name: err?.name ?? null });
    }
    await setBadgeColors();
    try {
      for (const win of await api.windows.getAll({ windowTypes: ["normal"] })) {
        if (!isWindowId(win?.id)) continue;
        await setTitle(null, win.id);
        await setBadge(null, win.id);
      }
    } catch (err) {
      log.warn("could not reset the button's titles", { name: err?.name ?? null });
    }
    return sync();
  }

  async function note(windowId, text, { popup = false, ms = noteMs } = {}) {
    await writeQuick({ windowId, phase: "note", note: text, until: now() + ms, ...(popup ? { popup: true } : {}) });
    return sync();
  }

  async function finish() {
    await writeQuick(null);
    return sync();
  }

  async function tidy(windowId) {
    // The popup may not have caught up with a window opened a moment ago: nothing is sent to the API then, and sync
    // sets the popup for the next click.
    if ((await countWindows()) !== 1) return sync();
    await writeQuick({ windowId, phase: "tidying" });
    await sync();
    const started = await runner.start(windowId);
    if (started?.error === "nothing-to-tidy") return note(windowId, LABELS.nothing);
    // no-key and busy: sync shows the popup (no key) or the run at work.
    if (started?.error) return finish();
    await runner.whenIdle();
    const run = await store.getRun();
    // A failed tidy is an error run: sync labels it and sets the popup, which shows the error and Retry. A preview
    // someone is editing in a popup opened meanwhile (a middle click) is theirs to apply.
    if (run?.state !== "preview" || run.windowId !== windowId || !run.preview || run.edits) return finish();
    const edits = initEdits(run.preview);
    if (!canApply(edits, run.preview)) {
      // Duplicate or stale tabs to offer, and nothing else: the popup's preview shows them.
      if (extraTabIds(run.preview).length > 0) return finish();
      await cancel({ runId: run.id });
      return note(windowId, LABELS.nothing);
    }
    const result = await apply({ runId: run.id, request: toApplyRequest(edits), confirmMultiWindow: false });
    if (result?.ok !== true) {
      // The preview is kept (another window opened, another Space, a failure before the first change) or the run
      // is an error: either way the popup now opens on it, and the label says so.
      log.info("one-click apply stopped", { error: typeof result?.error === "string" ? result.error : null });
      return finish();
    }
    await writeQuick({ windowId, phase: "undo", runId: run.id, until: now() + undoWindowMs });
    return sync();
  }

  async function undoTidy(windowId) {
    await writeQuick({ windowId, phase: "undoing" });
    await sync();
    const result = await undo({ windowId, confirmMultiWindow: false });
    if (result?.ok === true) return note(windowId, LABELS.undone);
    // A refusal (another Space, another window, a window opened since) leaves the journal and the run as they were.
    // The next click opens the popup, which says why and still offers Undo, rather than tidying over that tidy.
    log.info("one-click undo stopped", { error: typeof result?.error === "string" ? result.error : null });
    return note(windowId, LABELS.undoFailed, { popup: true, ms: undoWindowMs });
  }

  // at: when the click came, so the reads below don't eat into Undo's grace.
  async function click(windowId, at) {
    const [stored, run] = await Promise.all([readQuick(), store.getRun()]);
    // An Undo whose label is going, or has just gone, still undoes: sync keeps it stored for its grace.
    const undoable = liveQuick(stored, at, graceOf(stored));
    if (undoable?.phase === "undo" && undoable.windowId === windowId && run?.state === "applied" && run.id === undoable.runId) {
      return undoTidy(windowId);
    }
    // A click on a note ("Undone", "Nothing to tidy") does nothing: the second click of a double-click lands here.
    if (liveQuick(stored, at)?.phase === "note") return undefined;
    if (runner.isBusy()) return undefined;
    return tidy(windowId);
  }

  function onClicked(tab, info) {
    const windowId = tab?.windowId;
    if (info?.button === 1) {
      // Both calls go out before any await: openPopup needs the click's user input, which an await would lose.
      // Firefox handles them in order, so the popup is set when openPopup reads it. Once it is open, sync puts the
      // popup back to what a left click should do; an open popup stays open.
      const calls = [
        api.action.setPopup({ popup: POPUP_PATH }),
        api.action.openPopup(isWindowId(windowId) ? { windowId } : {}),
      ];
      Promise.allSettled(calls).then((outcomes) => {
        if (outcomes[1].status === "rejected") log.warn("could not open the popup", { name: outcomes[1].reason?.name ?? null });
        return sync();
      });
      return;
    }
    if ((info?.button ?? 0) !== 0 || !isWindowId(windowId) || busy) return;
    // With the popup open (a middle click opened it, and the popup is unset again since), Firefox keeps the click to
    // itself: a real click rolls the popup's panel up, and one that reaches the button with the panel still open is
    // dropped (PanelUI.showSubView skips a button whose panel is open), so onClicked never fires; the shortcut closes
    // the popup itself (triggerAction in ext-browserAction.js). Should a click get here anyway, it closes the popup
    // too, and tidies nothing.
    const popups = openPopups(windowId);
    if (popups.length > 0) {
      for (const view of popups) view.close();
      return;
    }
    busy = true;
    click(windowId, now())
      .catch(async (err) => {
        log.warn("one-click tidy failed", { name: err?.name ?? null });
        try {
          await finish();
        } catch {
          // sync logs its own failure.
        }
      })
      .finally(() => {
        busy = false;
      });
  }

  return { init, sync, onClicked };
}
