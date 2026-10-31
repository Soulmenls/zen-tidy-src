// The release pipeline's program (notes/m7-contracts.md), run by scripts/release.mjs, whose header lists the commands.
// It wires the pure parts in scripts/lib/release-*.js. Prints paths, counts, versions and hashes, never a secret;
// every failure is one line, exit 1. Tests import this module, never the entry script, which runs as soon as it loads.
//
// Signing resumes as far as web-ext allows. The ledger says "signing-started" before sign.ps1 runs, and web-ext
// keeps its upload's id in the stage (stage/.amo-upload-uuid, with a hash of the package's entries), which staging
// keeps. A re-run of the unchanged package reuses that upload instead of sending the file again, but web-ext
// (10.7.0, lib/util/submit-addon.js) still submits the version: if the failed run got as far as creating it (a
// timeout while AMO reviewed it), AMO refuses it a second time. Then download the signed file from the version's
// page on addons.mozilla.org into signed/: a signed xpi there that verifies skips the upload altogether.
//
// Publishing: a failure before the draft is published leaves at most a draft (delete it, re-run publish); once
// published, the release is immutable, so anything wrong is fixed with a new patch version. Checks that could not
// confirm the published release yet (a request that failed, a flag GitHub had not set yet) are run again by `verify`.
//
// What build, sign and publish package is HEAD's: extension/ and the CSS kit's sources are read from the commit, not
// the working tree (M7-REL-1). With core.autocrlf on, git rewrites line endings at each checkout while git status calls
// the tree clean, so working-tree bytes could differ from what was signed for a tree git calls unchanged.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { REPO_ROOT, isInside, realPath } from "./dev-paths.js";
import { parseJsonQuietly } from "./quiet-json.js";
import {
  CHANGES_NAME, CHANNEL, CSS_PATH, KEY_SHAPED_RE, NOTES_NAME, PRODUCT_ID, SETUP_PATH, SUMS_NAME, UPDATES_NAME, WEB_EXT_VERSION,
  cssKitName, highestVersion, localTestName, parseVersion, tagName, unsignedName, xpiName,
} from "./release-config.js";
import {
  PreflightError, configProblems, gitFacts, gitProblems, headFiles, lintReport, manifestProblems, requirePass, trackedProblems, versionProblems,
} from "./release-checks.js";
import {
  NOTES_PLACEHOLDER, cssKitZip, cssState, releaseNotes, sha256, sumsText, updatesJson,
} from "./release-files.js";
import { defaultLedgerPath, findRelease, ledgerFloor, previousRelease, readLedger, withRelease, writeLedger } from "./release-ledger.js";
import { TOOL_DIR, pinProblems, readPin, webExtBin } from "./release-pin.js";
import { childLine, publishRelease, verifyPublished } from "./release-publish.js";
import { realRunners } from "./release-runners.js";
import { StageError, modeProblem, scanExtension, stageExtension, stageTree } from "./release-stage.js";
import { findSignedXpi, signedXpiProblems } from "./release-verify.js";
import { zipFiles } from "./zip.js";

export const USAGE = [
  "Usage: node scripts/release.mjs bump <ver>",
  "       node scripts/release.mjs check [--ledger <file>]",
  "       node scripts/release.mjs build [--notes <file>] [--ledger <file>]",
  "       node scripts/release.mjs sign --confirm <ver> [--notes <file>] [--ledger <file>]",
  "       node scripts/release.mjs publish --confirm <ver> [--ledger <file>]",
  "       node scripts/release.mjs verify --confirm <ver> [--ledger <file>]",
  "       node scripts/release.mjs local-test --update-url <http://127.0.0.1:PORT/...> --version <ver> --out <dir> [--skip-tests]",
].join("\n");

