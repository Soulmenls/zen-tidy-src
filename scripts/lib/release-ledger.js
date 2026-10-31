// The release ledger: %LOCALAPPDATA%\zen-tidy-dev\releases.json, outside the repo. One entry per version:
//   { version, state: "signing-started" | "signed" | "published", date, commit, xpiSha256?, cssSha256?,
//     publishedDate?, latestVerified? }
// "published" entries are the releases (the previous CSS hash); the other states let `sign` resume and `publish`
// find what was signed. Every entry raises the version floor: once signing started, AMO may hold that version, and
// it never takes one twice. Writes go to a temporary file that then replaces the ledger.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { devDataDir } from "./dev-paths.js";
import { compareVersions, highestVersion, parseVersion } from "./release-config.js";
import { parseJsonQuietly } from "./quiet-json.js";

export const STATES = ["signing-started", "signed", "published"];
const HEX64_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function defaultLedgerPath(env) {
  return path.join(devDataDir(env, "--ledger"), "releases.json");
}

function entryProblem(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "an entry is not an object";
  if (!parseVersion(entry.version)) return "an entry has no valid version";
  if (!STATES.includes(entry.state)) return `${entry.version} has an unknown state`;
  if (typeof entry.date !== "string") return `${entry.version} has no date`;
  if (entry.commit !== undefined && !COMMIT_RE.test(entry.commit)) return `${entry.version} has a bad commit`;
  for (const field of ["xpiSha256", "cssSha256"]) {
    if (entry[field] !== undefined && !HEX64_RE.test(entry[field])) return `${entry.version} has a bad ${field}`;
  }
  if (entry.state === "published" && !(HEX64_RE.test(entry.xpiSha256 ?? "") && HEX64_RE.test(entry.cssSha256 ?? ""))) {
    return `${entry.version} is published without its hashes`;
  }
  return null;
}

// A missing ledger is empty; a damaged one is an error (it guards against publishing a version twice).
export function readLedger(file) {
  if (!existsSync(file)) return { releases: [] };
  const ledger = parseJsonQuietly(readFileSync(file, "utf8"), `ledger ${file}`);
  if (!ledger || typeof ledger !== "object" || !Array.isArray(ledger.releases)) throw new Error(`ledger ${file} is damaged: no releases list`);
  const seen = new Set();
  for (const entry of ledger.releases) {
    const problem = entryProblem(entry) ?? (seen.has(entry.version) ? `${entry.version} is listed twice` : null);
    if (problem) throw new Error(`ledger ${file} is damaged: ${problem}`);
    seen.add(entry.version);
  }
  return ledger;
}

// Windows refuses the rename while another process has either file open (Defender scanning the file just written, the
// indexer). That clears in moments, so it is retried for up to about 3 s, as graceful-fs does: publish records a release
// that is already live and immutable, and a transient refusal there would leave it off the ledger and untagged.
const RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
export const RENAME_ATTEMPTS = 30;
const RENAME_DELAY_MS = 100;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function writeLedger(file, ledger, { rename = renameSync, sleep = sleepSync } = {}) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n");
  for (let attempt = 1; ; attempt++) {
    try {
      rename(tmp, file);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRY_CODES.has(error?.code)) throw error;
      sleep(RENAME_DELAY_MS);
    }
  }
}

export function findRelease(ledger, version) {
  return ledger.releases.find((entry) => entry.version === version) ?? null;
}

// The entry for entry.version replaced by `entry` (fields merged), releases kept in version order.
export function withRelease(ledger, entry) {
  const others = ledger.releases.filter((old) => old.version !== entry.version);
  const merged = { ...findRelease(ledger, entry.version), ...entry };
  return { ...ledger, releases: [...others, merged].sort((a, b) => compareVersions(a.version, b.version)) };
}

function publishedReleases(ledger) {
  return ledger.releases.filter((entry) => entry.state === "published");
}

// The entry `version` must be above (Preflight rule 2): the highest in the ledger, whatever its state, except
// `version`'s own unpublished entry, which is the release being signed or published now. null when none.
export function ledgerFloor(ledger, version) {
  const others = ledger.releases.filter((entry) => entry.state === "published" || entry.version !== version);
  const best = highestVersion(others.map((entry) => entry.version));
  return best === null ? null : findRelease(ledger, best);
}

// The newest published release below `version`, whose CSS the release notes compare against.
export function previousRelease(ledger, version) {
  const older = publishedReleases(ledger).filter((entry) => compareVersions(entry.version, version) < 0);
  const best = highestVersion(older.map((entry) => entry.version));
  return best === null ? null : findRelease(ledger, best);
}
