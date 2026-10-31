// Decoder for Mozilla's .jsonlz4 / .mozlz4 files (session store, Zen sessions).
// Layout: the 8-byte magic "mozLz40\0", the decompressed size as a 4-byte little-endian uint32,
// then one raw LZ4 *block* (not the LZ4 frame format). Pure JS so it needs no native module.

import { parseJsonQuietly } from "./quiet-json.js";

export const MOZLZ4_MAGIC = Object.freeze([0x6d, 0x6f, 0x7a, 0x4c, 0x7a, 0x34, 0x30, 0x00]); // "mozLz40\0"
const HEADER_LENGTH = MOZLZ4_MAGIC.length + 4;
// Session files are a few MB; anything near this is corrupt, not a real session.
const MAX_OUTPUT = 1 << 30;

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError("Expected a Uint8Array, Buffer or ArrayBuffer");
}

export function hasMozLz4Magic(input) {
  const bytes = toBytes(input);
  return bytes.length >= MOZLZ4_MAGIC.length && MOZLZ4_MAGIC.every((b, i) => bytes[i] === b);
}

// LZ4 length fields: a nibble of 15 means "add the following bytes until one is not 255".
function readLength(src, pos, base) {
  let length = base;
  if (base !== 15) return [length, pos];
  let byte;
  do {
    if (pos >= src.length) throw new Error("LZ4: truncated length");
    byte = src[pos++];
    length += byte;
  } while (byte === 255);
  return [length, pos];
}

// Decode one LZ4 block into exactly `outputSize` bytes.
export function decompressLz4Block(input, outputSize) {
  const src = toBytes(input);
  if (!Number.isInteger(outputSize) || outputSize < 0 || outputSize > MAX_OUTPUT) {
    throw new RangeError(`LZ4: bad output size ${outputSize}`);
  }
  const out = new Uint8Array(outputSize);
  let ip = 0;
  let op = 0;

  while (ip < src.length) {
    const token = src[ip++];

    let literals;
    [literals, ip] = readLength(src, ip, token >>> 4);
    if (ip + literals > src.length) throw new Error("LZ4: literals run past the input");
    if (op + literals > outputSize) throw new Error("LZ4: literals run past the declared size");
    out.set(src.subarray(ip, ip + literals), op);
    ip += literals;
    op += literals;

    // The last sequence carries literals only.
    if (ip === src.length) break;

    if (ip + 2 > src.length) throw new Error("LZ4: truncated match offset");
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error(`LZ4: bad match offset ${offset} at output ${op}`);

    let matchLength;
    [matchLength, ip] = readLength(src, ip, token & 0x0f);
    matchLength += 4;
    if (op + matchLength > outputSize) throw new Error("LZ4: match runs past the declared size");

    // Byte by byte, because a match may overlap the bytes it is producing (offset < length).
    let from = op - offset;
    for (let i = 0; i < matchLength; i++) out[op++] = out[from++];
  }

  if (op !== outputSize) throw new Error(`LZ4: decoded ${op} bytes, header says ${outputSize}`);
  return out;
}

// Decode a whole mozLz4 file. Returns the decompressed bytes (a Uint8Array).
export function decompressMozLz4(input) {
  const bytes = toBytes(input);
  if (bytes.length < HEADER_LENGTH || !hasMozLz4Magic(bytes)) {
    throw new Error("Not a mozLz4 file (missing mozLz40 header)");
  }
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MOZLZ4_MAGIC.length, true);
  return decompressLz4Block(bytes.subarray(HEADER_LENGTH), size);
}

// Convenience for the tools: decode and parse a .jsonlz4 file's contents. A parse error names only
// `label` and a position, never the session text around it.
export function parseMozLz4Json(input, label = "session file") {
  return parseJsonQuietly(new TextDecoder("utf-8", { fatal: true }).decode(decompressMozLz4(input)), label);
}
