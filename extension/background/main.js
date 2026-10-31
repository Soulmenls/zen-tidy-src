// Background entry point (MV3 event page): wiring only. Each module it connects is tested in Node with
// fakes; this file itself is exercised in Zen. Listeners are registered synchronously at load, so the
// event that woke the page is delivered. No onMessageExternal or onConnectExternal listener, ever.

import { API_BASE } from "../shared/config.js";
import { requestPlan, testKey } from "./anthropic.js";
import { takeSnapshot } from "./snapshot.js";
import { buildPayload, buildRequestBody, buildCheckBody } from "./payload.js";
import { planTidy } from "./pipeline.js";
import { buildPreview, validateApplyRequest } from "./preview.js";
import { findExtras } from "./extras.js";
import { applyRequest } from "./apply.js";
import { planUndo, undoTidy } from "./undo.js";
import { listGroups, groupAction, undoGroupAction } from "./groups.js";
import { createLogger } from "./log.js";
import { createStore } from "./store.js";
import { createRunner } from "./run.js";
import { createRouter } from "./router.js";
import { createCollapseTracker } from "./collapse.js";
import { createUpdateGate } from "./updates.js";

// The dev build's gecko id (scripts/build-dev.mjs): only under it does the router admit the self-test page and its
// dev-only message. The release id never matches, so a release build has neither.
const DEV_ID = "zen-tidy-dev@soulaymane";
// The violation event is queued as its own task, so it may arrive just after fetch rejects.
const CSP_EVENT_GRACE_MS = 100;

const api = globalThis.browser;
const log = createLogger({ enabled: true });
// Unbound on purpose: window.fetch throws "Illegal invocation" when called on another object.
const fetchImpl = (...args) => fetch(...args);

// A CSP block raises the same fetch TypeError as being offline (M0); only this event tells them apart.
let lastBlockedAt = -Infinity;
if (typeof document !== "undefined") {
  document.addEventListener("securitypolicyviolation", (event) => {
    const directive = event.effectiveDirective || event.violatedDirective || "";
    if (directive.startsWith("connect-src")) lastBlockedAt = Date.now();
  });
}
const blockedSince = (at) =>
  new Promise((resolve) => setTimeout(() => resolve(lastBlockedAt >= at), CSP_EVENT_GRACE_MS));

const store = createStore(api);
// Made at load: it holds tabGroups events from here until runtime.onStartup or onInstalled (collapse.js).
const tracker = createCollapseTracker({ api, store, log });
// Apply, undo and the groups view each settle the groups they changed once they are done, so the final collapsed
// state is stored at once, not only by the read-back when the suppression window closes, which a background gone
// first (Zen quitting, the add-on reloading) never runs. The router passes each its options last,
// onOwnGroupChange among them; this collects the groups that hook is called for.
const settling = (operation) => async (...args) => {
  const options = args.pop();
  const changed = new Set();
  const onOwnGroupChange = (groupId) => {
    changed.add(groupId);
    return options.onOwnGroupChange(groupId);
  };
  try {
    return await operation(...args, { ...options, onOwnGroupChange });
  } finally {
    await tracker.settle([...changed]);
  }
};
const runner = createRunner({
  api, store, requestPlan, buildPreview, takeSnapshot, buildPayload, buildRequestBody, buildCheckBody, planTidy,
  findExtras, apiBase: API_BASE, fetchImpl, log, blockedSince, ownOrigin: api.runtime.getURL(""),
});
const router = createRouter({
  api, store, runner, validateApplyRequest, takeSnapshot, planUndo, listGroups, testKey, apiBase: API_BASE, fetchImpl,
  log, blockedSince, allowSelftest: api.runtime.id === DEV_ID,
  applyRequest: settling(applyRequest),
  undoTidy: settling(undoTidy),
  groupAction: settling(groupAction),
  undoGroupAction: settling(undoGroupAction),
  // Apply, undo and the groups view open a suppression window before every change they make to a group.
  onOwnGroupChange: (groupId) => tracker.suppress(groupId),
});

// storage.session survives an event-page restart, the in-memory lock doesn't: a run still marked
// running, applying or undoing belonged to the instance that died. Messages wait until this has run.
// The journal is left as it is, so an apply or undo cut short is still offered for undo.
const ready = runner.recover().catch((err) => log.error("could not recover the run state", { name: err?.name ?? null }));

api.runtime.onMessage.addListener((message, sender) => ready.then(() => router.handle(message, sender)));

// An update waits for the runner to be idle and for no preview to await Apply, then applies through runtime.reload
// (updates.js). Firefox postpones the update only while this listener exists, so it is added at load like the others.
const isPreviewing = async () => (await store.getRun())?.state === "preview";
const updates = createUpdateGate({ api, runner, log, isPreviewing });
api.runtime.onUpdateAvailable.addListener((details) => ready.then(() => updates.onUpdateAvailable(details)));
// A preview holding an update back ends with a change of the run's state (Apply, Cancel, a new tidy). storage.onChanged
// reports storage.session's changes to the background too (Firefox's ext-storage.js), and the gate tries again; only
// the run's state is looked at. A page that slept while an update waited picks it up at load.
api.storage.onChanged.addListener((changes, area) => {
  const run = area === "session" ? changes.run : undefined;
  if (run && run.oldValue?.state !== run.newValue?.state) ready.then(() => updates.onRunChanged());
});
ready.then(() => updates.resume());

// Collapsed state: a user collapse wakes the event page with its onUpdated, delivered only to a listener added at load.
// A group moved to another window comes back expanded with only onMoved to say so.
api.tabGroups.onUpdated.addListener((group) => tracker.onUpdated(group));
api.tabGroups.onMoved.addListener((group) => tracker.onMoved(group));
api.tabGroups.onRemoved.addListener((group, removeInfo) => tracker.onRemoved(group, removeInfo));
api.runtime.onStartup.addListener(() => tracker.onStartup());

// An update keeps the id, so storage.local (key, settings, journals, collapsed groups) is the previous version's and
// stays as it is: no reason resets or migrates anything. A version that changes a stored format must migrate by a
// schema version kept in storage.local and checked at every load, never on onInstalled's "update": an update staged
// for Zen's next start installs during that start, whose startupReason stays APP_STARTUP (Firefox 159's
// Extension.sys.mjs, BootstrapScope.update), so runtime.onStartup fires and onInstalled does not; "update" comes only
// with an update applied in the running session.
api.runtime.onInstalled.addListener(({ reason }) => {
  tracker.onInstalled();
  if (reason !== "install") return;
  store
    .getKeyStatus()
    .then(({ saved }) => (saved ? undefined : api.runtime.openOptionsPage()))
    .catch((err) => log.error("could not open the options page", { name: err?.name ?? null }));
});
