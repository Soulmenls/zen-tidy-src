// Preflight rules (m7-contracts, "Preflight"): pure checks on what git, the manifests, config.js and web-ext lint
// report. Each returns a list of problems; an empty list passes. release.mjs runs them in order and stops at the
// first rule that fails, naming it.

import {
  API_BASE, CSP, FORBIDDEN_KEYS, HOST_PERMISSIONS, PERMISSIONS, PRODUCT_ID, RELEASE_PATHS, UPDATE_URL,
  compareVersions, highestVersion, parseVersion, tagName,
} from "./release-config.js";
import { findRelease, ledgerFloor } from "./release-ledger.js";
import { INSTALL_COMMAND } from "./release-pin.js";
import { childLine } from "./release-publish.js";

export class PreflightError extends Error {
  constructor(rule, problems) {
    super(`preflight failed (${rule}): ${problems.join("; ")}`);
    this.rule = rule;
    this.problems = problems;
  }
}

export function requirePass(rule, problems) {
  if (problems.length) throw new PreflightError(rule, problems);
}

// The injected git runner, (args, { cwd, input?, binary? }) -> { status, stdout, stderr, error }, as one call that
// resolves to stdout, or null for a miss (exit 1) when that is allowed, and throws for anything else.
function gitCall(git, root) {
  return async (args, { quietMiss = false, input, binary = false } = {}) => {
    const result = await git(args, { cwd: root, ...(input === undefined ? {} : { input }), ...(binary ? { binary } : {}) });
    if (result.status === 0) return result.stdout ?? (binary ? Buffer.alloc(0) : "");
    if (quietMiss && result.status === 1) return null;
    throw new Error(`git ${args[0]} failed${result.error ? ` (${result.error.code ?? result.error.message})` : ` (exit ${result.status})`}`);
  };
}

// `git ls-files -v` tags: lowercase is assume-unchanged, S is skip-worktree. git status says nothing about a change to
// such a file, so the clean tree rule 1 asks for would not be the tree that is there.
const HIDDEN_TAG_RE = /^[a-zS]$/;

// What git says about the source tree: status lines, HEAD, local v* tags, the commit `v<version>` names (if any)
// and the release's paths whose changes git status would not show (`hidden`).
export async function gitFacts(git, root, version) {
  const run = gitCall(git, root);
  const status = (await run(["status", "--porcelain"])).split(/\r?\n/).filter(Boolean);
  const head = (await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { quietMiss: true }))?.trim() || null;
  const tags = (await run(["tag", "--list", "v*"])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tagCommit = (await run(["rev-parse", "--verify", "--quiet", `refs/tags/${tagName(version)}^{commit}`], { quietMiss: true }))?.trim() || null;
  const hidden = (await run(["ls-files", "-v", "-z", "--", ...RELEASE_PATHS])).split("\0").filter(Boolean)
    .filter((entry) => HIDDEN_TAG_RE.test(entry[0]) && entry[1] === " ").map((entry) => entry.slice(2));
  return { status, head, tags, tagCommit, hidden };
}

// The release's files as HEAD's commit holds them (M7-REL-1): Map(path -> { mode, type, data }), data a Buffer for each
// blob and null for anything else (a submodule). A release ships these bytes, not the working tree's: with core.autocrlf
// on, git rewrites a file's line endings whenever it checks it out while git status still calls the tree clean, so the
// working tree's bytes are not the commit's. `commit` is gitFacts' HEAD, by id, so a commit made meanwhile can't put
// other bytes under the commit the ledger records. One `ls-tree` lists them, one `cat-file --batch` reads every blob.
export async function headFiles(git, root, commit, paths = RELEASE_PATHS) {
  const run = gitCall(git, root);
  const entries = (await run(["ls-tree", "-r", "-z", commit, "--", ...paths])).split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    return { path: record.slice(tab + 1), mode, type, oid };
  });
  const oids = [...new Set(entries.filter((entry) => entry.type === "blob").map((entry) => entry.oid))];
  const blobs = new Map();
  if (oids.length) {
    const out = await run(["cat-file", "--batch"], { input: `${oids.join("\n")}\n`, binary: true });
    let at = 0;
    for (const oid of oids) {
      const end = out.indexOf(0x0a, at);
      const [named, type, size] = (end < 0 ? "" : out.subarray(at, end).toString("latin1")).split(" ");
      if (named !== oid || type !== "blob" || !/^\d+$/.test(size ?? "") || end + 1 + Number(size) > out.length) {
        throw new Error(`git cat-file gave no blob for ${entries.find((entry) => entry.oid === oid).path}`);
      }
      blobs.set(oid, out.subarray(end + 1, end + 1 + Number(size)));
      at = end + 1 + Number(size) + 1;
    }
  }
  return new Map(entries.map(({ path, mode, type, oid }) => [path, { mode, type, data: blobs.get(oid) ?? null }]));
}