const OPTIONS = {
  bump: [],
  check: ["--ledger"],
  build: ["--notes", "--ledger"],
  sign: ["--confirm", "--notes", "--ledger"],
  publish: ["--confirm", "--ledger"],
  verify: ["--confirm", "--ledger"],
  "local-test": ["--update-url", "--version", "--out", "--skip-tests"],
};
const FLAGS = new Set(["--skip-tests"]);
const VERSION_FIELD_RE = /^(\s*"version"\s*:\s*")([^"\\\r\n]*)(")/m;
const LOCAL_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9]\d{0,4})\/[^\s"'<>\\]*$/;
const AMO_KEY_REMINDER = "Now revoke the AMO API key on addons.mozilla.org (Developer Hub > Manage API Keys), then run: "
  + "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\amo-credentials.ps1 -Remove";

export class UsageError extends Error {}

const optionKey = (flag) => flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

export function parseArgs(argv) {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") return { command: "help" };
  const [command, ...rest] = argv;
  if (!Object.hasOwn(OPTIONS, command)) throw new UsageError(`unknown command ${command}`);
  const opts = { command };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!OPTIONS[command].includes(arg)) throw new UsageError(`${command} takes no ${arg}`);
    const key = optionKey(arg);
    if (Object.hasOwn(opts, key)) throw new UsageError(`${arg} given twice`);
    if (FLAGS.has(arg)) {
      opts[key] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined || value.startsWith("--") || value === "") throw new UsageError(`${arg} needs a value`);
    opts[key] = value;
  }
  if (command === "bump") {
    if (positional.length !== 1) throw new UsageError("bump needs exactly one version");
    [opts.version] = positional;
  } else if (positional.length) {
    throw new UsageError(`unexpected argument ${positional[0]}`);
  }
  if ((command === "sign" || command === "publish") && !opts.confirm) {
    throw new UsageError(`${command} needs --confirm <version>, the manifest's version`);
  }
  if (command === "verify" && !opts.confirm) throw new UsageError("verify needs --confirm <version>, the published version to check");
  if (command === "local-test") {
    for (const flag of ["--update-url", "--version", "--out"]) if (!opts[optionKey(flag)]) throw new UsageError(`local-test needs ${flag}`);
  }
  return opts;
}

function context({
  root = REPO_ROOT, env = process.env, cwd = process.cwd(), now = () => new Date(), tmpdir = os.tmpdir(),
  log = console.log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), runners = {},
  verifyAttempts = 6, verifyDelayMs = 5000,
} = {}) {
  // Resolved at each call, so a runner missing from `runners` is always the real one, never a stale copy.
  const runner = (name) => (...args) => (runners[name] ?? realRunners[name])(...args);
  const run = Object.fromEntries(Object.keys(realRunners).map((name) => [name, runner(name)]));
  return {
    root, env, cwd, now, tmpdir, log, sleep, run, verifyAttempts, verifyDelayMs,
    ext: path.join(root, "extension"),
    manifestFile: path.join(root, "extension", "manifest.json"),
    packageFile: path.join(root, "package.json"),
    signScript: path.join(root, "scripts", "sign.ps1"),
    webExtBin: webExtBin(root),
    releaseDir: (version) => path.join(root, "dist", "release", version),
    today: () => now().toISOString().slice(0, 10),
  };
}

function readJson(file, label) {
  return parseJsonQuietly(readFileSync(file, "utf8"), label);
}

function manifestVersion(ctx) {
  return readJson(ctx.manifestFile, "extension/manifest.json").version;
}

// The ledger lives outside the repo, as the contract's local state.
function ledgerFile(ctx, opts) {
  const file = opts.ledger ? path.resolve(ctx.cwd, opts.ledger) : defaultLedgerPath(ctx.env);
  if (isInside(file, ctx.root)) throw new Error(`the ledger must live outside the repo: ${file}`);
  return file;
}

function confirmVersion(ctx, confirm) {
  const version = manifestVersion(ctx);
  if (confirm !== version) throw new Error(`--confirm ${confirm} does not match the manifest version ${version}`);
  return version;
}

// data: text, or bytes read as Latin-1 and once more without their NUL bytes (UTF-16, as in staging's contentProblem).
function noKey(label, data) {
  const text = Buffer.isBuffer(data) ? data.toString("latin1") : data;
  if (KEY_SHAPED_RE.test(text) || KEY_SHAPED_RE.test(text.replaceAll("\0", ""))) throw new Error(`${label} holds a key-shaped string`);
}

// ---------- bump ----------

function bump(ctx, version) {
  if (!parseVersion(version)) throw new Error(`${version} is not MAJOR.MINOR.PATCH (digits only, no suffix)`);
  // Both files are planned before either is written; only the top-level "version" value changes.
  const planned = [[ctx.manifestFile, "extension/manifest.json"], [ctx.packageFile, "package.json"]].map(([file, label]) => {
    const text = readFileSync(file, "utf8");
    const before = parseJsonQuietly(text, label);
    const updated = text.replace(VERSION_FIELD_RE, `$1${version}$3`);
    const after = parseJsonQuietly(updated, label);
    if (after.version !== version || !isDeepStrictEqual({ ...after, version: before.version }, before)) {
      throw new Error(`can't find the top-level "version" of ${label}; set it by hand`);
    }
    return { file, label, updated, from: before.version };
  });
  for (const { file, updated } of planned) writeFileSync(file, updated);
  for (const { label, from } of planned) ctx.log(`${label}: ${from} -> ${version}`);
  return { version };
}

