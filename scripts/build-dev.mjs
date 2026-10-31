#!/usr/bin/env node
// Dev build: copies extension/ into a git-ignored folder (default dist-dev/), switches it to the dev
// gecko id, adds the self-test page and zips it into <out>.xpi for the Zen integration harness.
// With --mock <port> the build talks to test/integration/mock-anthropic.mjs on 127.0.0.1 instead of
// api.anthropic.com. extension/ itself is only ever read; release builds never go through here.
//
//   node scripts/build-dev.mjs [--mock <port>] [--out <dir>]
//
// Prints only paths and counts; a failure is one reason and the usage on stderr, exit 1.
//
// The program is scripts/lib/build-dev.js. This file only starts it, whenever it loads and however its path was
// spelled.

import { main } from "./lib/build-dev.js";

main();