// Rule 1: a clean tree that git status can vouch for, HEAD a commit, no v<version> tag elsewhere, not published
// already.
export function gitProblems({ status, head, tagCommit, hidden = [] }, { version, ledger }) {
  const problems = [];
  if (status.length) {
    const paths = status.slice(0, 3).map((line) => line.slice(3)).join(", ");
    problems.push(`the tree is not clean: ${status.length} changed or untracked path(s) (${paths}${status.length > 3 ? ", ..." : ""}); commit or remove them`);
  }
  if (hidden.length) {
    const paths = hidden.slice(0, 3).join(" ");
    problems.push(`git status does not show changes to ${hidden.length} path(s), marked assume-unchanged or skip-worktree (${hidden.slice(0, 3).join(", ")}`
      + `${hidden.length > 3 ? ", ..." : ""}); run: git update-index --no-assume-unchanged --no-skip-worktree ${paths}${hidden.length > 3 ? " ..." : ""}`);
  }
  if (!head) problems.push("HEAD is not a commit");
  if (tagCommit && tagCommit !== head) problems.push(`local tag ${tagName(version)} already points at another commit (${tagCommit.slice(0, 12)})`);
  if (findRelease(ledger, version)?.state === "published") problems.push(`${version} is already published (ledger)`);
  return problems;
}

// Rule 2: manifest == package.json, a release version, above every other version in the ledger and every other
// v* tag.
export function versionProblems({ manifestVersion, packageVersion, ledger, tags }) {
  const problems = [];
  if (!parseVersion(manifestVersion)) return [`manifest version ${JSON.stringify(manifestVersion)} is not MAJOR.MINOR.PATCH (digits only)`];
  if (packageVersion !== manifestVersion) problems.push(`package.json version ${JSON.stringify(packageVersion)} differs from the manifest's ${manifestVersion} (run: node scripts/release.mjs bump ${manifestVersion})`);
  const floor = ledgerFloor(ledger, manifestVersion);
  if (floor && compareVersions(manifestVersion, floor.version) <= 0) {
    problems.push(`${manifestVersion} is not above ${floor.version}, the highest version in the ledger (${floor.state}; AMO never takes a version twice)`);
  }
  // v<version> itself is rule 1's: allowed only on HEAD.
  const tagVersions = tags.filter((tag) => tag.startsWith("v")).map((tag) => tag.slice(1))
    .filter((version) => parseVersion(version) && version !== manifestVersion);
  const highestTag = highestVersion(tagVersions);
  if (highestTag && compareVersions(manifestVersion, highestTag) <= 0) problems.push(`${manifestVersion} is not above local tag v${highestTag}`);
  return problems;
}

// extension/ holds exactly HEAD's files (`tracked`, as git names them): a file git ignores would be in local-test's
// build and the working tree's checks, but not in the release, which ships HEAD's.
export function trackedProblems(stagedNames, tracked) {
  const inGit = new Set(tracked.filter((name) => name.startsWith("extension/")).map((name) => name.slice("extension/".length)));
  const untracked = stagedNames.filter((name) => !inGit.has(name));
  const missing = [...inGit].filter((name) => !stagedNames.includes(name));
  const problems = [];
  if (untracked.length) problems.push(`not tracked by git: ${untracked.slice(0, 5).map((name) => `extension/${name}`).join(", ")}`);
  if (missing.length) problems.push(`tracked but missing from extension/: ${missing.slice(0, 5).map((name) => `extension/${name}`).join(", ")}`);
  return problems;
}

function sameMembers(value, expected) {
  return Array.isArray(value) && value.length === expected.length && new Set(value).size === value.length
    && expected.every((item) => value.includes(item));
}

function* stringsIn(value, at = "") {
  if (typeof value === "string") yield [at, value];
  else if (Array.isArray(value)) for (const [i, item] of value.entries()) yield* stringsIn(item, `${at}[${i}]`);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) yield* stringsIn(item, at ? `${at}.${key}` : key);
}

const REMOTE_PAGE_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

