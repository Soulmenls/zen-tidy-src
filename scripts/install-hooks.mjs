#!/usr/bin/env node
// `npm run hooks`: installs Zen Tidy's pre-commit check (scripts/git-hooks/pre-commit) into this repository's common
// hooks folder, where every branch and every linked worktree runs it, and unsets the core.hooksPath an earlier
// `npm run hooks` set (M7-SEC-4). Run it once per clone.
//
//   node scripts/install-hooks.mjs        (exit 0: installed; 1: refused, nothing changed, one line on stderr)
//
// The program is scripts/lib/install-hooks.js. This file only starts it, whenever it loads and however its path was
// spelled.

import { main } from "./lib/install-hooks.js";

main();
