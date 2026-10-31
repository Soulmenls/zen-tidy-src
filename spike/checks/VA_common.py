"""Group A shared helpers: chrome-scope DOM inspection of tab groups (throwaway spike code)."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "harness"))
from zen import SPIKE, ZenSession, build_xpi, make_profile, save_result  # noqa: E402,F401

ADDON = "zen-tidy-spike@local"


def cps(s):
    return [f"U+{ord(c):04X}" for c in s] if isinstance(s, str) else s


# Inspects every tab group in the window plus the active Space's loose-area order.
INSPECT_JS = r"""
const done = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("navigator:browser");
const doc = win.document;
const gB = win.gBrowser;
const hex = s => s == null ? null : [...s].map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0"));
const tabUrl = t => {
  try { return t.linkedBrowser.currentURI.spec; } catch (e) { return null; }
};
const where = el => {
  if (el.closest(".zen-workspace-pinned-tabs-section")) return "pinned-section";
  if (el.closest(".zen-workspace-normal-tabs-section")) return "normal-section";
  if (el.closest("#zen-essentials, .zen-essentials-container")) return "essentials";
  return "other:" + (el.parentElement?.id || el.parentElement?.className || el.parentElement?.tagName);
};
const describe = el => {
  if (!el) return null;
  if (gB.isTab(el)) return {kind: "tab", label: el.label, url: tabUrl(el), pinned: el.pinned,
    selected: el.selected, empty: el.hasAttribute("zen-empty-tab"), tPos: el._tPos};
  if (gB.isTabGroup(el)) return {kind: "group", tag: el.tagName, id: el.id, label: el.getAttribute("label")};
  return {kind: "other", tag: el.tagName, cls: el.className};
};
const groups = gB.tabGroups.map(g => {
  const labelEl = g.querySelector(":scope > .tab-group-label-container > .tab-group-label");
  const container = g.querySelector(":scope > .tab-group-container");
  let textWidth = null;
  if (labelEl) {
    const r = doc.createRange(); r.selectNodeContents(labelEl);
    textWidth = r.getBoundingClientRect().width;
  }
  const tabs = g.tabs.map(t => {
    const cs = win.getComputedStyle(t);
    const rect = t.getBoundingClientRect();
    return {label: t.label, url: tabUrl(t), pinned: t.pinned, selected: t.selected,
      empty: t.hasAttribute("zen-empty-tab"), display: cs.display, visibility: cs.visibility,
      height: rect.height, width: rect.width};
  });
  return {
    id: g.id, tag: g.tagName, label: g.getAttribute("label"), labelHex: hex(g.getAttribute("label")),
    labelText: labelEl?.textContent ?? null, labelTextHex: hex(labelEl?.textContent),
    labelValue: labelEl?.getAttribute("value") ?? null, labelTextWidth: textWidth,
    labelBoxWidth: labelEl ? labelEl.getBoundingClientRect().width : null,
    collapsedAttr: g.hasAttribute("collapsed"), collapsedProp: g.collapsed,
    pinnedProp: g.pinned ?? null, pinnedAttr: g.hasAttribute("pinned"),
    splitView: g.hasAttribute("split-view-group"), isZenFolder: !!g.isZenFolder,
    workspaceAttr: g.getAttribute("zen-workspace-id"),
    where: where(g), workspaceEl: g.closest("zen-workspace")?.id ?? null,
    parentTag: g.parentElement?.tagName, parentClass: g.parentElement?.className,
    groupDisplay: win.getComputedStyle(g).display,
    containerDisplay: container ? win.getComputedStyle(container).display : null,
    tabs,
  };
});
const ws = win.gZenWorkspaces.activeWorkspaceElement;
const normal = ws?.querySelector(".zen-workspace-normal-tabs-section");
const pinnedSec = ws?.querySelector(".zen-workspace-pinned-tabs-section");
const kids = el => el ? [...el.children].filter(c => gB.isTab(c) || gB.isTabGroup(c)).map(describe) : null;
done({
  activeWorkspace: win.gZenWorkspaces.activeWorkspace,
  workspaceIds: win.gZenWorkspaces.getWorkspaces?.()?.map?.(w => w.uuid) ?? null,
  normalOrder: kids(normal),
  pinnedOrder: kids(pinnedSec),
  allTabs: gB.tabs.map(describe),
  groups,
});
"""


def inspect(z):
    return z.chrome(INSPECT_JS)


def dom_to_api_id(dom_id):
    """Firefox: internal id "<ms>-<0..100>" -> extension id ms*1000 + suffix (ext-browser.js)."""
    s = str(dom_id)
    if "-" in s:
        a, b = s.split("-", 1)
        if a.isdigit() and b.isdigit():
            return int(a) * 1000 + int(b)
    return s


def group_dom(insp, gid):
    for g in insp["groups"]:
        if str(g["id"]) == str(gid) or dom_to_api_id(g["id"]) == gid:
            return g
    return None


def screenshot(z, css_selector, out_png):
    """Chrome-context element screenshot via WebDriver:TakeScreenshot."""
    import base64
    z.m.send("Marionette:SetContext", {"value": "chrome"})
    el = z.m.send("WebDriver:FindElement", {"using": "css selector", "value": css_selector})
    el = el.get("value", el)
    r = z.m.send("WebDriver:TakeScreenshot", {"id": list(el.values())[0], "full": False, "hash": False})
    data = r.get("value", r) if isinstance(r, dict) else r
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    with open(out_png, "wb") as f:
        f.write(base64.b64decode(data))
    return out_png


def api(z, h, path, *args):
    return z.ext(h, "api", [path, list(args)])


def val(r):
    if isinstance(r, dict) and "value" in r:
        return r["value"]
    raise RuntimeError(f"api error: {r}")


def create_tabs(z, h, prefix, n, start=0):
    ids = []
    for i in range(start, start + n):
        r = api(z, h, "tabs.create", {"url": f"https://example.com/{prefix}/{i}", "title": f"{prefix}-{i}",
                                      "discarded": True, "active": False})
        ids.append(val(r)["id"])
    return ids


def loose_summary(z, h):
    tabs = val(api(z, h, "tabs.query", {"currentWindow": True}))
    return [(t["id"], t["index"], t["groupId"], t["pinned"], t["title"]) for t in tabs]


def log_entries(z, h, key="spikeLog"):
    return val(api(z, h, "storage.local.get", key)).get(key, [])


# ---- Zen Tidy name codes (chosen from check 2 phase 1 / 1b results) ----
SIG = [0x2063, 0x2062]                        # never starts with U+200B
ICON_ALPHABET = [0x2060, 0x2061, 0x2064, 0x200B, 0x180E]   # digits 0..4
ICON_DIR = "chrome://browser/skin/zen-icons/selectable/"


def sig_str():
    return "".join(chr(c) for c in SIG)


def icon_str(code):
    """code: 3-digit string/tuple of base-5 digits, e.g. "012"."""
    return "".join(chr(ICON_ALPHABET[int(d)]) for d in code)


def css_esc(s):
    # 6-digit CSS escapes need no terminator
    return "".join("\\" + format(ord(c), "06X") for c in s)


def build_css(icon_codes, collapse_fix=True, default_icon="folder"):
    """icon_codes: {"000": "folder", ...}. Returns userChrome.css text."""
    sig = css_esc(sig_str())
    lines = [
        "/* Zen Tidy spike (group A): SIG + 3-char ICON code + visible name */",
        f'tab-group[label^="{sig}"] > .tab-group-label-container {{',
        "  flex-direction: row !important;",
        "  align-items: center;",
        "}",
        f'tab-group[label^="{sig}"] > .tab-group-label-container::before {{',
        '  content: "";',
        "  display: block;",
        "  flex: 0 0 16px;",
        "  width: 16px;",
        "  height: 16px;",
        "  margin-inline-end: 6px;",
        f"  background: url({ICON_DIR}{default_icon}.svg) center / 16px 16px no-repeat;",
        "  -moz-context-properties: fill, fill-opacity;",
        "  fill: currentColor;",
        "  fill-opacity: 1;",
        "}",
    ]
    for code, name in icon_codes.items():
        lines.append(f'tab-group[label^="{sig}{css_esc(icon_str(code))}"] > .tab-group-label-container::before '
                     f"{{ background-image: url({ICON_DIR}{name}.svg); }}")
    if collapse_fix:
        lines += [
            "/* collapse fix: Firefox's rule targets direct children, Zen wraps tabs in .tab-group-container */",
            f'tab-group[label^="{sig}"][collapsed] > .tab-group-container > .tabbrowser-tab:not([selected],[multiselected]) {{',
            "  display: none;",
            "}",
        ]
    return "\n".join(lines) + "\n"


# Probe ::before computed style, layout offset of the label and ink pixels left of the label.
ICON_PROBE_JS = r"""
const done = arguments[arguments.length - 1];
(async () => {
const win = Services.wm.getMostRecentWindow("navigator:browser");
const doc = win.document;
const frame = () => new Promise(r => win.requestAnimationFrame(() => win.setTimeout(r, 30)));
const res = [];
for (const g of win.gBrowser.tabGroups) {
  const lc = g.querySelector(":scope > .tab-group-label-container");
  const lab = lc?.querySelector(":scope > .tab-group-label");
  if (!lc || !lab) continue;
  lc.scrollIntoView({block: "center"});
  await frame(); await frame();
  const cs = win.getComputedStyle(lc, "::before");
  const lcr = lc.getBoundingClientRect(), lr = lab.getBoundingClientRect();
  // icon box sits 6px (margin) + 16px left of the label, vertically centred on the container
  const x = Math.round(lr.left - 22), y = Math.round(lcr.top + lcr.height / 2 - 8), w = 16, hgt = 16;
  let ink = null, hash = null, avg = null, inView = lcr.top >= 0 && lcr.bottom <= win.innerHeight;
  try {
    const canvas = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = w; canvas.height = hgt;
    const ctx = canvas.getContext("2d");
    ctx.drawWindow(win, x, y, w, hgt, "rgb(255,0,255)");
    const d = ctx.getImageData(0, 0, w, hgt).data;
    // background = colour just left of the icon box
    const c2 = doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas"); c2.width = 1; c2.height = 1;
    const ctx2 = c2.getContext("2d"); ctx2.drawWindow(win, x - 3, y + 8, 1, 1, "rgb(255,0,255)");
    const b = ctx2.getImageData(0, 0, 1, 1).data;
    ink = 0; let hh = 0, sr = 0, sg = 0, sb = 0;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      if (Math.abs(d[i] - b[0]) + Math.abs(d[i + 1] - b[1]) + Math.abs(d[i + 2] - b[2]) > 60) {
        ink++; hh = (hh * 31 + p) >>> 0; sr += d[i]; sg += d[i + 1]; sb += d[i + 2];
      }
    }
    hash = hh; avg = ink ? [Math.round(sr / ink), Math.round(sg / ink), Math.round(sb / ink)] : null;
    var bgColor = [b[0], b[1], b[2]];
  } catch (e) { ink = "error: " + e; }
  res.push({
    id: g.id, label: g.getAttribute("label"),
    labelHex: [...g.getAttribute("label")].map(c => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")),
    before: {content: cs.content, display: cs.display, width: cs.width, height: cs.height,
             backgroundImage: cs.backgroundImage, ctxProps: cs.getPropertyValue("-moz-context-properties") || cs.MozContextProperties || "",
             fill: cs.fill, marginInlineEnd: cs.marginInlineEnd},
    labelOffsetX: lr.left - lcr.left,
    labelTextWidth: (() => { const r = doc.createRange(); r.selectNodeContents(lab); return r.getBoundingClientRect().width; })(),
    labelColor: win.getComputedStyle(lab).color, containerColor: win.getComputedStyle(lc).color,
    containerFlexDirection: win.getComputedStyle(lc).flexDirection,
    region: [x, y, w, hgt], inView, ink, inkHash: hash, inkAvgRGB: avg, bgRGB: typeof bgColor === "undefined" ? null : bgColor,
  });
}
done(res);
})();
"""


# Chrome-side tracer of tab-group DOM events (inspection only).
TRACER_JS = r"""
const done = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("navigator:browser");
if (!win.__aTrace) {
  win.__aTrace = [];
  const t0 = Date.now();
  const types = ["TabGroupRemoved", "TabGroupRemovedFromDOM", "TabGroupCreate", "TabGroupMoved", "TabGroupCollapse",
                 "TabGroupExpand", "TabGroupUpdate", "TabGrouped", "TabUngrouped", "TabMove", "FolderGrouped",
                 "FolderUngrouped", "TabSelect"];
  for (const type of types) {
    win.addEventListener(type, e => {
      const tgt = e.originalTarget || e.target;
      const g = win.gBrowser.isTabGroup(tgt) ? tgt : (type.startsWith("Tab") && tgt?.group) || null;
      const real = g ? win.gBrowser.getTabGroupById?.(g.id) : null;
      win.__aTrace.push({
        t: Date.now(), type, tag: tgt?.tagName, groupId: g?.id ?? null, label: g?.getAttribute?.("label") ?? null,
        collapsed: g ? g.hasAttribute("collapsed") : null,
        sameAsReal: g ? real === g : null, connected: tgt?.isConnected, groupTabs: g ? g.tabs.length : null,
        tabLabel: win.gBrowser.isTab(tgt) ? tgt.label : null,
        detailTabLabel: e.detail && win.gBrowser.isTab(e.detail) ? e.detail.label : null,
        stack: type === "TabGroupRemoved" || type === "TabGroupExpand" ? new Error().stack.split("\n").slice(0, 12).join(" | ") : null,
      });
    }, true);
  }
}
done(true);
"""

TRACE_READ_JS = r"""
const done = arguments[arguments.length - 1];
const win = Services.wm.getMostRecentWindow("navigator:browser");
done(win.__aTrace || null);
"""
