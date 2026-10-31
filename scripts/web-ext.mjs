#!/usr/bin/env node
// The pinned web-ext (tools/web-ext/, installed from its committed lockfile by `npm run tools`), with the arguments
// given: `npm run lint:ext` is `node scripts/web-ext.mjs lint --source-dir extension --self-hosted`. It first checks
// that tools/web-ext/package.json and package-lock.json pin web-ext 10.7.0 to registry tarballs and that the installed
// tree is exactly the lockfile's; otherwise it prints one line saying to run `npm run tools`, exit 1. web-ext gets the
// release's cleaned environment, without any WEB_EXT_* variable: it names those it ignored on stderr, and the flags to
// pass instead (WEB_EXT_FIREFOX is --firefox).
//
// The program is scripts/lib/release-pin.js (main). This file only starts it, whenever it loads.

import { main } from "./lib/release-pin.js";

main();