// ---------- preflight ----------

function stageOrFail(stageNow) {
  try {
    return stageNow();
  } catch (error) {
    if (error instanceof StageError) throw new PreflightError("staging", error.problems);
    throw error;
  }
}

async function runTests(ctx) {
  const result = await ctx.run.npmTest({ cwd: ctx.root });
  requirePass("tests", result.status === 0 ? [] : [`npm test failed (${result.error ? childLine(result.error.message) : `exit ${result.status}`})`]);
  ctx.log("tests: npm test passed");
}

// The pinned web-ext (release-pin.js): tools/web-ext's package.json and lockfile, and the installed tree against the
// lockfile. The preflight's rule before the tests, and sign's last step before the upload.
function checkPin(ctx) {
  requirePass("web-ext", pinProblems(readPin(ctx.root)));
}

async function runLint(ctx, stageDir) {
  const report = lintReport(await ctx.run.lint({ sourceDir: stageDir, bin: ctx.webExtBin }));
  for (const item of report.warnings) ctx.log(`lint warning: ${item.code ?? "?"}${item.file ? ` (${item.file})` : ""}: ${childLine(item.message)}`);
  requirePass("lint", report.problems);
  ctx.log(`lint: ${report.errors} errors, ${report.warnings.length} warning(s)`);
}

// Rules 1-7 and the pinned web-ext, in the order git, version, staging, manifest, config, web-ext, tests, lint; the
// first failing rule stops.
async function preflight(ctx, { ledgerPath }) {
  const version = manifestVersion(ctx);
  if (!parseVersion(version)) requirePass("version", [`manifest version ${JSON.stringify(version)} is not MAJOR.MINOR.PATCH (digits only)`]);
  const ledger = readLedger(ledgerPath);

  let facts;
  try {
    facts = await gitFacts(ctx.run.git, ctx.root, version);
  } catch (error) {
    requirePass("git", [error.message]);
  }
  requirePass("git", gitProblems(facts, { version, ledger }));
  ctx.log(`git: clean, HEAD ${facts.head.slice(0, 12)}`);
  const packageVersion = readJson(ctx.packageFile, "package.json").version;
  requirePass("version", versionProblems({ manifestVersion: version, packageVersion, ledger, tags: facts.tags }));
  const floor = ledgerFloor(ledger, version);
  ctx.log(`version: ${version} (highest other in the ledger: ${floor ? `${floor.version}, ${floor.state}` : "none"})`);

  // The release is HEAD's bytes, extension/ and the CSS kit's sources alike, read once here (M7-REL-1, M7-SEC-2): a
  // working tree that core.autocrlf rewrote, or a file changed while the release is built, never ships. The working
  // tree must still pass the same rules and hold the same files, so local-test's build of it matches the release.
  const releaseDir = ctx.releaseDir(version);
  const stageDir = path.join(releaseDir, "stage");
  let head;
  try {
    head = await headFiles(ctx.run.git, ctx.root, facts.head);
  } catch (error) {
    requirePass("staging", [error.message]);
  }
  const working = scanExtension(ctx.ext);
  const kitProblems = [CSS_PATH, SETUP_PATH]
    .map((file) => (head.has(file) ? modeProblem(file, head.get(file).mode, head.get(file).type) : `${file} is not in HEAD`)).filter(Boolean);
  requirePass("staging", [...working.problems, ...trackedProblems(working.files.map((file) => file.rel), [...head.keys()]), ...kitProblems]);
  const tree = [...head].filter(([file]) => file.startsWith("extension/")).map(([file, entry]) => ({ ...entry, rel: file.slice("extension/".length) }));
  const stage = stageOrFail(() => stageTree(tree, stageDir));
  ctx.log(`staging: ${stage.count} files from HEAD in ${stageDir}`);

  const manifest = parseJsonQuietly(stage.files.get("manifest.json").toString("utf8"), "staged manifest.json");
  requirePass("manifest", [
    ...manifestProblems(manifest),
    ...(manifest.version === version ? [] : [`HEAD's manifest version ${JSON.stringify(manifest.version)} is not extension/manifest.json's ${version}`]),
  ]);
  requirePass("config", configProblems(stage.files.get("shared/config.js")?.toString("utf8") ?? ""));
  ctx.log("manifest and config: ok");
  checkPin(ctx);
  ctx.log(`web-ext: ${WEB_EXT_VERSION}, installed as ${TOOL_DIR}/package-lock.json pins it`);

  await runTests(ctx);
  await runLint(ctx, stageDir);
  return {
    version, manifest, ledger, head: facts.head, stage, stageDir, releaseDir, ledgerPath,
    css: head.get(CSS_PATH).data, setup: head.get(SETUP_PATH).data,
  };
}

