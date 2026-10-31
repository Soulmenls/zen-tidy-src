// The pinned web-ext (notes/m8-contracts.md, "A. Pin web-ext"; M7-SEC-1). tools/web-ext/ is a private npm package
// with one dependency, web-ext at exactly WEB_EXT_VERSION, and a committed lockfile that fixes every package below it
// by its registry.npmjs.org tarball and sha512 hash. `npm run tools` installs exactly that tree (npm ci
// --ignore-scripts: no package runs code at install). release.mjs lint and scripts/sign.ps1 run the installed bin with
// node, by absolute path, so nothing resolves a version by range or installs a package while the AMO secret is in an
// environment.
//
// The rules are pure, over the files' text: the committed package.json and lockfile, then the installed tree as npm ci
// recorded it in its hidden lockfile (node_modules/.package-lock.json) and as node finds it, each package's own
// package.json, compared without calling npm. They are the preflight's "web-ext" rule, which sign runs once more right
// before the upload, and scripts/web-ext.mjs (`npm run lint:ext`) runs them before it starts web-ext.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { REPO_ROOT } from "./dev-paths.js";
import { parseJsonQuietly } from "./quiet-json.js";
import { WEB_EXT_VERSION } from "./release-config.js";
import { childEnv, strippedNames } from "./release-runners.js";

export const TOOL_DIR = "tools/web-ext";
export const INSTALL_COMMAND = "npm run tools";
export const NPM_REGISTRY = "https://registry.npmjs.org/";
// Below TOOL_DIR. `bin` is web-ext 10.7.0's own "bin" entry; `installed` is npm ci's record of the tree it wrote.
export const TOOL_FILES = Object.freeze({
  package: "package.json",
  lockfile: "package-lock.json",
  installed: "node_modules/.package-lock.json",
  webExt: "node_modules/web-ext/package.json",
  bin: "node_modules/web-ext/bin/web-ext.js",
});
// A refusal lists this many problems at most, then how many more there are.
export const MAX_PROBLEMS = 5;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const BUNDLE_FIELDS = ["bundleDependencies", "bundledDependencies"];
// What the root package may not have at all: its one dependency is `dependencies`' web-ext.
const OTHER_ROOT_FIELDS = [...DEPENDENCY_FIELDS.filter((field) => field !== "dependencies"), ...BUNDLE_FIELDS];
// What an installed package must match its lockfile entry on (name only an alias has, on both sides).
const TREE_FIELDS = ["name", "version", "resolved", "integrity"];
// A refusal names this many packages at most, then "...".
const NAMED_PACKAGES = 3;
// One sha512 hash, base64 (npm's Subresource Integrity form): 64 bytes are 86 characters and "==".
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
// A registry version range or dist-tag (^1.2.3, >=2 <3, 1.x || 2, latest), or npm:<name>@<range>, an alias that still
// names a registry package.
const RANGE_RE = /^[\w.+\-^~<>=|* ]*$/;
const ALIAS_RE = /^npm:(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.+\-^~<>=|* ]*)?$/i;
// A package name as npm allows one (URL-safe characters, optionally under an @scope/), neither starting nor ending
// with a dot: no name is "", "." or "..", or holds a slash or backslash of its own, and none ends in the dot Windows
// drops from a folder name (node_modules/web-ext. would be written to node_modules\web-ext).
const PART = String.raw`[\w!'()*~-](?:[\w.!'()*~-]*[\w!'()*~-])?`;
const NAME = `(?:@${PART}\\/)?${PART}`;
const NAME_RE = new RegExp(`^${NAME}$`);
// A lockfile key: node_modules/<name>, nested any number of times, so no package is written outside node_modules/.
const KEY_RE = new RegExp(`^(?:node_modules\\/${NAME}\\/)*node_modules\\/${NAME}$`);
// A plain semver version (no range, path or URL text), as every registry tarball's name carries one.
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// web-ext's own tarball: the one package lint and sign run.
const WEB_EXT_TARBALL = `${NPM_REGISTRY}web-ext/-/web-ext-${WEB_EXT_VERSION}.tgz`;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const label = (rel) => `${TOOL_DIR}/${rel}`;
// The package a lockfile key installs: its alias's name, else the key's last node_modules/<name>.
const packageName = (key, entry) => (Object.hasOwn(entry, "name") ? entry.name : key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length));
const named = (keys) => `${keys.slice(0, NAMED_PACKAGES).join(", ")}${keys.length > NAMED_PACKAGES ? ", ..." : ""}`;

