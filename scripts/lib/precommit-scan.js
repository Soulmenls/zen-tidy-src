// The pre-commit check's rules (SPEC §5; notes/m7-contracts.md, "Pre-commit check"): pure functions over a staged
// path and its bytes, so they are tested without git. scripts/precommit-check.mjs feeds them the index.
//
// A finding names the file, the line when there is one, and the rule. Of the text that matched, only its first 8
// characters ever leave this module (`starts`), so a refusal never prints the secret it found; a key-shaped path is
// shortened the same way when it is printed.

import { hasMozLz4Magic } from "./mozlz4.js";

// An Anthropic key: the prefix and at least 20 characters of the key alphabet (real keys have about 100).
export const KEY_SHAPED_RE = /sk-ant-[A-Za-z0-9_-]{20,}/g;
// A fake key in a tracked file passes only with one of these as a whole segment of the token (between "-" or "_"),
// as the spike's VD key has `VDfake`. Case counts: a random real key holds a 6-character segment like "-TEST-" about
// once in a billion.
export const FAKE_KEY_MARKERS = Object.freeze(["VDfake", "TEST", "EXAMPLE"]);
// An AMO JWT secret is 64 hex characters; the JWT issuer is user:<digits>:<digits>. A bare 64-hex run is just as often
// a SHA-256 (SHA256SUMS, update_hash), so it counts as a secret only on a line that names one, or with an issuer on
// its own line or the line before or after.
const HEX64_RE = /(?<![0-9A-Fa-f])[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/;
const SECRET_NAME_RE = /jwt|secret/i;
const ISSUER_RE = /\buser:\d+:\d+\b/;
// export-tabs.mjs writes { version, source: "<session file>.jsonlz4", exportedAt, space, tabs } (its header); the
// first two names are looked for near the top, in any order and spacing.
const EXPORT_HEAD_CHARS = 1024;
const EXPORT_SOURCE_RE = /"source"\s*:\s*"[^"\r\n]*\.jsonlz4"/;
const EXPORT_STAMP_RE = /"exportedAt"\s*:/;
// Session store files by name: zen-sessions.jsonlz4, recovery.baklz4, upgrade.jsonlz4-<build id>, *.mozlz4.
const SESSION_NAME_RE = /\.[a-z]*lz4(?:-[^/]*)?$/i;
const SHOWN_CHARS = 8;

export const RULES = Object.freeze({
  key: "an Anthropic key-shaped string",
  "amo-secret": "an AMO JWT secret",
  "amo-issuer": "an AMO JWT issuer next to a secret",
  "secret-file": "a file name kept for secrets or real tab data",
  "local-only": "a local-only path (test/, notes/, SPEC.md and .omc/ never leave this PC)",
  "tab-export": "an export of real tabs (export-tabs.mjs)",
  "session-file": "a Zen session file",
});

const shown = (text) => text.slice(0, SHOWN_CHARS);

export function isFakeKey(token) {
  return token.slice("sk-ant-".length).split(/[-_]/).some((segment) => FAKE_KEY_MARKERS.includes(segment));
}

// The first key-shaped string in `text` that is not a marked fake, or null.
export function realKeyIn(text) {
  for (const [token] of text.matchAll(KEY_SHAPED_RE)) if (!isFakeKey(token)) return token;
  return null;
}

// The bytes as text for the line rules, without a byte order mark. Every pattern is ASCII, so latin1 keeps lines and
// never fails on binary or UTF-8 bytes; a file with a UTF-16 byte order mark (Windows PowerShell 5.1's `>` writes
// one) is decoded as such. UTF-16 without one stays Latin-1 here; scanContent reads it once more without its NULs.
export function textOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, bytes.byteLength - start).toString("latin1");
}

const finding = (path, rule, line = null, starts = null) => ({ path, rule, line, starts });

