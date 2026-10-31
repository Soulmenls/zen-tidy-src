// Staging (m7-contracts, "Staging"): extension/ copied file by file into a stage folder, which must then equal
// its source byte for byte. Nothing is dropped silently: a test or dev file, a link, or a file mentioning loopback, the
// mock or a key refuses the whole release, before anything is written. build, sign and publish stage HEAD's
// extension/ through stageTree (M7-REL-1: the release is the commit's bytes); local-test, which runs on the working
// tree without git, stages through stageExtension. Both share the rules and the copy-and-check.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isInside, relativeInside } from "./dev-paths.js";
import { KEY_SHAPED_RE, WEB_EXT_SIDECARS } from "./release-config.js";
import { byCodeUnit } from "./zip.js";

export class StageError extends Error {
  constructor(problems) {
    super(problems.join("; "));
    this.problems = problems;
  }
}

// Why a path (forward slashes, below extension/) may not ship, or null. Compared without case, as Windows does.
export function nameProblem(rel) {
  const segments = rel.toLowerCase().split("/");
  const base = segments.at(-1);
  if (base === ".zen-tidy-dev-build") return `${rel} is a dev build marker`;
  if (segments.some((segment) => segment.startsWith("."))) return `${rel} is a dotfile`;
  if (segments.slice(0, -1).some((segment) => segment === "test")) return `${rel} is in a test/ folder`;
  if (segments.slice(0, -1).some((segment) => segment === "fixtures")) return `${rel} is in a fixtures/ folder`;
  // web-ext's package leaves node_modules/ out, so AMO would sign a package without it.
  if (segments.slice(0, -1).some((segment) => segment === "node_modules")) return `${rel} is in a node_modules/ folder`;
  if (base.startsWith("selftest.")) return `${rel} is a self-test page`;
  if (base.includes(".test.")) return `${rel} is a test file`;
  for (const ext of [".map", ".xpi", ".zip"]) if (base.endsWith(ext)) return `${rel} is a ${ext} file`;
  return null;
}

// Why a file's bytes may not ship, or null. Read as Latin-1 so binary files are searched too, and once more without
// their NUL bytes when they have any: UTF-16 text, with or without a byte order mark, has a NUL beside every ASCII
// character, which would hide a key or a loopback address from the Latin-1 reading (M7-SEC-5).
export function contentProblem(rel, data) {
  const latin1 = data.toString("latin1");
  for (const text of latin1.includes("\0") ? [latin1, latin1.replaceAll("\0", "")] : [latin1]) {
    if (text.includes("127.0.0.1")) return `${rel} mentions 127.0.0.1`;
    if (/localhost/i.test(text)) return `${rel} mentions localhost`;
    if (/mock-anthropic/i.test(text)) return `${rel} mentions mock-anthropic`;
    if (KEY_SHAPED_RE.test(text)) return `${rel} holds a key-shaped string`;
  }
  return null;
}

function walk(root, dir, rel, files, problems) {
  for (const name of readdirSync(dir).sort(byCodeUnit)) {
    const abs = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      problems.push(`${relPath} is a link or junction`);
    } else if (stat.isDirectory()) {
      walk(root, abs, relPath, files, problems);
    } else if (!stat.isFile()) {
      problems.push(`${relPath} is not a regular file`);
    } else if (stat.nlink > 1) {
      problems.push(`${relPath} is a hard link`);
    } else if (relativeInside(abs, root) === null) {
      problems.push(`${relPath} resolves outside extension/`);
    } else {
      files.push({ rel: relPath, abs });
    }
  }
}

// Every file of extDir with its bytes, plus every reason it can't ship.
export function scanExtension(extDir) {
  const problems = [];
  const files = [];
  if (!existsSync(extDir)) return { files, problems: [`${extDir} does not exist`] };
  if (lstatSync(extDir).isSymbolicLink()) return { files, problems: ["extension/ is a link or junction"] };
  walk(extDir, extDir, "", files, problems);
  const read = files.sort((a, b) => byCodeUnit(a.rel, b.rel)).map(({ rel, abs }) => ({ rel, data: readFileSync(abs) }));
  for (const { rel, data } of read) {
    const problem = nameProblem(rel) ?? contentProblem(rel, data);
    if (problem) problems.push(problem);
  }
  return { files: read, problems };
}