// ---------- build ----------

// The --notes file, checked before the preflight so a bad one fails fast. null without --notes.
function readNotesFile(ctx, opts) {
  if (!opts.notes) return null;
  const file = path.resolve(ctx.cwd, opts.notes);
  const text = readFileSync(file, "utf8");
  if (!text.trim()) throw new Error(`--notes ${file} is empty`);
  if (text.includes(NOTES_PLACEHOLDER)) throw new Error(`--notes ${file} still holds the placeholder`);
  noKey(`--notes ${file}`, text);
  return { file, text };
}

// The changes for this build: the --notes text (kept for later builds), else the last build's, else none.
function readChanges(ctx, notes, releaseDir) {
  const changesFile = path.join(releaseDir, CHANGES_NAME);
  if (notes) {
    writeFileSync(changesFile, notes.text);
    ctx.log(`notes: from ${notes.file}`);
    return notes.text;
  }
  if (existsSync(changesFile)) {
    ctx.log(`notes: kept from the previous build (${changesFile})`);
    return readFileSync(changesFile, "utf8");
  }
  ctx.log("notes: placeholder (publish refuses it; pass --notes <file>)");
  return null;
}

// updates.json, SHA256SUMS and RELEASE-NOTES.md: drafts (xpi null, the unsigned package in SHA256SUMS) or final.
function writeReleaseFiles(ctx, built, xpi) {
  const { version, manifest, releaseDir, ledger } = built;
  const updates = updatesJson({ version, xpiSha256: xpi?.sha256 ?? null, strictMinVersion: manifest.browser_specific_settings.gecko.strict_min_version });
  writeFileSync(path.join(releaseDir, UPDATES_NAME), updates);
  const sums = sumsText([xpi ?? built.unsigned, { name: UPDATES_NAME, sha256: sha256(updates) }, built.cssKit]);
  writeFileSync(path.join(releaseDir, SUMS_NAME), sums);
  const previous = previousRelease(ledger, version);
  const notes = releaseNotes({
    version, date: ctx.today(), changes: built.changes, sums, css: cssState(previous, built.cssSha256), previousVersion: previous?.version ?? null,
  });
  writeFileSync(path.join(releaseDir, NOTES_NAME), notes);
  return { updates, sums, notes };
}

async function buildRelease(ctx, opts, { ledgerPath }) {
  const notes = readNotesFile(ctx, opts);
  const pre = await preflight(ctx, { ledgerPath });
  const { version, releaseDir } = pre;
  const changes = readChanges(ctx, notes, releaseDir);

  const unsignedZip = zipFiles(pre.stage.files);
  const unsigned = { name: unsignedName(version), sha256: sha256(unsignedZip.zip) };
  writeFileSync(path.join(releaseDir, unsigned.name), unsignedZip.zip);

  // HEAD's bytes, as the preflight read them: never the working tree's, and never read again after the tests.
  const { css, setup } = pre;
  noKey(CSS_PATH, css);
  noKey(SETUP_PATH, setup);
  const kit = cssKitZip({ version, css, setup });
  const cssKit = { name: cssKitName(version), sha256: sha256(kit) };
  writeFileSync(path.join(releaseDir, cssKit.name), kit);

  // A final xpi from an earlier sign would sit next to draft files; sign copies it again from signed/.
  rmSync(path.join(releaseDir, xpiName(version)), { force: true });
  const built = { ...pre, changes, unsigned, cssKit, cssSha256: sha256(css) };
  writeReleaseFiles(ctx, built, null);
  ctx.log(`${path.join(releaseDir, unsigned.name)} (${unsignedZip.count} entries, sha256 ${unsigned.sha256})`);
  ctx.log(`${path.join(releaseDir, cssKit.name)} (3 entries, sha256 ${cssKit.sha256})`);
  ctx.log(`drafts: ${UPDATES_NAME}, ${SUMS_NAME}, ${NOTES_NAME} in ${releaseDir}`);
  return built;
}