export function webExtBin(root = REPO_ROOT) {
  return path.join(root, ...TOOL_DIR.split("/"), ...TOOL_FILES.bin.split("/"));
}

// The kind of a dependency spec that is not a registry range ("git", "file", "link", "URL" or "an unknown spec"), or
// null for a registry range or alias.
export function specKind(spec) {
  if (typeof spec !== "string") return "an unknown spec";
  // A spec ending like a tarball is a file to npm, though its letters alone would pass for a dist-tag.
  if (/\.(?:tgz|tar\.gz|tar)$/i.test(spec)) return /^https?:/i.test(spec) ? "URL" : "file";
  // A path as npm-package-arg's isFilespec reads one: anything that starts with a dot (no range or dist-tag does), ~/,
  // a slash or a drive letter. Before the ranges, which ".", ".." and ".x" would pass, and the GitHub shorthand, which
  // ../x would.
  if (/^file:/i.test(spec) || /^(?:\.|~\/|[\\/]|[a-zA-Z]:)/.test(spec)) return "file";
  if (RANGE_RE.test(spec) || ALIAS_RE.test(spec)) return null;
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|gist:)/i.test(spec) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(spec)) return "git";
  if (/^link:/i.test(spec)) return "link";
  if (/^https?:/i.test(spec)) return "URL";
  return "an unknown spec";
}

// The first MAX_PROBLEMS, and a count of the rest: a lockfile from another registry would otherwise make the refusal a
// line per package.
function capped(problems) {
  if (problems.length <= MAX_PROBLEMS) return problems;
  return [...problems.slice(0, MAX_PROBLEMS), `and ${problems.length - MAX_PROBLEMS} more`];
}

// The root package, as package.json or the lockfile's packages[""] states it: web-ext at exactly the pinned version,
// and no other dependency of any kind.
function rootProblems(root, name) {
  const problems = [];
  if (!isDeepStrictEqual(root.dependencies, { "web-ext": WEB_EXT_VERSION })) {
    problems.push(`${name} must depend on exactly web-ext ${WEB_EXT_VERSION} and nothing else (dependencies: ${JSON.stringify(root.dependencies ?? null)})`);
  }
  for (const field of OTHER_ROOT_FIELDS) if (Object.hasOwn(root, field)) problems.push(`${name} has ${field}`);
  return problems;
}

// tools/web-ext/package.json: private (npm never publishes it), no scripts (none of its own code runs, even for an
// install made without --ignore-scripts), and the one dependency.
export function toolPackageProblems(pkg) {
  const name = label(TOOL_FILES.package);
  if (!isObject(pkg)) return [`${name} is not a JSON object`];
  const problems = [];
  if (pkg.private !== true) problems.push(`${name} is not "private": true`);
  if (Object.hasOwn(pkg, "scripts")) problems.push(`${name} has scripts`);
  return [...problems, ...rootProblems(pkg, name)];
}

