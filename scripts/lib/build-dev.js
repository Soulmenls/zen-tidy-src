// The dev build's program, run by scripts/build-dev.mjs (whose header has the command line): copies extension/ into a
// git-ignored folder (default dist-dev/), switches it to the dev gecko id, adds the self-test page and zips it into
// <out>.xpi for the Zen integration harness. With --mock <port> the build talks to test/integration/mock-anthropic.mjs
// on 127.0.0.1 instead of api.anthropic.com. extension/ itself is only ever read; release builds never go through here.
// Prints only paths and counts. Tests import this module, never the entry script, which builds as soon as it loads.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, isInside } from "./dev-paths.js";
import { zipDir as zipFolder } from "./zip.js";

const EXT_DIR = path.join(REPO_ROOT, "extension");
const SELFTEST_DIR = path.join(REPO_ROOT, "test", "integration");
const SELFTEST_FILES = ["selftest.html", "selftest.js"];
const DEFAULT_OUT = path.join(REPO_ROOT, "dist-dev");

export const DEV_ID = "zen-tidy-dev@soulaymane";
export const DEV_NAME = "Zen Tidy Dev";
// Host permission for the mock: extension fetches to a granted host skip CORS, so no preflight is
// needed. Match patterns ignore the port, so one entry covers whatever port the mock picks.
export const MOCK_HOST_PERMISSION = "http://127.0.0.1/*";
// Written into every build (holding DEV_ID) and left out of the xpi. Only a folder that carries it is
// ever wiped: a manifest.json alone proves nothing, since any other extension or PWA folder has one.
export const BUILD_MARKER = ".zen-tidy-dev-build";

export const USAGE = "Usage: node scripts/build-dev.mjs [--mock <port>] [--out <dir>]";
const API_BASE_RE = /^export const API_BASE = "[^"\r\n]*";$/m;

export function parseArgs(argv) {
  const opts = { mock: null, out: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--mock" || arg === "--out") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (arg === "--mock") {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("--mock needs a port from 1 to 65535");
        opts.mock = port;
      } else opts.out = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// True only for a folder this script built: its marker is a regular file (not a link) holding DEV_ID.
function hasBuildMarker(dir) {
  try {
    const marker = path.join(dir, BUILD_MARKER);
    return lstatSync(marker).isFile() && readFileSync(marker, "utf8").trim() === DEV_ID;
  } catch {
    return false;
  }
}

// The out folder is wiped first, so refuse anything that could hold sources or someone's files:
// extension/ or a folder inside it, a folder that contains extension/ or the self-test sources, a
// drive root, or an existing non-empty folder without the marker of a previous dev build.
function checkOutDir(out) {
  if (path.dirname(out) === out) throw new Error(`Refusing to build into a drive root: ${out}`);
  if (isInside(out, EXT_DIR)) throw new Error(`Refusing to build inside extension/: ${out}`);
  for (const source of [EXT_DIR, SELFTEST_DIR]) {
    if (isInside(source, out)) throw new Error(`Refusing to wipe a folder that contains ${source}: ${out}`);
  }
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new Error(`--out is not a folder: ${out}`);
    if (readdirSync(out).length && !hasBuildMarker(out)) {
      throw new Error(`Refusing to wipe ${out}: it is not empty and has no ${BUILD_MARKER} marker from a previous dev build. `
        + "If it is an old dev build, delete it yourself and build again.");
    }
  }
}

// CSP "a b; c d" -> [["a", "b"], ["c", "d"]] and back, so one directive can be edited in place.
function parseCsp(csp) {
  return csp.split(";").map((part) => part.trim().split(/\s+/)).filter((tokens) => tokens[0]);
}

// The dev id never polls the product's update manifest: update_url goes (the local update test builds its own
// with release.mjs local-test).
export function devManifest(manifest, mockPort = null) {
  const out = structuredClone(manifest);
  out.name = DEV_NAME;
  out.browser_specific_settings.gecko.id = DEV_ID;
  delete out.browser_specific_settings.gecko.update_url;
  if (mockPort === null) return out;

  const directives = parseCsp(out.content_security_policy.extension_pages);
  const connect = directives.find((tokens) => tokens[0] === "connect-src");
  if (!connect) throw new Error("manifest CSP has no connect-src directive");
  connect.push(`http://127.0.0.1:${mockPort}`);
  // upgrade-insecure-requests would turn the mock's http:// URL into https:// if Firefox ever
  // stopped exempting loopback hosts, and the mock speaks plain HTTP. Dropped only in mock builds.
  const kept = directives.filter((tokens) => tokens[0] !== "upgrade-insecure-requests");
  out.content_security_policy.extension_pages = kept.map((tokens) => tokens.join(" ")).join("; ");

  const hosts = Array.isArray(out.host_permissions) ? out.host_permissions : [];
  if (!hosts.includes(MOCK_HOST_PERMISSION)) hosts.push(MOCK_HOST_PERMISSION);
  out.host_permissions = hosts;
  return out;
}

export function mockConfig(source, mockPort) {
  if (!API_BASE_RE.test(source)) throw new Error("shared/config.js has no `export const API_BASE = \"...\";` line");
  return source.replace(API_BASE_RE, `export const API_BASE = "http://127.0.0.1:${mockPort}";`);
}

// The build marker stays out of the xpi: it only tells this script which folder it may wipe. The writer
// (lib/zip.js) is the release script's too: sorted entries, manifest.json first, a fixed timestamp.
export function zipDir(dir) {
  return zipFolder(dir, { exclude: [BUILD_MARKER] });
}

export function build({ mock = null, out = null } = {}) {
  const outDir = path.resolve(out ?? DEFAULT_OUT);
  checkOutDir(outDir);
  rmSync(outDir, { recursive: true, force: true });
  cpSync(EXT_DIR, outDir, { recursive: true });
  writeFileSync(path.join(outDir, BUILD_MARKER), `${DEV_ID}\n`);

  const manifest = JSON.parse(readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8"));
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(devManifest(manifest, mock), null, 2) + "\n");
  if (mock !== null) {
    const configPath = path.join(outDir, "shared", "config.js");
    writeFileSync(configPath, mockConfig(readFileSync(path.join(EXT_DIR, "shared", "config.js"), "utf8"), mock));
  }

  const selftestOut = path.join(outDir, "selftest");
  mkdirSync(selftestOut, { recursive: true });
  for (const file of SELFTEST_FILES) cpSync(path.join(SELFTEST_DIR, file), path.join(selftestOut, file));

  const xpiPath = `${outDir}.xpi`;
  const { zip, count } = zipDir(outDir);
  writeFileSync(xpiPath, zip);
  return { outDir, xpiPath, files: count };
}

// The command: builds (or prints the usage) and prints the two paths with their counts. Throws on a bad argument or a
// refused --out.
export function run(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(USAGE);
    return null;
  }
  const result = build(opts);
  console.log(`${result.outDir} (${result.files} files)`);
  console.log(`${result.xpiPath} (${result.files} entries)`);
  return result;
}

// The command line: a failure is the reason and the usage on stderr, exit 1. scripts/build-dev.mjs calls it
// unconditionally: its old "am I the entry point?" test (argv[1] against import.meta.url) exited 0 without building
// when the script was reached through a junction or by a \\?\ path, leaving an earlier build's xpi in place (M7-REL-6).
export function main(argv = process.argv.slice(2)) {
  try {
    return run(argv);
  } catch (err) {
    console.error(`build-dev: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return null;
  }
}
