// Release constants (m7-contracts, "Constants"). The product id and the update URL never change after v0.1.0:
// Zen ties the add-on's data to the id, and every installed copy polls this exact URL.

export const RELEASE_REPO = "Soulmenls/zen-tidy";
export const PRODUCT_ID = "zen-tidy@soulaymane";
export const UPDATE_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/updates.json`;
export const CHANNEL = "unlisted";
// The one dependency of tools/web-ext/, pinned there and in its lockfile (release-pin.js), and sign.ps1's -WebExtVersion.
export const WEB_EXT_VERSION = "10.7.0";
export const API_BASE = "https://api.anthropic.com";

export const PERMISSIONS = ["tabs", "tabGroups", "sessions", "storage"];
export const HOST_PERMISSIONS = ["https://api.anthropic.com/*"];
// implementation-notes, "Manifest".
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; "
  + "connect-src https://api.anthropic.com; object-src 'none'; base-uri 'none'; form-action 'none'; upgrade-insecure-requests";

// Keys that would open the extension to web pages or widen what it may reach. web-ext lint flags none of
// them (M0), so the preflight does.
export const FORBIDDEN_KEYS = [
  "web_accessible_resources", "externally_connectable", "content_scripts", "user_scripts", "devtools_page",
  "optional_permissions", "optional_host_permissions",
];

// Signed-xpi signature files (Mozilla's PKCS#7 and COSE signatures).
export const SIGNATURE_FILES = ["cose.manifest", "cose.sig", "manifest.mf", "mozilla.sf", "mozilla.rsa"].map((name) => `META-INF/${name}`);

// Files web-ext sign writes into its --source-dir (the staged folder): .amo-upload-uuid lets a re-run resume an
// upload instead of making a second one, so re-staging keeps them. web-ext's own package leaves dotfiles out.
export const WEB_EXT_SIDECARS = [".amo-upload-uuid", ".web-extension-id"];

export const tagName = (version) => `v${version}`;
export const xpiName = (version) => `zen-tidy-${version}.xpi`;
export const unsignedName = (version) => `zen-tidy-${version}-unsigned.zip`;
export const cssKitName = (version) => `zen-tidy-css-${version}.zip`;
export const localTestName = (version) => `zen-tidy-${version}-local.xpi`;
export const UPDATES_NAME = "updates.json";
export const SUMS_NAME = "SHA256SUMS";
export const NOTES_NAME = "RELEASE-NOTES.md";
// The --notes text of the last build, kept so `sign` (which builds again) doesn't lose it. Not an asset.
export const CHANGES_NAME = "changes.md";

// What a release takes from the commit (HEAD): the package's folder and the CSS kit's two files, as git names them.
export const CSS_PATH = "css/zen-tidy.css";
export const SETUP_PATH = "scripts/setup-css.ps1";
export const RELEASE_PATHS = ["extension", CSS_PATH, SETUP_PATH];

export const assetUrl = (version) => `https://github.com/${RELEASE_REPO}/releases/download/${tagName(version)}/${xpiName(version)}`;

// Key-shaped: sk-ant- and at least 20 key characters (m7-contracts, "Pre-commit check").
export const KEY_SHAPED_RE = /sk-ant-[A-Za-z0-9_-]{20,}/;

// x.y.z, digits only, no leading zeros, no pre-release suffix.
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function parseVersion(value) {
  const match = typeof value === "string" ? VERSION_RE.exec(value) : null;
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  if (!x || !y) throw new Error(`not a release version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function highestVersion(versions) {
  return versions.reduce((best, version) => (best === null || compareVersions(version, best) > 0 ? version : best), null);
}
