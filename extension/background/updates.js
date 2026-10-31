// Updates never cut a run short, nor throw away a preview (notes/m7-contracts.md, "Update safety in the extension";
// checked against the Firefox 159 sources Zen 1.24b ships).
//
// Why. While the add-on has a runtime.onUpdateAvailable listener, Firefox postpones its update: the new version is
// downloaded and staged, and the listener is told (XPIInstall checkForBlockers -> postpone). It installs when the
// add-on calls runtime.reload() (ext-runtime.js: a pending upgrade, kept on the Extension object, is installed instead
// of a plain reload), or at Zen's next start. Without the listener the update replaces the add-on at once, and the
// background with it, in the middle of a tidy, an apply or an undo. The event is persistent (ext-runtime.js
// PERSISTENT_EVENTS): main.js adds the listener at load, it stays registered while the event page sleeps, and the event
// wakes the page. It fires once per staged update.
//
// When. At once if the runner is idle and no preview awaits the person's Apply; otherwise as soon as both hold. The
// reload is called under the runner's own lock, so no tidy, apply, undo or group action can start between the last
// check and Firefox swapping the add-on, and the lock is kept for RELOAD_GRACE_MS after it: a click in that moment
// answers busy instead of starting work the swap would cut short. A background still here after that didn't get the
// update (Firefox found no postponed install to resume); the lock goes back, the update stays staged for Zen's next
// start, and a later event tries again. Repeated events, while one reload is pending, reload once.
//
// What an update keeps. storage.local belongs to the add-on's id, which an update keeps: the key, the settings, the
// tidy and group journals, the collapsed groups and the refused tab keys are untouched, and onInstalled with reason
// "update" resets and migrates nothing (main.js). storage.session does NOT survive: Firefox keeps it per loaded
// instance of the add-on (ExtensionStorage.sys.mjs extensionStorageSession, a WeakMap keyed by the Extension object,
// which an update or a reload replaces). So an update loses what a restart of Zen loses: a finished run's report, the
// heartbeat and the spent-journal mark. The popup then opens idle, and Undo of the last apply is still offered, from
// the journal.
//
// A preview awaiting Apply holds the update back (the model's answer and the person's edits to it live only in
// storage.session, and the person paid a request for them). The update then waits until the run leaves "preview"
// (Apply, Cancel, or a new tidy that ends without one), which main.js reports through onRunChanged. It never waits
// longer than the preview lives: a preview ends at Zen's next start at the latest, which installs the staged update
// anyway. The wait outlives the event page, which sleeps after 30 s idle while the person looks at the preview: the
// staged update is noted in storage.session (UPDATE_PENDING_KEY), and the next page picks it up at load (resume).

const SILENT = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How soon a busy runner is looked at again when whenIdle settled but another action already holds the lock (a tidy
// takes the lock before its background work exists, so whenIdle can't wait for its first steps).
export const IDLE_POLL_MS = 500;
// Firefox shuts the old background down within a second of the reload; this is how long the lock is kept for it.
export const RELOAD_GRACE_MS = 10000;
// storage.session's note of a staged update, { version }, while it waits for a preview.
export const UPDATE_PENDING_KEY = "updatePending";

const versionOf = (details) => (typeof details?.version === "string" ? details.version : null);

// createUpdateGate({ api, runner, isPreviewing, log, wait, pollMs, graceMs }) returns
// { onUpdateAvailable(details), onRunChanged(), resume() }.
// runner is run.js's (isBusy, whenIdle, withLock); isPreviewing() resolves to true while a preview awaits Apply;
// api.runtime.reload applies the staged update; api.storage.session holds the note; wait(ms) is the timer.
// - onUpdateAvailable: Firefox staged an update. Notes it, then reloads when the runner is idle and no preview waits.
// - onRunChanged: the run's state changed. Tries again if an update is staged, else does nothing.
// - resume: at load, picks up an update a sleeping page had noted.
// Each resolves once the attempt is over (with the pending one's promise when one is under way; resume and
// onRunChanged with null when there is nothing to do) and never rejects: a failure is logged, and the update waits for
// the next event, run change or start of Zen.
export function createUpdateGate({
  api, runner, isPreviewing = async () => false, log = SILENT, wait = sleep, pollMs = IDLE_POLL_MS,
  graceMs = RELOAD_GRACE_MS,
}) {
  let staged = false;
  let pending = null;
  const session = api.storage.session;

  // The note is a hint for the next page, so a failure to write or remove it only costs that. Writes go one after the
  // other, so a note written for a second event can't land after the reload's removal.
  let writes = Promise.resolve();
  const queued = (write, failure) =>
    (writes = writes.then(write).catch((err) => log.warn(failure, { name: err?.name ?? null })));
  const note = (version) =>
    queued(() => session.set({ [UPDATE_PENDING_KEY]: { version } }), "could not note the staged update");
  const forget = () => queued(() => session.remove(UPDATE_PENDING_KEY), "could not clear the staged update's note");

  // Never a bare loop on isBusy: a settled whenIdle with the lock still held would spin without yielding.
  async function idle() {
    while (runner.isBusy()) {
      await runner.whenIdle();
      if (runner.isBusy()) await wait(pollMs);
    }
  }

  const held = () => log.info("the update waits until the preview is applied or dismissed");

  async function reloadWhenIdle() {
    for (;;) {
      let locked = false;
      try {
        await idle();
        // Checked before taking the lock, so the person's Apply never meets a busy lock while the update waits.
        if (await isPreviewing()) return held();
        let previewing = false;
        await runner.withLock(async () => {
          locked = true;
          // Nothing starts under the lock, but a tidy may have stored its preview between the check and the lock.
          previewing = await isPreviewing();
          if (previewing) return;
          staged = false;
          await forget();
          await api.runtime.reload();
          await wait(graceMs);
        });
        if (previewing) return held();
        log.warn("the update did not apply; it waits for the next start of Zen");
        return;
      } catch (err) {
        if (locked || err?.code !== "busy") {
          log.error("could not apply the update", { name: err?.name ?? null });
          return;
        }
      }
      // Another action took the lock between the idle check and here: wait for it too, after a poll's pause, so a
      // lock refused for any reason never turns this into a loop that doesn't yield.
      await wait(pollMs);
    }
  }

  function attempt(first = null) {
    if (!pending) {
      pending = Promise.resolve(first).then(reloadWhenIdle).finally(() => {
        pending = null;
      });
    }
    return pending;
  }

  return {
    onUpdateAvailable(details) {
      log.info("update available", { version: versionOf(details), waiting: runner.isBusy() });
      staged = true;
      return attempt(note(versionOf(details)));
    },

    onRunChanged() {
      return staged ? attempt() : Promise.resolve(null);
    },

    async resume() {
      let noted = null;
      try {
        noted = (await session.get(UPDATE_PENDING_KEY))?.[UPDATE_PENDING_KEY] ?? null;
      } catch (err) {
        log.warn("could not read the staged update's note", { name: err?.name ?? null });
      }
      if (!noted) return null;
      log.info("a staged update waits", { version: typeof noted.version === "string" ? noted.version : null });
      staged = true;
      return attempt();
    },
  };
}