// ---------- sign ----------

async function sign(ctx, opts, ledgerPath) {
  const built = await buildRelease(ctx, opts, { ledgerPath });
  const { version, releaseDir, stage, stageDir } = built;
  const signedDir = path.join(releaseDir, "signed");
  let entry = findRelease(readLedger(ledgerPath), version);
  let { found, checked } = findSignedXpi(signedDir, stage.files, version);
  if (found) {
    ctx.log(`${signedDir} already holds ${found.name}, which verifies: no upload (AMO refuses a version twice)`);
  } else {
    if (checked.length) {
      throw new Error(`${signedDir} holds ${checked.map((item) => item.name).join(", ")}, which does not verify against the stage `
        + `(${checked[0].problems.join("; ")}): HEAD's extension/ changed after signing, or the file is damaged. AMO refuses a version twice, `
        + "so bump to a new version (or move a damaged file away and re-run)");
    }
    if (entry?.state === "signed") {
      throw new Error(`the ledger says ${version} was signed (xpi sha256 ${entry.xpiSha256}), but ${signedDir} holds no signed xpi: `
        + "download it from addons.mozilla.org into that folder and re-run (AMO refuses a version twice)");
    }
    if (entry?.state === "signing-started") {
      ctx.log(existsSync(path.join(stageDir, ".amo-upload-uuid"))
        ? `the ledger says signing started for ${version} on ${entry.date}: web-ext reuses that upload (stage/.amo-upload-uuid) instead of sending the file again; `
          + `if AMO answers that the version already exists, download the signed file from addons.mozilla.org into ${signedDir} and re-run`
        : `the ledger says signing started for ${version} on ${entry.date}, but stage/.amo-upload-uuid is gone, so web-ext uploads again; `
          + `if AMO answers that the version exists, download the signed file from addons.mozilla.org into ${signedDir} and re-run`);
    }
    // Once more right before the upload: the tests and the lint ran for a while since the preflight's check, and
    // sign.ps1 runs this tree with the AMO secret in its environment.
    checkPin(ctx);
    writeLedger(ledgerPath, withRelease(readLedger(ledgerPath), { version, state: "signing-started", date: entry?.date ?? ctx.today(), commit: built.head }));
    ctx.log(`signing ${version}: scripts/sign.ps1 uploads ${stageDir} to addons.mozilla.org (${CHANNEL}) with web-ext ${WEB_EXT_VERSION} from ${TOOL_DIR}`);
    try {
      const result = await ctx.run.sign({
        script: ctx.signScript, sourceDir: stageDir, artifactsDir: signedDir, channel: CHANNEL, webExtBin: ctx.webExtBin, cwd: ctx.root,
      });
      if (result.status !== 0) {
        throw new Error(`signing failed or timed out (${result.error ? childLine(result.error.message) : `exit ${result.status}`}); the ledger says signing-started. `
          + `Re-run sign --confirm ${version}: web-ext reuses its upload (stage/.amo-upload-uuid) instead of sending the file again. `
          + `If AMO answers that the version already exists, download the signed file from addons.mozilla.org into ${signedDir} and re-run`);
      }
      ({ found, checked } = findSignedXpi(signedDir, stage.files, version));
      if (!found) {
        throw new Error(`web-ext finished, but ${signedDir} holds no signed xpi that verifies`
          + `${checked.length ? ` (${checked[0].name}: ${checked[0].problems.join("; ")})` : ""}`);
      }
    } catch (error) {
      // sign.ps1 may have used the AMO key, whatever came of it.
      ctx.log(AMO_KEY_REMINDER);
      throw error;
    }
  }
  const xpi = { name: xpiName(version), sha256: found.sha256 };
  writeFileSync(path.join(releaseDir, xpi.name), found.data);
  writeReleaseFiles(ctx, built, xpi);
  entry = findRelease(readLedger(ledgerPath), version);
  writeLedger(ledgerPath, withRelease(readLedger(ledgerPath), {
    version, state: "signed", date: entry?.date ?? ctx.today(), commit: built.head, xpiSha256: xpi.sha256, cssSha256: built.cssSha256,
  }));
  ctx.log(`signed: ${path.join(releaseDir, xpi.name)} (sha256 ${xpi.sha256})`);
  ctx.log(`final: ${UPDATES_NAME}, ${SUMS_NAME}, ${NOTES_NAME} in ${releaseDir}`);
  ctx.log(AMO_KEY_REMINDER);
  return { version, xpi };
}

