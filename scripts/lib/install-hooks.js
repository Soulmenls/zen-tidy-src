// `npm run hooks` (scripts/install-hooks.mjs runs main()): installs the pre-commit check where every checkout of this
// repository runs it (M7-SEC-4). The hook goes into the common hooks folder (`git rev-parse --git-common-dir`/hooks),
// which every branch and every linked worktree shares, instead of a relative core.hooksPath: git resolves that against
// each working tree's top and silently skips a hook it doesn't find there, so a checkout of a branch without
// scripts/git-hooks/ (main before M7, `git worktree add` of an older commit) committed with no check at all. The hook
// is scripts/git-hooks/pre-commit, a shim that runs the checkout's own scripts/precommit-check.mjs and refuses the
// commit when that checkout has none.
//
// It changes nothing until every check passed: the shim is the shim, this is a git repository, no other core.hooksPath
// would make git ignore the hook, and the hook file is absent or an earlier copy of the shim (any other hook is left
// alone). Then it writes the hook (LF line endings, executable) and unsets the core.hooksPath `scripts/git-hooks` an
// earlier `npm run hooks` set in this repository's config.

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SHIM_FILE = fileURLToPath(new URL("../git-hooks/pre-commit", import.meta.url));
// The shim's second line: a pre-commit hook holding it is an earlier copy of the shim, which may be replaced.
export const SHIM_MARKER = "# zen-tidy pre-commit shim";
// The core.hooksPath the first `npm run hooks` set: `git config core.hooksPath scripts/git-hooks`.
const OUR_HOOKS_PATH_RE = /^(?:\.[\\/])?scripts[\\/]git-hooks[\\/]?$/;

// (args, { cwd }) -> { status, stdout, stderr }, text out.
export function runGit(args, { cwd }) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error ?? null };
}

function gitOut(git, args, cwd, { missOk = false } = {}) {
  const result = git(args, { cwd });
  if (result.status === 0) return result.stdout;
  if (missOk && result.status === 1) return null;
  const reason = result.error ? result.error.message : String(result.stderr ?? "").split(/\r?\n/).find((line) => line.trim())?.trim() || `exit ${result.status}`;
  throw new Error(`git ${args.join(" ")} failed: ${reason}`);
}

// Installs the shim for the repository around `cwd`. Returns { hook, unset } (the hook's path, whether core.hooksPath
// was unset); throws, having changed nothing, when a check fails.
export function installHooks({ git = runGit, cwd = process.cwd(), shim = readFileSync(SHIM_FILE, "utf8"), log = console.log } = {}) {
  const text = shim.replace(/\r\n/g, "\n");
  if (!text.startsWith("#!/bin/sh\n") || text.split("\n")[1] !== SHIM_MARKER) throw new Error(`${SHIM_FILE} is not the pre-commit shim`);
  const common = gitOut(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim();

  // Every core.hooksPath in effect, with its config's scope: only this repository's own `scripts/git-hooks` goes.
  const hooksPaths = (gitOut(git, ["config", "--show-scope", "--get-all", "core.hooksPath"], cwd, { missOk: true }) ?? "")
    .split(/\r?\n/).filter(Boolean).map((line) => {
      const tab = line.indexOf("\t");
      return { scope: line.slice(0, tab), value: line.slice(tab + 1).trim() };
    });
  const other = hooksPaths.find(({ scope, value }) => scope !== "local" || !OUR_HOOKS_PATH_RE.test(value));
  if (other) {
    throw new Error(`core.hooksPath is set to ${other.value} in the ${other.scope} git config, so git would never run a hook from ${path.join(common, "hooks")}: `
      + `unset it (git config --${other.scope} --unset core.hooksPath) or add the check to that folder yourself, then run npm run hooks again`);
  }

  const hook = path.join(common, "hooks", "pre-commit");
  if (existsSync(hook) && readFileSync(hook, "utf8").replace(/\r\n/g, "\n").split("\n")[1] !== SHIM_MARKER) {
    throw new Error(`${hook} is another pre-commit hook, left as it is: add \`node scripts/precommit-check.mjs\` to it by hand, `
      + "or move it away and run npm run hooks again");
  }
  mkdirSync(path.dirname(hook), { recursive: true });
  writeFileSync(hook, text, { mode: 0o755 });
  chmodSync(hook, 0o755);
  const unset = hooksPaths.length > 0;
  if (unset) gitOut(git, ["config", "--local", "--unset", "core.hooksPath"], cwd);
  log(`pre-commit check installed: ${hook}${unset ? " (core.hooksPath scripts/git-hooks unset)" : ""}`);
  log("Every branch and worktree of this repository runs it; a checkout without scripts/precommit-check.mjs refuses commits "
    + "(git commit --no-verify is the deliberate way past it).");
  return { hook, unset };
}

// The command line: one line on stderr and exit 1 on failure.
export function main() {
  try {
    installHooks();
  } catch (error) {
    console.error(`hooks: ${String(error?.message ?? error).replace(/\s*\r?\n\s*/g, " ")}`);
    process.exitCode = 1;
  }
}