// One lockfile entry below the root: a registry package, fetched from its own tarball on registry.npmjs.org and
// checked against one sha512 hash, depending on registry packages only.
function entryProblems(key, entry) {
  const where = `${label(TOOL_FILES.lockfile)} ${key}`;
  if (!key.startsWith("node_modules/")) return [`${where} is not a package below node_modules/ (a workspace, file or link package)`];
  if (!KEY_RE.test(key)) return [`${where} is not node_modules/<package name> (an empty, "." or ".." part, a name ending in a dot, or a character no package name has)`];
  if (!isObject(entry)) return [`${where} is not an object`];
  if (entry.link) return [`${where} is a link (${JSON.stringify(entry.resolved ?? null)})`];
  // An alias (npm:<name>@<range>) installs under its own key and names the registry package it is.
  const name = packageName(key, entry);
  if (typeof name !== "string" || !NAME_RE.test(name)) return [`${where} is an alias of ${JSON.stringify(name)}, which is not a package name`];
  // The version is part of the tarball's URL below: "1.0.0/../../../evil/-/evil-9.9.9" would point it at another
  // package's tarball once the URL is normalised.
  if (typeof entry.version !== "string" || !VERSION_RE.test(entry.version)) return [`${where} has no plain semver version (${JSON.stringify(entry.version ?? null)})`];
  const problems = [];
  const tarball = `${NPM_REGISTRY}${name}/-/${name.slice(name.lastIndexOf("/") + 1)}-${entry.version}.tgz`;
  if (typeof entry.resolved !== "string" || !entry.resolved.startsWith(NPM_REGISTRY)) {
    problems.push(`${where} is not resolved from ${NPM_REGISTRY} (${JSON.stringify(entry.resolved ?? null)})`);
  } else if (entry.resolved !== tarball) {
    problems.push(`${where} is resolved from ${entry.resolved}, not from ${name} ${entry.version}'s own tarball`);
  }
  if (typeof entry.integrity !== "string" || !INTEGRITY_RE.test(entry.integrity)) problems.push(`${where} has no single sha512 integrity`);
  // npm skips an optional package it can't install (another platform), and node, not finding it in tools/web-ext,
  // would look in every node_modules folder above it and in NODE_PATH: every package must be installed.
  if (entry.optional === true) problems.push(`${where} is optional (npm may leave it out)`);
  for (const field of DEPENDENCY_FIELDS) {
    // A list or a string there is no npm shape: refused rather than skipped, so no spec in it goes unread.
    if (Object.hasOwn(entry, field) && !isObject(entry[field])) problems.push(`${where} has ${field} that is not an object`);
    for (const [dependency, spec] of Object.entries(isObject(entry[field]) ? entry[field] : {})) {
      const kind = specKind(spec);
      if (kind) problems.push(`${where} depends on ${dependency} by ${kind} (${JSON.stringify(spec)})`);
    }
  }
  for (const field of BUNDLE_FIELDS) if (Object.hasOwn(entry, field)) problems.push(`${where} has ${field}`);
  return problems;
}

// tools/web-ext/package-lock.json: lockfileVersion 3 or more; the root's only dependency is web-ext at exactly the
// pinned version, which it installs at node_modules/web-ext from web-ext's own tarball (an alias there, npm:<other>@x,
// would put another package's bin where lint and sign run it); every other entry a registry package (entryProblems), and
// no two keys the same folder on a case-insensitive file system (Windows). No git, file, link, http or tarball-URL
// dependency anywhere.
export function lockfileProblems(lock) {
  const name = label(TOOL_FILES.lockfile);
  if (!isObject(lock)) return [`${name} is not a JSON object`];
  const problems = [];
  if (!Number.isInteger(lock.lockfileVersion) || lock.lockfileVersion < 3) {
    problems.push(`${name} has lockfileVersion ${JSON.stringify(lock.lockfileVersion ?? null)}, not 3 or more`);
  }
  if (!isObject(lock.packages) || !isObject(lock.packages[""])) return [...problems, `${name} has no root package (packages[""])`];
  problems.push(...rootProblems(lock.packages[""], `${name}'s root package`));
  const webExt = lock.packages["node_modules/web-ext"];
  if (!isObject(webExt) || (Object.hasOwn(webExt, "name") && webExt.name !== "web-ext") || webExt.version !== WEB_EXT_VERSION || webExt.resolved !== WEB_EXT_TARBALL) {
    problems.push(`${name} does not install web-ext ${WEB_EXT_VERSION} from ${WEB_EXT_TARBALL} at node_modules/web-ext`);
  }
  const folders = new Map();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    problems.push(...entryProblems(key, entry));
    const folder = key.toLowerCase();
    if (folders.has(folder)) problems.push(`${name} ${key} and ${folders.get(folder)} differ only in letter case (one folder on Windows)`);
    else folders.set(folder, key);
  }
  return problems;
}

