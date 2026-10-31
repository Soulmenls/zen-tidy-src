#!/usr/bin/env node
// Release pipeline (notes/m7-contracts.md): turns the committed extension/ into a signed, verified GitHub release
// that Zen auto-updates from. Runs on this PC only. Prints paths, counts, versions and hashes, never a secret; every
// failure is one line, exit 1.
//
//   node scripts/release.mjs bump <ver>                     sets manifest.json and package.json versions, nothing else
//   node scripts/release.mjs check                          preflight only: no network, writes only under dist/
//   node scripts/release.mjs build [--notes <file>]         preflight, stage, lint, unsigned package and drafts of
//                                                           updates.json, SHA256SUMS, RELEASE-NOTES.md, the CSS kit
//   node scripts/release.mjs sign --confirm <ver>           build, then sign.ps1 UPLOADS the stage to Mozilla, then
//                                                           the signed xpi is verified and the files finalised
//   node scripts/release.mjs publish --confirm <ver>        the GitHub release from the signed files (UPLOADS)
//   node scripts/release.mjs verify --confirm <ver>         publish's last checks again, read-only, for a published
//                                                           release they could not confirm yet
//   node scripts/release.mjs local-test --update-url <http://127.0.0.1:PORT/...> --version <ver> --out <dir>
//                                                           an UNSIGNED xpi for the throwaway update test only
//
// --confirm must equal the manifest version (verify's names the newest published release in the ledger). build, sign
// and publish package HEAD's extension/ and CSS kit, never the working tree's. check, build, sign, publish and verify
// take --ledger <file> (default %LOCALAPPDATA%\zen-tidy-dev\releases.json); local-test alone takes --skip-tests and
// builds from the working tree. Output: dist/release/<ver>/.
//
// The program is scripts/lib/release-cli.js. This file only starts it, whenever it loads and however its path was
// spelled.

import { main } from "./lib/release-cli.js";

main();