// Rules on the path alone, as git names it (forward slashes, relative to the top of the repo). Names compare without
// case, as Windows does.
export function scanPath(path) {
  const findings = [];
  const segments = path.split("/");
  const lower = segments.map((segment) => segment.toLowerCase());
  const base = lower.at(-1);
  const inDir = (dir) => lower.length > 1 && lower[0] === dir;
  if (inDir("test") || inDir("notes") || path.toLowerCase() === "spec.md" || lower.slice(0, -1).includes(".omc")) {
    findings.push(finding(path, "local-only"));
  }
  const realFixture = lower.some((segment, i) => segment === "fixtures" && lower[i + 1]?.startsWith("real-"));
  const secretName = base.endsWith(".env") || base.startsWith(".env") || base === "amo-credentials.xml"
    || base.endsWith(".pfx") || base.endsWith(".p12");
  if (realFixture || secretName) findings.push(finding(path, "secret-file"));
  if (SESSION_NAME_RE.test(base)) findings.push(finding(path, "session-file"));
  const key = realKeyIn(path);
  if (key) findings.push(finding(path, "key", null, shown(key)));
  return findings;
}

// Rules on the staged content. The text rules read it as textOf decodes it and, when the bytes hold any NUL, once more
// as Latin-1 without the NULs (M7-SEC-5): UTF-16 without a byte order mark (Python's "utf-16-le", .NET's
// UnicodeEncoding without one) puts a NUL beside every ASCII character, which textOf can't tell from binary. A finding
// both readings make (UTF-16 with a byte order mark) is reported once.
export function scanContent(path, bytes) {
  const findings = [];
  if (hasMozLz4Magic(bytes)) findings.push(finding(path, "session-file"));
  const text = textOf(bytes);
  const latin1 = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const stripped = latin1.includes("\0") ? latin1.replaceAll("\0", "") : text;
  const seen = new Set();
  for (const reading of stripped === text ? [text] : [text, stripped]) {
    for (const found of textFindings(path, reading)) {
      const key = `${found.rule} ${found.line}`;
      if (!seen.has(key)) findings.push(found);
      seen.add(key);
    }
  }
  return findings;
}

// The export header and the line rules over one reading of a file's text.
function textFindings(path, text) {
  const findings = [];
  const head = text.slice(0, EXPORT_HEAD_CHARS);
  if (/^\s*\{/.test(head) && EXPORT_SOURCE_RE.test(head) && EXPORT_STAMP_RE.test(head)) {
    findings.push(finding(path, "tab-export", 1));
  }

  const lines = text.split("\n");
  const hex = new Map();
  const issuers = new Map();
  lines.forEach((line, i) => {
    const key = realKeyIn(line);
    if (key) findings.push(finding(path, "key", i + 1, shown(key)));
    const run = HEX64_RE.exec(line);
    if (run) hex.set(i, run[0]);
    const issuer = ISSUER_RE.exec(line);
    if (issuer) issuers.set(i, issuer[0]);
  });
  const near = (map, i) => map.has(i - 1) || map.has(i) || map.has(i + 1);
  for (const [i, run] of hex) {
    if (SECRET_NAME_RE.test(lines[i]) || near(issuers, i)) findings.push(finding(path, "amo-secret", i + 1, shown(run)));
  }
  for (const [i, issuer] of issuers) {
    if (near(hex, i)) findings.push(finding(path, "amo-issuer", i + 1, shown(issuer)));
  }
  return findings;
}

// files: [{ path, bytes }] -> every finding, file by file in the order given, each file's lines in order.
export function scanStaged(files) {
  return files.flatMap(({ path, bytes }) =>
    [...scanPath(path), ...scanContent(path, bytes)].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)));
}

// A path for printing: a key-shaped part is cut to its first 8 characters.
export function displayPath(path) {
  return path.replace(KEY_SHAPED_RE, (token) => (isFakeKey(token) ? token : `${shown(token)}...`));
}

// "<path>:<line>: <rule> (starts "<8 characters>")", the line and the start only when there is one.
export function formatFinding({ path, rule, line, starts }) {
  const where = line === null ? displayPath(path) : `${displayPath(path)}:${line}`;
  const start = starts === null ? "" : ` (starts "${starts}")`;
  return `${where}: ${RULES[rule]}${start}`;
}