// Rule 3: the product manifest as staged.
export function manifestProblems(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest.json is not an object"];
  const problems = [];
  const gecko = manifest.browser_specific_settings?.gecko ?? {};
  if (gecko.id !== PRODUCT_ID) problems.push(`gecko id is not ${PRODUCT_ID}`);
  if (gecko.update_url !== UPDATE_URL) problems.push(`gecko update_url is not ${UPDATE_URL}`);
  if (typeof gecko.strict_min_version !== "string" || !gecko.strict_min_version) problems.push("gecko strict_min_version is missing");
  if (!gecko.data_collection_permissions || typeof gecko.data_collection_permissions !== "object") problems.push("gecko data_collection_permissions is missing");
  if (!sameMembers(manifest.permissions, PERMISSIONS)) problems.push(`permissions are not exactly ${PERMISSIONS.join(", ")}`);
  if (!sameMembers(manifest.host_permissions, HOST_PERMISSIONS)) problems.push(`host_permissions are not exactly ${HOST_PERMISSIONS.join(", ")}`);
  if (manifest.incognito !== "not_allowed") problems.push('incognito is not "not_allowed"');
  const csp = manifest.content_security_policy;
  if (!csp || typeof csp !== "object" || Object.keys(csp).join() !== "extension_pages" || csp.extension_pages !== CSP) {
    problems.push("content_security_policy is not exactly the production policy (implementation-notes, Manifest)");
  }
  for (const key of FORBIDDEN_KEYS) if (Object.hasOwn(manifest, key)) problems.push(`declares ${key}`);
  const panel = manifest.sidebar_action?.default_panel;
  if (typeof panel === "string" && REMOTE_PAGE_RE.test(panel.trim())) problems.push("sidebar_action has a remote page");
  for (const [at, text] of stringsIn(manifest)) {
    if (/http:\/\//i.test(text)) problems.push(`${at} names an http:// host`);
    if (text.includes("<all_urls>")) problems.push(`${at} names <all_urls>`);
    if (text.includes("*://")) problems.push(`${at} names a *:// pattern`);
  }
  return problems;
}

const API_BASE_LINE_RE = /^export const API_BASE = "([^"\r\n]*)";\r?$/gm;

// Rule 4: shared/config.js points at Anthropic, through its one API_BASE line.
export function configProblems(source) {
  const lines = [...source.matchAll(API_BASE_LINE_RE)];
  const assignments = source.match(/\bAPI_BASE\s*=(?!=)/g) ?? [];
  if (lines.length !== 1 || assignments.length !== 1) return ['shared/config.js must set API_BASE exactly once, as `export const API_BASE = "...";`'];
  return lines[0][1] === API_BASE ? [] : [`API_BASE is ${JSON.stringify(lines[0][1])}, not "${API_BASE}"`];
}

const PERMISSION_OR_CSP_CODE_RE = /PERMISSION|CSP/i;
const PERMISSION_OR_CSP_TEXT_RE = /permission|content.security.policy|\bCSP\b/i;

// The line of a child's stderr that says what went wrong: node prints the failing source line and a caret before an
// uncaught error's own "Error: ..." line (Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yargs' ...).
function errorLine(stderr) {
  return childLine(String(stderr ?? "").split(/\r?\n/).find((line) => /^\s*\w*Error\b/.test(line)) ?? stderr);
}

// Rule 7: web-ext lint --output json. Errors fail; warnings are listed and fail only when their code or message
// is about permissions or the CSP (a description can mention a permission key in passing, so it is not read). With
// no report, the exit code, the reason node could not start and the error it printed, and the install to run again:
// the pin rules read npm's record and each package's package.json, not every file node loads.
export function lintReport({ status, stdout = "", stderr = "", error = null }) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  let report = null;
  try {
    report = start >= 0 && end > start ? JSON.parse(stdout.slice(start, end + 1)) : null;
  } catch {
    report = null;
  }
  if (!report || !Array.isArray(report.errors) || !Array.isArray(report.warnings)) {
    const exit = status === null || status === undefined ? "no exit code" : `exit ${status}`;
    const cause = error ? `, ${error.code ?? childLine(error.message)}` : "";
    const said = errorLine(stderr);
    return { problems: [`web-ext lint gave no readable report (${exit}${cause}${said ? `: ${said}` : ""}): run ${INSTALL_COMMAND}`], warnings: [] };
  }
  const describe = (item) => `${item.code ?? "?"}${item.file ? ` (${item.file})` : ""}`;
  const warnings = report.warnings.map((item) => ({ ...item, fatal: PERMISSION_OR_CSP_CODE_RE.test(item.code ?? "") || PERMISSION_OR_CSP_TEXT_RE.test(item.message ?? "") }));
  const problems = [];
  if (report.errors.length) problems.push(`${report.errors.length} error(s): ${report.errors.map(describe).join(", ")}`);
  const fatal = warnings.filter((item) => item.fatal);
  if (fatal.length) problems.push(`warning(s) about permissions or the CSP: ${fatal.map(describe).join(", ")}`);
  if (!problems.length && status !== 0) problems.push(`web-ext lint exited ${status}`);
  return { problems, warnings, errors: report.errors.length };
}