// The packages (by lockfile key, without the leading node_modules/) whose installed version, tarball or hash is not
// the lockfile's, or that only one side has (an optional one included: the lockfile rules refuse those).
export function treeDifferences(wanted, installed) {
  const keys = new Set([...Object.keys(wanted), ...Object.keys(installed)]);
  keys.delete("");
  return [...keys].filter((key) => {
    const want = wanted[key];
    const have = installed[key];
    return !isObject(want) || !isObject(have) || TREE_FIELDS.some((field) => want[field] !== have[field]);
  }).map((key) => key.replace(/^node_modules\//, "")).sort();
}

// The packages (as treeDifferences names them) whose folder holds no package.json naming the package and version the
// lockfile installs there: missing, unreadable, or another package's. npm ci's hidden lockfile still lists a folder
// deleted or quarantined since, and node, not finding a package in tools/web-ext, looks for it in every node_modules
// folder above, up to the drive's root, and in NODE_PATH. manifest(key) is that file's text, or null; a reader that
// throws counts as missing. web-ext's own is left to installedProblems' rule for it, which says more.
export function absentPackages(wanted, manifest) {
  return Object.entries(wanted).filter(([key, want]) => key !== "" && key !== "node_modules/web-ext" && isObject(want)).filter(([key, want]) => {
    let have = null;
    try {
      const text = manifest(key);
      // A byte order mark is no part of the JSON.
      have = text === null ? null : JSON.parse(text.replace(/^\uFEFF/, ""));
    } catch {
      have = null;
    }
    return !isObject(have) || have.name !== packageName(key, want) || have.version !== want.version;
  }).map(([key]) => key.replace(/^node_modules\//, "")).sort();
}

// The installed tree against the committed lockfile, as one line that says to run the install: npm ci's hidden
// lockfile must hold exactly the lockfile's packages, each package's folder its package.json, node_modules/web-ext
// must be web-ext itself (not another package under its name) at the pinned version, its bin there. installed and
// webExt are the parsed files, or null when missing or unreadable; manifest is absentPackages'.
export function installedProblems(lock, { installed, webExt, binPresent, manifest }) {
  const parts = [];
  if (!isObject(installed?.packages)) {
    parts.push(`web-ext is not installed (${label(TOOL_FILES.installed)} is missing or unreadable)`);
  } else {
    const differ = treeDifferences(lock.packages, installed.packages);
    if (differ.length) parts.push(`the installed tree is not ${label(TOOL_FILES.lockfile)}'s: ${differ.length} package(s) differ (${named(differ)})`);
    const absent = absentPackages(lock.packages, manifest);
    if (absent.length) parts.push(`${absent.length} installed package(s) are missing or not the lockfile's (${named(absent)})`);
    const where = `${TOOL_DIR}/node_modules/web-ext`;
    if (!isObject(webExt)) parts.push(`${label(TOOL_FILES.webExt)} is missing or unreadable`);
    else if (webExt.name !== "web-ext") parts.push(`${where} is ${JSON.stringify(webExt.name ?? null)} ${JSON.stringify(webExt.version ?? null)}, not web-ext ${WEB_EXT_VERSION}`);
    else if (webExt.version !== WEB_EXT_VERSION) parts.push(`${where} is ${JSON.stringify(webExt.version ?? null)}, not ${WEB_EXT_VERSION}`);
    else if (!binPresent) parts.push(`${label(TOOL_FILES.bin)} is missing`);
  }
  return parts.length ? [`${parts.join("; ")}: run ${INSTALL_COMMAND}`] : [];
}

// The four files' text (null when missing), whether the bin is a file, and a reader of an installed package's
// package.json by its lockfile key (text, or null when missing).
export function readPin(root = REPO_ROOT) {
  const dir = path.join(root, ...TOOL_DIR.split("/"));
  const text = (rel) => {
    try {
      return readFileSync(path.join(dir, ...rel.split("/")), "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
      throw error;
    }
  };
  return {
    package: text(TOOL_FILES.package),
    lockfile: text(TOOL_FILES.lockfile),
    installed: text(TOOL_FILES.installed),
    webExt: text(TOOL_FILES.webExt),
    binPresent: statSync(webExtBin(root), { throwIfNoEntry: false })?.isFile() ?? false,
    manifest: (key) => text(`${key}/package.json`),
  };
}

// Every rule over readPin's answer: the committed package.json and lockfile first, listing at most MAX_PROBLEMS of
// theirs; the installed tree only once they pass (a tree can't match a lockfile that is refused). An empty list passes.
export function pinProblems(files) {
  const committed = (text, rel, check) => {
    if (text === null) return { problems: [`${label(rel)} is missing`] };
    let value;
    try {
      // A byte order mark, as Windows PowerShell 5.1's Set-Content -Encoding UTF8 writes one, is no part of the JSON
      // (npm reads past it too).
      value = parseJsonQuietly(text.replace(/^\uFEFF/, ""), label(rel));
    } catch (error) {
      return { problems: [error.message] };
    }
    return { value, problems: check(value) };
  };
  const pkg = committed(files.package, TOOL_FILES.package, toolPackageProblems);
  const lock = committed(files.lockfile, TOOL_FILES.lockfile, lockfileProblems);
  if (pkg.problems.length || lock.problems.length) return capped([...pkg.problems, ...lock.problems]);
  // npm's own files: unreadable counts as missing, and the line says to install again.
  const installed = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };
  return installedProblems(lock.value, {
    installed: installed(files.installed), webExt: installed(files.webExt), binPresent: files.binPresent, manifest: files.manifest,
  });
}

// scripts/web-ext.mjs: the pinned web-ext with the given arguments, once the rules pass, under the release's cleaned
// environment (release-runners.js childEnv) and without its update check. Resolves to the exit code, which it also
// hands setExitCode; a refusal is one line on stderr. web-ext reads every option from a WEB_EXT_* variable too, which
// the cleaned environment drops: one line on stderr names those it ignored and the flags to pass instead.
export function main(argv = process.argv.slice(2), {
  root = REPO_ROOT, env = process.env, spawn = spawnSync, node = process.execPath, err = (line) => console.error(line),
  setExitCode = (code) => (process.exitCode = code),
} = {}) {
  const problems = pinProblems(readPin(root));
  let code;
  if (problems.length) {
    err(`web-ext: ${problems.join("; ")}`);
    code = 1;
  } else {
    const ignored = strippedNames(env).filter((name) => /^WEB_EXT_/i.test(name));
    if (ignored.length) {
      const flags = ignored.map((name) => `--${name.slice("WEB_EXT_".length).toLowerCase().replaceAll("_", "-")}`);
      err(`web-ext: ignoring ${ignored.join(", ")} from the environment; pass ${ignored.length > 1 ? "them as flags" : "it as a flag"} (${flags.join(", ")})`);
    }
    const result = spawn(node, [webExtBin(root), ...argv], { stdio: "inherit", env: { ...childEnv(env), NO_UPDATE_NOTIFIER: "1" } });
    if (result.error) err(`web-ext: could not start node (${result.error.code ?? result.error.message})`);
    code = result.status ?? 1;
  }
  setExitCode(code);
  return code;
}