// The stage's files (web-ext's sidecars left out) as Map(rel -> Buffer), sorted.
export function readStage(stageDir) {
  const files = [];
  const problems = [];
  walk(stageDir, stageDir, "", files, problems);
  if (problems.length) throw new StageError(problems);
  const kept = files.filter(({ rel }) => !WEB_EXT_SIDECARS.includes(rel)).sort((a, b) => byCodeUnit(a.rel, b.rel));
  return new Map(kept.map(({ rel, abs }) => [rel, readFileSync(abs)]));
}

// Empties stageDir except web-ext's sidecar files (regular files only), creating it if needed.
function prepareStage(stageDir) {
  if (!existsSync(stageDir)) {
    mkdirSync(stageDir, { recursive: true });
    return;
  }
  if (!lstatSync(stageDir).isDirectory()) throw new Error(`${stageDir} is not a folder`);
  for (const name of readdirSync(stageDir)) {
    const abs = path.join(stageDir, name);
    if (WEB_EXT_SIDECARS.includes(name) && lstatSync(abs).isFile()) continue;
    rmSync(abs, { recursive: true, force: true });
  }
}

// The copy and its check, whatever the files' source: writes files ([{ rel, data }], already checked) into stageDir,
// then the stage must equal `current(rel)` (the source's bytes as they are now) byte for byte, nothing added or missing.
// onCopied runs between the copy and its check (tests use it to change a file, as a concurrent edit would).
function stageFiles(files, stageDir, { source, current, onCopied = () => {} }) {
  prepareStage(stageDir);
  for (const { rel, data } of files) {
    const target = path.join(stageDir, ...rel.split("/"));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { flag: "wx" });
  }
  onCopied();
  const staged = readStage(stageDir);
  const names = files.map(({ rel }) => rel);
  const mismatch = [];
  if ([...staged.keys()].join("\0") !== [...names].sort(byCodeUnit).join("\0")) mismatch.push(`the staged file list differs from ${source}`);
  for (const rel of names) if (!staged.get(rel)?.equals(current(rel))) mismatch.push(`${rel} differs from ${source}`);
  if (mismatch.length) throw new StageError(mismatch);
  return { files: staged, count: staged.size };
}

// Stages extDir (the working tree) into stageDir and checks the copy: local-test's source. Returns
// { files: Map(rel -> Buffer), count }.
export function stageExtension(extDir, stageDir, { onCopied = () => {} } = {}) {
  if (isInside(stageDir, extDir) || isInside(extDir, stageDir)) throw new Error(`refusing to stage into ${stageDir}`);
  const { files, problems } = scanExtension(extDir);
  if (problems.length) throw new StageError(problems);
  return stageFiles(files, stageDir, { source: "extension/", current: (rel) => readFileSync(path.join(extDir, ...rel.split("/"))), onCopied });
}

// Why a tree entry from git may not ship, or null: only regular files (modes 100644 and 100755) are a package's.
export function modeProblem(rel, mode, type) {
  if (type === "commit") return `${rel} is a submodule`;
  if (mode === "120000") return `${rel} is a link`;
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return `${rel} is not a regular file`;
  return null;
}

// Stages HEAD's extension/ (entries [{ rel, mode, type, data }], rel below extension/): the release's source, so what is
// signed and published is the commit's bytes whatever line endings the working tree has (M7-REL-1). The same rules as
// the working tree's (names, contents) plus the entry's mode; the same copy and check.
export function stageTree(entries, stageDir, { onCopied = () => {} } = {}) {
  const sorted = [...entries].sort((a, b) => byCodeUnit(a.rel, b.rel));
  const problems = sorted.map(({ rel, mode, type, data }) => modeProblem(rel, mode, type) ?? nameProblem(rel) ?? contentProblem(rel, data)).filter(Boolean);
  if (problems.length) throw new StageError(problems);
  const blobs = new Map(sorted.map(({ rel, data }) => [rel, data]));
  return stageFiles(sorted, stageDir, { source: "HEAD's extension/", current: (rel) => blobs.get(rel), onCopied });
}
