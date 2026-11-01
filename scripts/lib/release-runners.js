// The real outside world of release.mjs: git, npm test, web-ext lint, sign.ps1 (uploads to Mozilla), gh (GitHub)
// and fetch. release.mjs takes each one injected and falls back to these; unit tests inject stand-ins and replace
// these with traps, so a test can never reach Mozilla, GitHub or the network. The command lines are built by the
// pure *Command functions, and createRunners takes its spawn, so a test checks every word without starting anything.

import { spawnSync } from "node:child_process";

import { WEB_EXT_VERSION } from "./release-config.js";

const MAX_BUFFER = 64 * 1024 * 1024;

// Variables no child of the release needs, which would change what it does: web-ext 10.7.0 reads every one of its
// options from a WEB_EXT_* variable (lib/program.js `.env("WEB_EXT")`), so one left in the shell from another project
// could leave files out of what AMO signs (WEB_EXT_IGNORE_FILES), upload a source archive (WEB_EXT_UPLOAD_SOURCE_CODE)
// or send the signed request elsewhere (WEB_EXT_AMO_BASE_URL, WEB_EXT_API_PROXY). An exported GitHub token would reach
// npm, web-ext and every package they run, and in gh it would override the keyring login publish relies on, as GH_HOST
// would change the host `--repo Soulmenls/zen-tidy` and `gh api` resolve to. NODE_PATH adds folders where node looks
// for a package it does not find in the node_modules folders above the code: with one gone from tools/web-ext's tree,
// web-ext would load whatever is there instead. Names compare without case: a copied Windows environment keeps each
// name as it was set.
const STRIPPED_RE = /^(?:WEB_EXT_.*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|NODE_PATH)$/i;
// Stripped for sign only: NODE_OPTIONS can --require or --import any module into node, and sign's node holds the AMO
// secret. npm test and lint keep it, as the integration's network guard reaches their children through it.
const SIGN_STRIPPED_RE = /^NODE_OPTIONS$/i;

// A copy of env without the stripped variables (and those `also` matches); env itself is left alone.
export function childEnv(env, also = null) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !STRIPPED_RE.test(name) && !also?.test(name)));
}

// The names in env that childEnv leaves out, as env spells them.
export function strippedNames(env) {
  return Object.keys(env).filter((name) => STRIPPED_RE.test(name));
}

// { command, args, env? }: env is the child's whole environment when given, else the parent's is inherited.
export function gitCommand(args) {
  return { command: "git", args: [...args] };
}

// The capped unit run (scripts/test.mjs).
export function npmTestCommand({ env }) {
  return { command: "npm", args: ["test"], env: childEnv(env) };
}

// The pinned web-ext's lint of the staged folder, run from inside it (so no path goes through the shell): `node` is
// this process's own executable and `bin` the absolute path of tools/web-ext's installed web-ext.js (release-pin.js),
// which the preflight checked against the committed lockfile; no package runner and no install. web-ext starts
// update-notifier, which otherwise spawns a check that asks registry.npmjs.org for a newer web-ext every few days;
// NO_UPDATE_NOTIFIER turns it off, so the lint makes no network request at all.
export function lintCommand({ node, bin, env }) {
  return {
    command: node,
    args: [bin, "lint", "--source-dir", ".", "--self-hosted", "--output", "json", "--no-config-discovery"],
    env: { ...childEnv(env), NO_UPDATE_NOTIFIER: "1" },
  };
}

