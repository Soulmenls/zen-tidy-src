// Release files (m7-contracts, "Release files"): updates.json, SHA256SUMS, RELEASE-NOTES.md and the CSS kit.
// `build` writes drafts (no signed xpi yet); `sign` writes them again with the signed xpi's hash.

import { createHash } from "node:crypto";

import { PRODUCT_ID, assetUrl, cssKitName } from "./release-config.js";
import { zipFiles } from "./zip.js";

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

// A draft's hash: Firefox rejects it, and publish refuses anything but the signed xpi's.
export const DRAFT_HASH = "sha256:pending-signature";

// Firefox's update manifest, listing only this version (Firefox picks the best compatible entry; older ones
// would only add risk). xpiSha256 null writes the draft hash.
export function updatesJson({ version, xpiSha256, strictMinVersion }) {
  const manifest = {
    addons: {
      [PRODUCT_ID]: {
        updates: [{
          version,
          update_link: assetUrl(version),
          update_hash: xpiSha256 ? `sha256:${xpiSha256}` : DRAFT_HASH,
          applications: { gecko: { strict_min_version: strictMinVersion } },
        }],
      },
    },
  };
  return JSON.stringify(manifest, null, 2) + "\n";
}

// "<hex>  <name>" per asset, as sha256sum writes them.
export function sumsText(entries) {
  return entries.map(({ name, sha256: hex }) => `${hex}  ${name}\n`).join("");
}

// The line publish refuses: no --notes was given, so the user-facing changes are still to be written.
export const NOTES_PLACEHOLDER = "<!-- release.mjs: no --notes file yet. Replace this line with the user-facing changes. -->";

// "first" (no published release before), "changed" or "unchanged" against the previous release's CSS hash.
export function cssState(previous, cssSha256) {
  if (!previous) return "first";
  return previous.cssSha256 === cssSha256 ? "unchanged" : "changed";
}

function cssNote(version, css, previousVersion) {
  const kit = cssKitName(version);
  if (css === "first") {
    return `The folder look (optional) is a separate download, \`${kit}\`. Unzip it, close Zen and run \`scripts\\setup-css.ps1\`; `
      + "the README.txt inside has the exact install and uninstall commands.";
  }
  if (css === "changed") {
    return `**Re-run setup-css.ps1**: zen-tidy.css changed in this version. Download \`${kit}\`, close Zen and run the install `
      + "command from its README.txt again.";
  }
  return `The folder look (zen-tidy.css) is unchanged since ${previousVersion}.`;
}

export function releaseNotes({ version, date, changes, sums, css, previousVersion = null }) {
  return [
    `# Zen Tidy ${version}`,
    "",
    `Released ${date}.`,
    "",
    "## Changes",
    "",
    (changes ?? NOTES_PLACEHOLDER).trim(),
    "",
    "## Folder look",
    "",
    cssNote(version, css, previousVersion),
    "",
    "## SHA-256",
    "",
    "```",
    sums.trimEnd(),
    "```",
    "",
    "Check a download with `(Get-FileHash <file> -Algorithm SHA256).Hash -eq '<hash from its line>'` in PowerShell: True means",
    "it matches these lines (also in the release's SHA256SUMS file). The letter case doesn't matter: PowerShell prints",
    "capitals, these lines are lowercase, and -eq ignores the difference.",
    "",
  ].join("\n");
}

// README.txt of the CSS kit: Windows line endings, ASCII only (the releases repo has no source to clone).
export function cssKitReadme(version) {
  const command = (extra) => `     powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\setup-css.ps1 -ProfilePath "<profile folder>"${extra}`;
  return [
    `Zen Tidy ${version}: folder look for tidy groups (optional)`,
    "",
    "This kit makes Zen Tidy's tab groups look and behave like Zen folders: each group shows its icon, and",
    "collapsing a group hides its tabs. It installs one stylesheet into one Zen profile. Windows only",
    "(Windows PowerShell 5.1 or PowerShell 7).",
    "",
    "Contents",
    "  css\\zen-tidy.css         the stylesheet",
    "  scripts\\setup-css.ps1    installs it in a profile, and takes it out again",
    "  README.txt               this file",
    "",
    "Install",
    "  1. Unzip this file into a folder of its own. Keep css\\ and scripts\\ side by side.",
    "  2. In Zen, open about:support and copy the Profile Folder path.",
    "  3. Close Zen. The script refuses while that profile is open.",
    "  4. Open PowerShell in the unzipped folder and see what the script would change, without writing anything:",
    "",
    command(" -WhatIf"),
    "",
    "  5. Run the same command without -WhatIf, then start Zen.",
    "",
    "  It backs up userChrome.css and user.js before changing them, and it is safe to run again.",
    "",
    "Update",
    "  When a release's notes say \"Re-run setup-css.ps1\", download that release's zen-tidy-css zip and run the",
    "  install command again, with Zen closed.",
    "",
    "Uninstall",
    "  Close Zen, then:",
    "",
    command(" -Uninstall"),
    "",
    "  It removes only what the install added; the backups are kept.",
    "",
  ].join("\r\n");
}

// zen-tidy-css-<ver>.zip: the stylesheet, the setup script and the README, deterministic like every package.
export function cssKitZip({ version, css, setup }) {
  return zipFiles([
    ["README.txt", Buffer.from(cssKitReadme(version), "ascii")],
    ["css/zen-tidy.css", css],
    ["scripts/setup-css.ps1", setup],
  ], { first: "README.txt" }).zip;
}
