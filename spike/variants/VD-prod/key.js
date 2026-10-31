// Key field exactly per the implementation notes. ?m=<mode> switches on an experimental mitigation:
//   m=change    : on the field's own "change" event, move the value into a JS variable and clear the field
//   m=mousedown : preventDefault on the Save button's mousedown so focus (and the change event) never leaves the field
const mode = new URLSearchParams(location.search).get("m") || "spec";
const input = document.getElementById("key");
const status = document.getElementById("status");
let pending = "";
// VD: count trusted vs untrusted input events (Marionette typing must produce trusted events).
const vdEvents = { trusted: 0, untrusted: 0, paste: 0 };
input.addEventListener("input", e => { vdEvents[e.isTrusted ? "trusted" : "untrusted"]++; });
input.addEventListener("paste", () => { vdEvents.paste++; });

async function save() {
  const value = input.value || pending;
  input.value = "";
  pending = "";
  if (!value) return;
  await browser.storage.local.set({ apiKey: value });
  status.textContent = `Key saved (…${value.slice(-4)})`;
}

document.getElementById("save").addEventListener("click", save);
if (mode === "change") {
  input.addEventListener("change", () => {
    pending = input.value;
    input.value = "";
    status.textContent = pending ? "Key ready, click Save" : "";
  });
}
if (mode === "mousedown") {
  document.getElementById("save").addEventListener("mousedown", e => e.preventDefault());
}
document.getElementById("rm").addEventListener("click", () => input.remove());

window.keyPage = {
  mode,
  state() {
    return JSON.stringify({
      vdEvents, mode, value: input.value, valueLength: input.value.length, inDom: input.isConnected,
      visibility: document.visibilityState, focused: document.activeElement?.id || null,
      status: status.textContent, textSecurity: CSS.supports("-webkit-text-security", "disc"),
      htmlHasKey: document.documentElement.outerHTML.includes("sk-ant-"),
      type: input.type, hasBeenTypePasswordGuess: input.type === "password",
      computedTextSecurity: getComputedStyle(input).getPropertyValue("-webkit-text-security"),
    });
  },
};
