// Invisible markers in tidy group titles: SIG (marks a Zen Tidy group) + ICON (3-digit base-5 code).
// Verified in M0: these characters survive the API, the DOM and restarts, and render at 0 px.
// Never use U+200C or U+200D here: next to U+180E or U+FEFF they render a visible dotted circle.

import { ICONS, DEFAULT_ICON, iconIndex } from "../shared/icons.js";

export const SIG = "\u2063\u2062";
export const ICON_ALPHABET = Object.freeze(["\u2060", "\u2061", "\u2064", "\u200B", "\u180E"]);
const BASE = ICON_ALPHABET.length;
const CODE_LENGTH = 3;
export const MAX_ICON_CODES = BASE ** CODE_LENGTH;
export const MAX_NAME_LENGTH = 32;

// Unpaired UTF-16 halves. Removed first: if they were left in, stripping a character between a lone
// high and a lone low half would join them into a new code point that no later pass checks.
const LONE_SURROGATE_RE = /\p{Cs}/gu;
// Every invisible character tested in M0, plus everything else that renders as nothing
// (Default_Ignorable: variation selectors, bidi controls, Hangul fillers, soft hyphen, emoji tags).
// Without the broad class, a name made only of fillers would clean to a blank but non-empty name.
// Written as escapes: a literal U+2028/U+2029 inside a regex literal is a syntax error.
const INVISIBLE_RE = /[\u200B-\u200D\u2060-\u2064\uFEFF\u180E\p{Default_Ignorable_Code_Point}]/gu;
// C0/C1 controls and line/paragraph separators become a space, so the words around them stay apart.
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;
// Skin-tone modifiers are not Extended_Pictographic but render as a colour swatch on their own.
const EMOJI_RE = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}]|\u20E3/gu;
// An Anthropic key must never end up in a group title (same pattern as log.js). Matched after the
// invisible and emoji passes, so a key split by a ZWSP or an emoji is still caught.
const KEY_RE = /sk-ant-[A-Za-z0-9_-]*/g;
// SIG and the icon alphabet: a visible name never needs them, and one right after the code would read as part of it.
const MARKER_RE = /[\u2062\u2063\u2060\u2061\u2064\u200B\u180E]/gu;
// Leading combining marks (and spaces between them) would attach to the invisible icon code before
// the name and render as a stray accent or a dotted circle.
const LEADING_MARKS_RE = /^[\p{M}\s]+/u;

export function encodeIcon(name) {
  let index = iconIndex(name);
  if (index < 0) index = 0;
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code = ICON_ALPHABET[index % BASE] + code;
    index = Math.floor(index / BASE);
  }
  return code;
}

export function decodeIcon(code) {
  if (typeof code !== "string" || [...code].length !== CODE_LENGTH) return null;
  let index = 0;
  for (const ch of code) {
    const digit = ICON_ALPHABET.indexOf(ch);
    if (digit < 0) return null;
    index = index * BASE + digit;
  }
  return index < ICONS.length ? ICONS[index] : null;
}

// Strip everything that must not appear in a visible group name, then trim and cap the length.
export function cleanVisibleName(name, maxLength = MAX_NAME_LENGTH) {
  if (typeof name !== "string") return "";
  const cleaned = name
    .replace(LONE_SURROGATE_RE, "")
    .replace(INVISIBLE_RE, "")
    .replace(CONTROL_RE, " ")
    .replace(EMOJI_RE, "")
    .replace(KEY_RE, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(LEADING_MARKS_RE, "");
  const chars = [...cleaned];
  return chars.length > maxLength ? chars.slice(0, maxLength).join("").trimEnd() : cleaned;
}

// maxLength: an existing group's name may be longer than 32 characters (Zen allows it), and a rename of it is
// capped by validateApplyRequest instead.
export function makeTitle(name, icon = DEFAULT_ICON, maxLength = MAX_NAME_LENGTH) {
  return SIG + encodeIcon(icon) + cleanVisibleName(name, maxLength);
}

// The same title with only its icon swapped, for an icon-only change to an existing group: the visible name stays
// exactly as the person sees it in Zen (longer than 32 characters, emoji and all). Only marker characters left
// over from a damaged code go, so the new code is followed by visible text, and a key-shaped string, which no
// title Zen Tidy writes may hold.
export function withIcon(title, icon = DEFAULT_ICON) {
  const text = typeof title === "string" ? title : "";
  const rest = [...(isTidyTitle(text) ? text.slice(SIG.length) : text)];
  const visible = decodeIcon(rest.slice(0, CODE_LENGTH).join("")) ? rest.slice(CODE_LENGTH) : rest;
  return SIG + encodeIcon(icon) + visible.join("").replace(MARKER_RE, "").replace(KEY_RE, "");
}

export function isTidyTitle(title) {
  return typeof title === "string" && title.startsWith(SIG);
}

// Parse a group title. For tidy groups returns the icon and visible name; otherwise isTidy is false.
export function parseTitle(title) {
  if (!isTidyTitle(title)) {
    return { isTidy: false, icon: null, name: typeof title === "string" ? title : "" };
  }
  const rest = [...title.slice(SIG.length)];
  const icon = decodeIcon(rest.slice(0, CODE_LENGTH).join(""));
  // A missing or damaged code must not eat visible characters. Code characters are invisible,
  // so cleaning the whole remainder drops whatever is left of the code.
  const name = cleanVisibleName((icon ? rest.slice(CODE_LENGTH) : rest).join(""), Number.MAX_SAFE_INTEGER);
  return { isTidy: true, icon: icon ?? DEFAULT_ICON, name };
}
