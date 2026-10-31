// Deterministic zip writer and a small reader, shared by build-dev.mjs (dev xpi) and release.mjs (unsigned
// package, CSS kit, signed-xpi check). The same files always give the same bytes: entries in code-unit order of
// their forward-slash paths (one name, by default manifest.json, first so it sits at the root of the archive), a
// fixed timestamp, no directory entries, no extra fields.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { deflateRawSync, inflateRawSync, crc32 } from "node:zlib";

// Fixed entry timestamp (2026-01-01 00:00).
export const DOS_TIME = 0;
export const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const UTF8_FLAG = 0x0800;

// Forward-slash paths of the regular files below dir, sorted. Links and other non-files are skipped.
export function listFiles(dir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...listFiles(path.join(dir, entry.name), rel));
    else if (entry.isFile()) files.push(rel);
  }
  return prefix ? files : files.sort(byCodeUnit);
}

export function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// names sorted by code unit (never by locale, which differs between machines), `first` moved to the front.
export function entryOrder(names, first = "manifest.json") {
  return [...names].sort((a, b) => (a === first ? -1 : b === first ? 1 : byCodeUnit(a, b)));
}

// entries: [{ name, data }] in archive order. Deflate (or stored when deflate doesn't help), UTF-8 names.
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  const seen = new Set();
  let offset = 0;
  for (const { name, data } of entries) {
    if (seen.has(name)) throw new Error(`zip: duplicate entry ${name}`);
    seen.add(name);
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // the rest (extra, comment, disk, attributes) stays 0
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIG, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// files: Map or [[name, data]] -> { zip, count, names }, in entryOrder.
export function zipFiles(files, { first = "manifest.json" } = {}) {
  const map = files instanceof Map ? files : new Map(files);
  const names = entryOrder(map.keys(), first);
  return { zip: writeZip(names.map((name) => ({ name, data: map.get(name) }))), count: names.length, names };
}

// Every regular file below dir except the `exclude` paths.
export function zipDir(dir, { exclude = [], first = "manifest.json" } = {}) {
  const skip = new Set(exclude);
  const files = new Map();
  for (const name of listFiles(dir)) {
    if (!skip.has(name)) files.set(name, readFileSync(path.join(dir, ...name.split("/"))));
  }
  const { zip, count } = zipFiles(files, { first });
  return { zip, count };
}

// buffer -> Map(name -> Buffer) through the central directory (so data descriptors don't matter). Stored and
// deflate only; throws on anything else, on encryption, ZIP64, duplicate names or a CRC mismatch. Directory
// entries (names ending in "/") are kept, with empty data.
export function readZip(buffer) {
  const searchFrom = Math.max(0, buffer.length - 22 - 0xffff);
  let endAt = -1;
  for (let at = buffer.length - 22; at >= searchFrom; at--) {
    if (buffer.readUInt32LE(at) === END_SIG) {
      endAt = at;
      break;
    }
  }
  if (endAt < 0) throw new Error("zip: no end-of-central-directory record");
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  if (count === 0xffff || at === 0xffffffff) throw new Error("zip: ZIP64 archives are not supported");
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_SIG) throw new Error("zip: bad central directory");
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    if (flags & 1) throw new Error(`zip: ${name} is encrypted`);
    if (entries.has(name)) throw new Error(`zip: duplicate entry ${name}`);
    if (localAt + 30 > buffer.length || buffer.readUInt32LE(localAt) !== LOCAL_SIG) throw new Error(`zip: bad local header for ${name}`);
    const start = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    if (start + compressedSize > buffer.length) throw new Error(`zip: ${name} runs past the end of the archive`);
    const raw = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`zip: ${name} uses compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`zip: ${name} fails its CRC or size check`);
    entries.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
