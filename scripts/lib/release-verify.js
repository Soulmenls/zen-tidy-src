// Offline check of a signed xpi (m7-contracts, "Signing"): a zip whose entries outside META-INF/ are exactly the
// staged files, byte for byte except manifest.json (below), with Mozilla's five signature files, and whose manifest
// names the product id and the version. It proves the package is ours and complete; the signature itself is
// Firefox's to verify.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { PRODUCT_ID, SIGNATURE_FILES } from "./release-config.js";
import { sha256 } from "./release-files.js";
import { byCodeUnit, readZip } from "./zip.js";

// Strict UTF-8 that keeps a BOM, so JSON.parse refuses it rather than reading past it.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function parsedJson(buffer) {
  try {
    return { value: JSON.parse(utf8.decode(buffer)) };
  } catch {
    return null;
  }
}

// AMO writes manifest.json out again when it signs (two-space indent, no final newline: 0.1.0's signed xpi), so the
// manifest is the staged one when both parse to the same value. Every other file must be the same bytes.
function sameEntry(name, signed, staged) {
  if (signed.equals(staged)) return true;
  if (name !== "manifest.json") return false;
  const a = parsedJson(signed);
  const b = parsedJson(staged);
  return a !== null && b !== null && isDeepStrictEqual(a.value, b.value);
}

export function signedXpiProblems(buffer, stageFiles, version) {
  let entries;
  try {
    entries = readZip(buffer);
  } catch (error) {
    return [`not a readable zip (${error.message})`];
  }
  const problems = [];
  const missingSignatures = SIGNATURE_FILES.filter((name) => !entries.has(name));
  if (missingSignatures.length) problems.push(`no ${missingSignatures.join(", ")}`);
  // Directory entries carry no file; some zip writers add them.
  const files = [...entries.keys()].filter((name) => !name.startsWith("META-INF/") && !name.endsWith("/"));
  const extra = files.filter((name) => !stageFiles.has(name));
  const missing = [...stageFiles.keys()].filter((name) => !entries.has(name));
  const changed = files.filter((name) => stageFiles.has(name) && !sameEntry(name, entries.get(name), stageFiles.get(name)));
  if (extra.length) problems.push(`entries not in the stage: ${extra.slice(0, 5).join(", ")}`);
  if (missing.length) problems.push(`staged files missing: ${missing.slice(0, 5).join(", ")}`);
  if (changed.length) problems.push(`entries that differ from the stage: ${changed.slice(0, 5).join(", ")}`);
  let manifest = null;
  try {
    manifest = JSON.parse(entries.get("manifest.json")?.toString("utf8") ?? "null");
  } catch {
    manifest = null;
  }
  if (manifest?.browser_specific_settings?.gecko?.id !== PRODUCT_ID) problems.push(`its manifest's id is not ${PRODUCT_ID}`);
  if (manifest?.version !== version) problems.push(`its manifest's version is not ${version}`);
  return problems;
}

// The signed xpis in signedDir (web-ext names them after AMO's file, such as <hash>-<version>.xpi), each with
// its problems. found: the first that verifies, or null.
export function findSignedXpi(signedDir, stageFiles, version) {
  const checked = [];
  if (!existsSync(signedDir)) return { found: null, checked };
  for (const name of readdirSync(signedDir).filter((file) => file.toLowerCase().endsWith(".xpi")).sort(byCodeUnit)) {
    const file = path.join(signedDir, name);
    if (!statSync(file).isFile()) continue;
    const data = readFileSync(file);
    checked.push({ name, file, data, problems: signedXpiProblems(data, stageFiles, version) });
  }
  const ok = checked.find((item) => item.problems.length === 0);
  return { found: ok ? { name: ok.name, file: ok.file, data: ok.data, sha256: sha256(ok.data) } : null, checked };
}
