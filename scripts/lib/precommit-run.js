// The pre-commit program (scripts/precommit-check.mjs runs cli()): main reads the staged content through
// lib/precommit-git.js and checks it with lib/precommit-scan.js; cli turns main's answer into the exit code. Tests
// import this module, never the entry script, which runs the check as soon as it loads.

import { listStaged, readAllStaged, runGit } from "./precommit-git.js";
import { displayPath, formatFinding, scanStaged } from "./precommit-scan.js";

const printError = (line) => console.error(line);

// main({ git, err }) resolves to the exit code. git is lib/precommit-git.js's runner shape; err prints one line.
export async function main({ git = runGit, err = printError } = {}) {
  let files;
  try {
    files = await readAllStaged(git, await listStaged(git));
  } catch (error) {
    // The message may name a path (git's own line too), and a path may hold a key.
    err(`pre-commit: ${displayPath(String(error?.message))}. The commit was refused.`);
    return 1;
  }
  const findings = scanStaged(files);
  if (!findings.length) return 0;
  for (const found of findings) err(`pre-commit: ${formatFinding(found)}`);
  const count = new Set(findings.map((found) => found.path)).size;
  err(`pre-commit: refused the commit: ${findings.length} problem${findings.length === 1 ? "" : "s"} in ${count} `
    + `file${count === 1 ? "" : "s"}. Take the secret or the file out of the commit (git restore --staged <file>), `
    + "then commit again.");
  return 1;
}

// The program around main: the exit code is 1 from the start, so a check that never finishes (or a process that ends
// first) refuses the commit, and only main resolving to exactly 0 lets it through. An error main didn't expect refuses
// it too, in one line. setExitCode stands for `process.exitCode = code`; it is called with 1 first, then the result.
export async function cli({ check = main, err = printError, setExitCode = (code) => (process.exitCode = code) } = {}) {
  setExitCode(1);
  let code;
  try {
    code = await check();
  } catch (error) {
    err(`pre-commit: ${displayPath(String(error?.message))}. The commit was refused.`);
    code = 1;
  }
  setExitCode(code === 0 ? 0 : 1);
}