// scripts/sign.ps1 with its six parameters: it unlocks the stored AMO key (asking its passphrase in a dialog) for the
// web-ext child only and UPLOADS the folder to Mozilla, running `<node> <webExtBin> sign`: the same pinned web-ext as
// lint, with the same node (this process's own, not whichever node.exe comes first on PATH), checked against
// WEB_EXT_VERSION (it refuses before asking for the passphrase when either file is missing or web-ext is another
// version). Its environment, which sign.ps1 hands on to `web-ext sign`, is the parent's without the stripped variables
// and NODE_OPTIONS, plus WEB_EXT_CONFIG_DISCOVERY=false, which is --no-config-discovery, so no web-ext config file in
// the repo (sign runs there), in the home folder or in package.json can change what web-ext packages from the stage
// after the preflight checked it, and NO_UPDATE_NOTIFIER, as for lint. sign.ps1 ensures the same itself, for a run
// started by hand: it clears every WEB_EXT_* variable (this one included), NODE_OPTIONS and NODE_PATH, sets
// NO_UPDATE_NOTIFIER and passes --no-config-discovery. Nothing on that path installs a package, so M7's
// npm_config_offline guard is gone.
export function signCommand({ script, sourceDir, artifactsDir, channel, webExtBin, node, platform, env }) {
  return {
    command: platform === "win32" ? "powershell.exe" : "pwsh",
    args: [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
      "-SourceDir", sourceDir, "-ArtifactsDir", artifactsDir, "-Channel", channel,
      "-WebExtBin", webExtBin, "-WebExtVersion", WEB_EXT_VERSION, "-NodeExe", node,
    ],
    env: { ...childEnv(env, SIGN_STRIPPED_RE), WEB_EXT_CONFIG_DISCOVERY: "false", NO_UPDATE_NOTIFIER: "1" },
  };
}

// The user's keyring login: no token or host from the environment (see STRIPPED_RE), nothing added to the command.
export function ghCommand(args, { env }) {
  return { command: "gh", args: [...args], env: childEnv(env) };
}

function captured(result) {
  const text = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "");
  return { status: result.status, stdout: result.stdout ?? "", stderr: text(result.stderr), error: result.error ?? null };
}

export function createRunners({
  spawn = spawnSync, fetch = (url, init) => globalThis.fetch(url, init), platform = process.platform, env = process.env, node = process.execPath,
} = {}) {
  const start = ({ command, args, env: childEnvironment }, options) => spawn(command, args, childEnvironment ? { ...options, env: childEnvironment } : options);
  // npm is a .cmd file on Windows, which only a shell can start. Its arguments here are fixed words (no spaces, no
  // quotes), so the command line is simply joined.
  const tool = ({ command, args, env: childEnvironment }, options) => (platform === "win32"
    ? spawn([command, ...args].join(" "), { ...options, ...(childEnvironment ? { env: childEnvironment } : {}), shell: true })
    : start({ command, args, env: childEnvironment }, options));
  const quiet = { encoding: "utf8", maxBuffer: MAX_BUFFER, windowsHide: true };
  return {
    // (args, { cwd, input?, binary? }) -> { status, stdout, stderr, error }: input is written to git's stdin, and
    // binary keeps stdout as a Buffer (blob contents), else it is text. input goes as bytes: spawnSync encodes a string
    // input with `encoding`, and "buffer" is no text encoding.
    git: (args, { cwd, input, binary = false }) => captured(start(gitCommand(args), {
      cwd, ...quiet, ...(binary ? { encoding: "buffer" } : {}), ...(input === undefined ? {} : { input: Buffer.from(input) }),
    })),
    // Its output shown as it goes.
    npmTest: ({ cwd }) => captured(tool(npmTestCommand({ env }), { cwd, stdio: "inherit" })),
    // node itself, not through a shell, on every platform.
    lint: ({ sourceDir, bin }) => captured(start(lintCommand({ node, bin, env }), { cwd: sourceDir, ...quiet })),
    // Never windowsHide: Windows applies a hidden start to the first window the process shows, which would hide
    // sign.ps1's passphrase dialog until it times out.
    sign: ({ script, sourceDir, artifactsDir, channel, webExtBin, cwd }) => captured(start(
      signCommand({ script, sourceDir, artifactsDir, channel, webExtBin, node, platform, env }), { cwd, stdio: "inherit" },
    )),
    // (args) -> { status, stdout, stderr, error }
    gh: (args) => captured(start(ghCommand(args, { env }), quiet)),
    fetch: (url, init) => fetch(url, init),
  };
}

export const realRunners = createRunners();

export const RUNNER_NAMES = Object.keys(realRunners);