// ---------- publish ----------

function readAsset(file) {
  try {
    return readFileSync(file);
  } catch {
    throw new Error(`${file} is missing: run sign first`);
  }
}

// The signed files as sign left them, checked again against the stage, the ledger and the CSS sources.
function signedRelease(ctx, pre) {
  const { version, releaseDir, stage, manifest, ledger } = pre;
  const entry = findRelease(ledger, version);
  if (entry?.state !== "signed") throw new Error(`${version} is not signed (ledger: ${entry?.state ?? "no entry"}): run sign --confirm ${version} first`);
  const file = (name) => path.join(releaseDir, name);
  const xpiData = readAsset(file(xpiName(version)));
  const xpiProblems = signedXpiProblems(xpiData, stage.files, version);
  if (xpiProblems.length) throw new Error(`${xpiName(version)} does not verify against the stage: ${xpiProblems.join("; ")}`);
  const xpiSha = sha256(xpiData);
  if (xpiSha !== entry.xpiSha256) throw new Error(`${xpiName(version)} is not the xpi the ledger recorded at sign (${entry.xpiSha256})`);
  const updates = updatesJson({ version, xpiSha256: xpiSha, strictMinVersion: manifest.browser_specific_settings.gecko.strict_min_version });
  if (!readAsset(file(UPDATES_NAME)).equals(Buffer.from(updates))) throw new Error(`${UPDATES_NAME} is not the one for the signed xpi: run sign --confirm ${version} again`);
  const { css, setup } = pre;
  if (sha256(css) !== entry.cssSha256) throw new Error(`${CSS_PATH} changed since sign: run sign --confirm ${version} again`);
  const kit = cssKitZip({ version, css, setup });
  if (!readAsset(file(cssKitName(version))).equals(kit)) throw new Error(`${cssKitName(version)} is not the kit for this version: run sign --confirm ${version} again`);
  const assets = [
    { name: xpiName(version), sha256: xpiSha },
    { name: UPDATES_NAME, sha256: sha256(updates) },
    { name: cssKitName(version), sha256: sha256(kit) },
  ];
  const sums = sumsText(assets);
  if (readAsset(file(SUMS_NAME)).toString("utf8") !== sums) throw new Error(`${SUMS_NAME} does not match the signed files: run sign --confirm ${version} again`);
  const notes = readAsset(file(NOTES_NAME)).toString("utf8");
  if (notes.includes(NOTES_PLACEHOLDER)) {
    throw new Error(`${NOTES_NAME} has no user-facing changes yet: run sign --confirm ${version} --notes <file> (no second upload: signed/ already verifies)`);
  }
  if (!notes.includes(sums.trimEnd())) throw new Error(`${NOTES_NAME} lacks the SHA-256 lines: run sign --confirm ${version} again`);
  noKey(NOTES_NAME, notes);
  assets.push({ name: SUMS_NAME, sha256: sha256(Buffer.from(sums)) });
  return { entry, updates, notesFile: file(NOTES_NAME), assets: assets.map((asset) => ({ ...asset, file: file(asset.name) })) };
}

