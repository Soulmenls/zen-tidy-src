// Where dev-only data lives. Real tabs and benchmark output stay OUTSIDE the repo, under
// %LOCALAPPDATA%\zen-tidy-dev, so they can never be committed.

import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function devDataDir(env, flag = "--out") {
  if (!env.LOCALAPPDATA) throw new Error(`LOCALAPPDATA is not set; pass ${flag}.`);
  return path.join(env.LOCALAPPDATA, "zen-tidy-dev");
}

// The path the OS will really write to: the deepest existing ancestor goes through realpath (which
// expands junctions, symlinks and 8.3 short names like SOULAY~1), the not-yet-created rest is kept.
export function realPath(target) {
  const resolved = path.resolve(target);
  const rest = [];
  let current = resolved;
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function lexicalRelative(target, parent) {
  const rel = path.relative(parent, target);
  if (rel === "") return rel;
  return !path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== ".." ? rel : null;
}

// `target`'s path below `parent` ("" for parent itself), or null when it is outside. Both the real
// and the lexical paths are checked, so a link can't make an inside path look outside.
export function relativeInside(target, parent) {
  return lexicalRelative(realPath(target), realPath(parent)) ?? lexicalRelative(path.resolve(target), path.resolve(parent));
}

// True when `target` is `parent` itself or somewhere below it.
export function isInside(target, parent = REPO_ROOT) {
  return relativeInside(target, parent) !== null;
}

// A timestamp that is safe in Windows file names: 2026-10-25T01-02-03-456Z.
export function fileStamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}
