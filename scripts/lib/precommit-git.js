// The pre-commit check's only contact with git: the staged paths and their staged bytes, read-only. Every function
// takes the git runner as its first argument, so tests hand in a stand-in and never run git.
//
// git(args) resolves to { code, stdout: Buffer, stderr: string } and never rejects for a non-zero exit.

import { spawn } from "node:child_process";

// Reads at most this many blobs at once: each is its own git process, and Windows starts them slowly.
export const READ_CONCURRENCY = 8;
export const STAGED_ARGS = Object.freeze(["diff", "--cached", "--name-only", "-z", "--diff-filter=d"]);

export function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
  });
}

// Why git failed, in one line: its own first line of stderr (a message about the repo, never file content).
function gitError(what, { code, stderr }) {
  const reason = String(stderr ?? "").split(/\r?\n/).find((line) => line.trim()) ?? "";
  return new Error(`${what} failed (git exited ${code})${reason ? `: ${reason.trim()}` : ""}`);
}

// The paths in the index that differ from HEAD (every path, before the first commit), deletions left out: removing a
// file never adds anything. -z keeps names with spaces, quotes or non-ASCII letters as they are.
export async function listStaged(git) {
  const result = await git([...STAGED_ARGS]);
  if (result.code !== 0) throw gitError("listing the staged files", result);
  return result.stdout.toString("utf8").split("\0").filter(Boolean);
}

// The staged bytes of one path. ":0:" names the index entry outright, so a path such as "1:x" can't be read as a
// stage number.
export async function readStaged(git, path) {
  const result = await git(["show", `:0:${path}`]);
  if (result.code !== 0) throw gitError(`reading the staged ${path}`, result);
  return result.stdout;
}

// [{ path, bytes }] in the order of `paths`, READ_CONCURRENCY at a time.
export async function readAllStaged(git, paths, concurrency = READ_CONCURRENCY) {
  const files = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const index = next++;
      files[index] = { path: paths[index], bytes: await readStaged(git, paths[index]) };
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  return files;
}
