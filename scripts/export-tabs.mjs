#!/usr/bin/env node
// Export the loose tabs from a Zen session file, read-only, as { title, url, lastAccessed } records
// for the benchmark and the dev self-test page. Query strings, fragments and URL credentials are
// stripped, from titles that are really addresses too. The output goes outside the repo and outside
// the profile (%LOCALAPPDATA%\zen-tidy-dev\real-tabs.json), and only counts are printed, never titles
// or URLs.
//
//   node scripts/export-tabs.mjs [--profile <dir>] [--out <file>] [--space <n>|largest]

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseMozLz4Json } from "./lib/mozlz4.js";
import { REPO_ROOT, devDataDir, isInside, relativeInside } from "./lib/dev-paths.js";

// Zen writes its own session file; Firefox's recovery file is the fallback for older builds.
export const SESSION_FILES = Object.freeze(["zen-sessions.jsonlz4", path.join("sessionstore-backups", "recovery.jsonlz4")]);

const USAGE = "Usage: node scripts/export-tabs.mjs [--profile <dir>] [--out <file>] [--space <n>|largest]";

function parseSpace(value) {
  if (value === "largest") return value;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error('--space needs a positive integer or "largest"');
  return n;
}

export function parseArgs(argv) {
  const opts = { profile: null, out: null, space: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--profile" || arg === "--out" || arg === "--space") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      opts[arg.slice(2)] = arg === "--space" ? parseSpace(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

// Minimal INI reader for installs.ini / profiles.ini: [section] and key=value lines.
export function parseIni(text) {
  const sections = {};
  let current = null;
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = sections[header[1]] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (current && eq > 0) current[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return sections;
}

function resolveProfilePath(zenDir, value, isRelative) {
  const p = value.replace(/[\\/]+/g, path.sep);
  if (isRelative === "0" || path.isAbsolute(p)) return p;
  return path.join(zenDir, p);
}

// Choose the default profile: installs.ini, then profiles.ini's [Install…] sections, then the
// profile marked Default=1, then the only profile. Returns null when it is ambiguous.
export function chooseProfile(zenDir, { installsIni = "", profilesIni = "" } = {}) {
  for (const section of Object.values(parseIni(installsIni))) {
    if (section.Default) return resolveProfilePath(zenDir, section.Default);
  }
  const profiles = parseIni(profilesIni);
  for (const [name, section] of Object.entries(profiles)) {
    if (name.startsWith("Install") && section.Default) return resolveProfilePath(zenDir, section.Default);
  }
  const entries = Object.entries(profiles).filter(([name, s]) => name.startsWith("Profile") && s.Path);
  const marked = entries.find(([, s]) => s.Default === "1");
  const chosen = marked ?? (entries.length === 1 ? entries[0] : null);
  return chosen ? resolveProfilePath(zenDir, chosen[1].Path, chosen[1].IsRelative) : null;
}

async function readTextIfExists(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function discoverProfile(env) {
  if (!env.APPDATA) throw new Error("APPDATA is not set; pass --profile <dir>.");
  const zenDir = path.join(env.APPDATA, "zen");
  const profile = chooseProfile(zenDir, {
    installsIni: await readTextIfExists(path.join(zenDir, "installs.ini")),
    profilesIni: await readTextIfExists(path.join(zenDir, "profiles.ini")),
  });
  if (!profile) throw new Error(`Couldn't find a default Zen profile under ${zenDir}; pass --profile <dir>.`);
  return profile;
}

async function exists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// Zen's session file may differ from Firefox's sessionstore: accept a top-level `tabs` array
// (Zen) and `windows[].tabs` (Firefox). Closed windows and closed tabs are ignored.
export function collectSessionTabs(session) {
  const topLevel = Array.isArray(session?.tabs) ? session.tabs : [];
  const windows = Array.isArray(session?.windows) ? session.windows : [];
  const fromWindows = windows.flatMap((w) => (Array.isArray(w?.tabs) ? w.tabs : []));
  const layout = topLevel.length && fromWindows.length ? "both" : topLevel.length ? "tabs" : fromWindows.length ? "windows" : "none";
  let tabs = [...topLevel, ...fromWindows].filter((t) => t && typeof t === "object");
  // If both layouts are present they may describe the same tabs; keep the first copy.
  if (layout === "both") {
    const seen = new Set();
    tabs = tabs.filter((tab) => {
      const entry = currentEntry(tab);
      const key = tab.zenSyncId ?? `${entry?.url}|${tab.lastAccessed}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return { tabs, layout, windowCount: windows.length };
}

// `index` is 1-based into `entries` (the tab's back/forward history).
export function currentEntry(tab) {
  const entries = Array.isArray(tab?.entries) ? tab.entries : [];
  if (!entries.length) return null;
  const index = Number.isInteger(tab.index) ? Math.min(Math.max(tab.index, 1), entries.length) : entries.length;
  return entries[index - 1] ?? null;
}

// http(s) only; drops the query, fragment and any user:password. Returns null for other schemes.
export function stripUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  parsed.search = "";
  parsed.hash = "";
  parsed.username = "";
  parsed.password = "";
  return parsed.href;
}

// Firefox labels an untitled page with its URL minus the scheme and a leading "www.".
function urlLabel(url) {
  return url.replace(/^https?:\/\//, "").replace(/^www\./, "");
}

// URL-like tokens, the same rules as payload.js's payloadTitle. A bare "#123" or "C#" is not one.
const URL_TOKEN_RES = [
  /[a-z][a-z0-9+.-]*:\/\//i, //                                     scheme://…
  /\bwww\.[a-z0-9-]+\.[a-z]/i, //                                   www.host
  /(?:^|[^\w@.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?[/?#]\S/i, //   host/path, host?query, host#frag
  /\/[^\s?]*\?[^\s=]*=/, //                                         path?key=value
  /\/[^\s#]*#\S/, //                                                path#fragment
];
// Pages control their titles, so the regexes only scan the start.
const TITLE_SCAN_LENGTH = 512;

function decodeSafely(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// True when a title is (or contains) an address, or any part stripUrl removed from this tab's URL.
// Firefox titles an untitled page with its address, query and fragment included.
export function titleHasAddress(title, rawUrl) {
  if (URL_TOKEN_RES.some((re) => re.test(title.slice(0, TITLE_SCAN_LENGTH)))) return true;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  const forms = [rawUrl, urlLabel(rawUrl)];
  // The prefix stays on, so "#top" doesn't catch "Top 10 …".
  if (parsed.search.length > 3) forms.push(parsed.search);
  if (parsed.hash.length > 3) forms.push(parsed.hash);
  for (const part of [parsed.username, parsed.password]) if (part.length >= 4) forms.push(part);
  const lower = title.toLowerCase();
  return forms.flatMap((form) => [form, decodeSafely(form)]).some((form) => lower.includes(form.toLowerCase()));
}

function isGrouped(tab) {
  return tab.groupId !== undefined && tab.groupId !== null && tab.groupId !== "" && tab.groupId !== -1;
}

// Why a tab is not loose, or "loose".
export function classifyTab(tab) {
  if (tab.zenEssential) return "essential";
  if (tab.pinned) return "pinned";
  if (isGrouped(tab)) return "grouped";
  if (tab.zenIsGlance) return "glance";
  const entry = currentEntry(tab);
  if (!entry?.url) return "noUrl";
  if (!stripUrl(entry.url)) return "nonHttp";
  return "loose";
}

// A tidy only sees the active Space, so Spaces are numbered for --space: 1..n in the order of the
// session's `spaces` list (Zen's sidebar order), then by first appearance. Only the numbers are
// ever exported or printed, never Space names or ids.
function numberSpaces(session, tabs) {
  const numbers = new Map();
  const add = (id) => {
    if (typeof id === "string" && id && !numbers.has(id)) numbers.set(id, numbers.size + 1);
  };
  for (const space of Array.isArray(session?.spaces) ? session.spaces : []) add(space?.uuid);
  for (const tab of tabs) add(tab.zenWorkspace);
  return numbers;
}

function pickSpace(space, looseBySpace) {
  if (space === null) return null;
  if (space === "largest") {
    let best = null;
    for (const [n, count] of looseBySpace) if (count > 0 && (best === null || count > looseBySpace.get(best))) best = n;
    return best;
  }
  if (!looseBySpace.has(space)) {
    const known = looseBySpace.size ? `Spaces 1-${looseBySpace.size}` : "no Space information";
    throw new Error(`Space ${space} not found; the session has ${known}.`);
  }
  return space;
}

// options.space: null (every Space), a Space number, or "largest". Returns the exported records plus
// counts: per kind of skipped tab, and loose tabs per Space number (`spaces`, `noSpace`).
export function extractLooseTabs(session, { space = null } = {}) {
  const { tabs, layout, windowCount } = collectSessionTabs(session);
  const numbers = numberSpaces(session, tabs);
  const looseBySpace = new Map([...numbers.values()].map((n) => [n, 0]));
  const counts = { total: tabs.length, loose: 0, essential: 0, pinned: 0, grouped: 0, glance: 0, noUrl: 0, nonHttp: 0 };
  let noSpace = 0;
  const loose = [];
  for (const tab of tabs) {
    const kind = classifyTab(tab);
    counts[kind]++;
    if (kind !== "loose") continue;
    const entry = currentEntry(tab);
    const url = stripUrl(entry.url);
    const raw = typeof entry.title === "string" ? entry.title.trim() : "";
    const title = raw && !titleHasAddress(raw, entry.url) ? raw : urlLabel(url);
    const n = numbers.get(tab.zenWorkspace) ?? null;
    if (n === null) noSpace++;
    else looseBySpace.set(n, looseBySpace.get(n) + 1);
    loose.push({ space: n, record: { title, url, lastAccessed: Number.isFinite(tab.lastAccessed) ? tab.lastAccessed : 0 } });
  }
  // "largest" without any Space information keeps everything: it is all one Space as far as we know.
  const chosen = pickSpace(space, looseBySpace);
  const out = loose.filter((t) => chosen === null || t.space === chosen).map((t) => t.record);
  const spaces = [...looseBySpace].map(([n, count]) => ({ space: n, loose: count }));
  return { tabs: out, counts, layout, windowCount, spaces, noSpace, space: chosen };
}

// Use the first session file that holds tabs. Zen's own file may carry only Spaces/folders metadata
// (its format is unverified), so a file without tabs, or one that can't be read, falls through to
// the next instead of replacing a previous export with nothing.
export async function readSession(profileDir, log = () => {}) {
  const problems = [];
  for (const name of SESSION_FILES) {
    const file = path.join(profileDir, name);
    if (!(await exists(file))) continue;
    const base = path.basename(file);
    let session;
    try {
      // Decode and parse errors never quote the session's content.
      session = parseMozLz4Json(await readFile(file), base);
    } catch (error) {
      problems.push(`${base}: ${error.message}`);
      continue;
    }
    if (collectSessionTabs(session).layout !== "none") return { file, session };
    // Structure only (key names), to adapt the reader if Zen changes its format.
    const keys = session && typeof session === "object" && !Array.isArray(session) ? Object.keys(session).join(", ") : "";
    log(`${base} has no tabs (layout: none). Top-level keys: ${keys || "(none)"}`);
    problems.push(`${base}: no tabs`);
  }
  if (!problems.length) throw new Error(`No session file in the profile (looked for ${SESSION_FILES.join(", ")}).`);
  throw new Error(`No usable session file, so nothing was written (${problems.join("; ")}).`);
}

// Real tabs must never land in the repo, except under the git-ignored test/fixtures/real-* names.
export function isAllowedOutput(file, repoRoot = REPO_ROOT) {
  const rel = relativeInside(file, repoRoot);
  if (rel === null) return true;
  return path.dirname(rel) === path.join("test", "fixtures") && path.basename(rel).startsWith("real-");
}

// The profile is only ever read: writing there could replace the user's real session file.
function checkNotInProfile(outFile, dir) {
  if (dir && isInside(outFile, dir)) {
    throw new Error("Refusing to write inside the Zen profile folder; export-tabs only reads it. Choose an --out outside it.");
  }
}

export function defaultOutPath(env) {
  return path.join(devDataDir(env, "--out <file>"), "real-tabs.json");
}

function spaceSummary(spaces, noSpace) {
  if (!spaces.length) return null;
  const list = spaces.map((s) => `Space ${s.space}: ${s.loose}`).join(", ");
  return `Spaces: ${spaces.length} (loose tabs per Space: ${list}; without a Space: ${noSpace}). A tidy sees one Space; --space <n> or --space largest exports just one.`;
}

export async function main(argv, { env = process.env, log = console.log, now = () => new Date() } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  const outFile = path.resolve(opts.out ?? defaultOutPath(env));
  if (!isAllowedOutput(outFile)) {
    throw new Error("Refusing to write real tabs inside the repo. Use a path outside it, or test/fixtures/real-*.json.");
  }
  if (env.APPDATA) checkNotInProfile(outFile, path.join(env.APPDATA, "zen"));
  const profileDir = opts.profile ? path.resolve(opts.profile) : await discoverProfile(env);
  checkNotInProfile(outFile, profileDir);

  const { file: sessionFile, session } = await readSession(profileDir, log);
  const { tabs, counts, layout, windowCount, spaces, noSpace, space } = extractLooseTabs(session, { space: opts.space });

  await mkdir(path.dirname(outFile), { recursive: true });
  const doc = { version: 1, source: path.basename(sessionFile), exportedAt: now().toISOString(), space, tabs };
  await writeFile(outFile, JSON.stringify(doc, null, 1) + "\n", "utf8");

  log(`Read ${path.basename(sessionFile)} (layout: ${layout}, windows: ${windowCount}): ${counts.total} tabs.`);
  const summary = spaceSummary(spaces, noSpace);
  if (summary) log(summary);
  log(
    `Exported ${tabs.length} loose tabs${space === null ? "" : ` from Space ${space}`}. Skipped: ${counts.pinned} pinned, ` +
      `${counts.essential} essentials, ${counts.grouped} grouped, ${counts.glance} glance, ${counts.nonHttp} non-http(s), ` +
      `${counts.noUrl} without a URL.`,
  );
  log(`Wrote ${outFile}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(`export-tabs: ${error.message}`);
      process.exitCode = 1;
    },
  );
}