async function publish(ctx, ledgerPath) {
  const pre = await preflight(ctx, { ledgerPath });
  const { version, releaseDir } = pre;
  const signed = signedRelease(ctx, pre);
  const commit = signed.entry.commit;
  const exists = await ctx.run.git(["cat-file", "-e", `${commit}^{commit}`], { cwd: ctx.root });
  if (exists.status !== 0) throw new Error(`the signed commit ${commit} is not in this repo`);
  ctx.log(`publishing ${version} from commit ${commit.slice(0, 12)}: ${signed.assets.length} assets`);

  await publishRelease({
    gh: ctx.run.gh, log: ctx.log, version, assets: signed.assets, notesFile: signed.notesFile, downloadDir: path.join(releaseDir, "downloaded"),
    ledgerPath, commit,
  });
  // Published, so immutable: recorded in the ledger and tagged locally at once, before the checks below (which wait and
  // retry for half a minute), so a run stopped there (Ctrl+C, a crash) still leaves the release on record and never
  // sends anyone to delete it. latestVerified turns true once the checks pass, here or in a later `verify`.
  const record = (latestVerified) => writeLedger(ledgerPath, withRelease(readLedger(ledgerPath), {
    version, state: "published", publishedDate: ctx.today(), latestVerified,
    commit, xpiSha256: signed.entry.xpiSha256, cssSha256: signed.entry.cssSha256,
  }));
  record(false);
  ctx.log(`ledger: ${version} published (${ledgerPath})`);
  const tag = await ctx.run.git(["tag", tagName(version), commit], { cwd: ctx.root });
  const tagCommand = tag.status === 0 ? null : `git tag ${tagName(version)} ${commit}`;
  if (!tagCommand) ctx.log(`local tag ${tagName(version)} on ${commit.slice(0, 12)}`);
  const checks = await verifyPublished({
    gh: ctx.run.gh, fetch: ctx.run.fetch, sleep: ctx.sleep, version, updatesJson: Buffer.from(signed.updates),
    attempts: ctx.verifyAttempts, delayMs: ctx.verifyDelayMs,
  });
  if (!checks.problems.length) record(true);
  if (checks.problems.length || tagCommand) throw new Error(publishedProblem(version, checks, tagCommand));
  ctx.log(`${tagName(version)} is live: updates.json at the update URL names ${version}`);
  return { version };
}

// The one line for a published release that is not all done, by what is left (M7-REL-2, M7-REL-3): only the local tag
// (tagCommand, or null when it was made); checks a later look may clear (`verify` looks again, read-only); or something
// wrong at GitHub, which only a new patch version fixes: the release is immutable.
function publishedProblem(version, checks, tagCommand) {
  const tag = tagName(version);
  if (!checks.problems.length) return `${tag} is published and verified; only the local tag is missing: run ${tagCommand}`;
  const problems = [...checks.problems, ...(tagCommand ? [`the local tag failed (run: ${tagCommand})`] : [])].join("; ");
  if (checks.pending) {
    return `${tag} is published, but could not be confirmed yet: ${problems}. Nothing wrong was found: `
      + `run node scripts/release.mjs verify --confirm ${version} again in a minute`;
  }
  return `${tag} is published, but: ${problems}. The release is immutable: fix anything wrong with a new patch version (bump, commit, build, sign, publish)`;
}

// ---------- verify ----------

// publish's last checks once more, for a release they could not confirm (M7-REL-2): read-only (GitHub's release and the
// update URL), nothing uploaded or changed there. The version is a published one from the ledger, not necessarily the
// manifest's, and the newest: the update URL serves the latest release only. Compares with the updates.json publish
// uploaded, which must still be in dist/release/<ver>/ and name the ledger's xpi hash.
async function verify(ctx, version, ledgerPath) {
  if (!parseVersion(version)) throw new Error(`--confirm ${version} is not MAJOR.MINOR.PATCH (digits only)`);
  const ledger = readLedger(ledgerPath);
  const entry = findRelease(ledger, version);
  if (entry?.state !== "published") throw new Error(`${version} is not published (ledger: ${entry?.state ?? "no entry"}): verify checks a release publish has made`);
  const newest = highestVersion(ledger.releases.filter((release) => release.state === "published").map((release) => release.version));
  if (newest !== version) throw new Error(`${version} is not the newest published release (${newest} is): the update URL serves only the newest`);
  const file = path.join(ctx.releaseDir(version), UPDATES_NAME);
  if (!existsSync(file)) throw new Error(`${file} is missing: verify compares the update URL with the updates.json publish uploaded`);
  const updates = readFileSync(file);
  const named = parseJsonQuietly(updates.toString("utf8"), UPDATES_NAME)?.addons?.[PRODUCT_ID]?.updates?.[0];
  if (named?.version !== version || named?.update_hash !== `sha256:${entry.xpiSha256}`) {
    throw new Error(`${file} is not the updates.json published for ${version} (the ledger's xpi sha256 is ${entry.xpiSha256})`);
  }
  const checks = await verifyPublished({
    gh: ctx.run.gh, fetch: ctx.run.fetch, sleep: ctx.sleep, version, updatesJson: updates, attempts: ctx.verifyAttempts, delayMs: ctx.verifyDelayMs,
  });
  if (checks.problems.length) throw new Error(publishedProblem(version, checks, null));
  writeLedger(ledgerPath, withRelease(readLedger(ledgerPath), { version, latestVerified: true }));
  ctx.log(`${tagName(version)} is live: updates.json at the update URL names ${version}`);
  ctx.log(`ledger: ${version} verified (${ledgerPath})`);
  return { version };
}

