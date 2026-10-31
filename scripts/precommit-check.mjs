#!/usr/bin/env node
// The pre-commit check (SPEC §5; notes/m7-contracts.md, "Pre-commit check"), run by scripts/git-hooks/pre-commit.
// It reads the staged content, not the working tree, and refuses the commit when it holds an Anthropic key, AMO
// credentials, real tab data, a session file or a local-only path. The program is lib/precommit-run.js, the rules
// live in lib/precommit-scan.js, the git calls in lib/precommit-git.js. Each refusal names the file and line and at
// most the first 8 characters of what matched.
//
//   node scripts/precommit-check.mjs        (exit 0: nothing found; 1: refused, or git couldn't be read)
//
// Install it with `npm run hooks` (scripts/install-hooks.mjs), once per clone: every branch and worktree then runs it.
//
// This file runs the check whenever it loads, however its path was spelled. It never asks whether it is the entry
// point: comparing paths for that skipped the check, exit 0, for spellings the comparison didn't foresee (a link to
// the script, a \\?\ prefix).

import { cli } from "./lib/precommit-run.js";

cli();