// ---------- local-test ----------

export function localUpdateUrlProblem(url) {
  const match = LOCAL_URL_RE.exec(url);
  if (!match || Number(match[1]) > 65535) return `--update-url must be http://127.0.0.1:<port>/... or http://localhost:<port>/..., not ${url}`;
  return null;
}

function localOut(ctx, out) {
  const target = path.resolve(ctx.cwd, out);
  if (path.dirname(target) === target) throw new Error(`--out may not be a drive root: ${target}`);
  if (realPath(target).toLowerCase() === realPath(ctx.root).toLowerCase()) throw new Error("--out may not be the repo root");
  for (const dir of ["extension", "css", "scripts", ".git", path.join("dist", "release")]) {
    if (isInside(target, path.join(ctx.root, dir))) throw new Error(`--out may not be inside ${dir.replace(/\\/g, "/")}/: ${target}`);
  }
  return target;
}

// The release staging, then only version and update_url rewritten, zipped unsigned for the throwaway profile.
async function localTest(ctx, opts) {
  const urlProblem = localUpdateUrlProblem(opts.updateUrl);
  if (urlProblem) throw new Error(urlProblem);
  if (!parseVersion(opts.version)) throw new Error(`--version ${opts.version} is not MAJOR.MINOR.PATCH (digits only)`);
  const out = localOut(ctx, opts.out);
  const tmp = mkdtempSync(path.join(ctx.tmpdir, "zen-tidy-local-test-"));
  try {
    const stage = stageOrFail(() => stageExtension(ctx.ext, path.join(tmp, "stage")));
    const manifest = parseJsonQuietly(stage.files.get("manifest.json").toString("utf8"), "staged manifest.json");
    requirePass("manifest", manifestProblems(manifest));
    requirePass("config", configProblems(stage.files.get("shared/config.js")?.toString("utf8") ?? ""));
    if (opts.skipTests) ctx.log("tests: skipped (--skip-tests)");
    else await runTests(ctx);
    const local = structuredClone(manifest);
    local.version = opts.version;
    local.browser_specific_settings.gecko.update_url = opts.updateUrl;
    const files = new Map(stage.files);
    files.set("manifest.json", Buffer.from(JSON.stringify(local, null, 2) + "\n"));
    const { zip, count } = zipFiles(files);
    mkdirSync(out, { recursive: true });
    const target = path.join(out, localTestName(opts.version));
    writeFileSync(target, zip);
    ctx.log(`${target} (${count} entries, version ${opts.version}, UNSIGNED, update_url ${opts.updateUrl})`);
    ctx.log(`sha256 ${sha256(zip)}`);
    return { file: target, sha256: sha256(zip) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- entry ----------

export async function run(argv, deps = {}) {
  const opts = parseArgs(argv);
  const ctx = context(deps);
  switch (opts.command) {
    case "help":
      ctx.log(USAGE);
      return null;
    case "bump":
      return bump(ctx, opts.version);
    case "check": {
      const pre = await preflight(ctx, { ledgerPath: ledgerFile(ctx, opts) });
      ctx.log(`check passed for ${pre.version}`);
      return { version: pre.version };
    }
    case "build": {
      const built = await buildRelease(ctx, opts, { ledgerPath: ledgerFile(ctx, opts) });
      return { version: built.version };
    }
    case "sign":
      confirmVersion(ctx, opts.confirm);
      return sign(ctx, opts, ledgerFile(ctx, opts));
    case "publish":
      confirmVersion(ctx, opts.confirm);
      return publish(ctx, ledgerFile(ctx, opts));
    case "verify":
      return verify(ctx, opts.confirm, ledgerFile(ctx, opts));
    case "local-test":
      return localTest(ctx, opts);
    default:
      throw new UsageError(`unknown command ${opts.command}`);
  }
}

// The command line: runs the command, and turns a failure into one line on stderr and exit 1. scripts/release.mjs
// calls it unconditionally (no "am I the entry point?" check, which a link to the script or a \\?\ path spelling
// fooled into exiting 0 without running anything).
export function main(argv = process.argv.slice(2)) {
  return run(argv).catch((error) => {
    const message = String(error?.message ?? error).replace(/\s*\r?\n\s*/g, " ");
    console.error(`release: ${message}${error instanceof UsageError ? " (node scripts/release.mjs --help)" : ""}`);
    process.exitCode = 1;
  });
}
