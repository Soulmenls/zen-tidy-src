// FNV-1a, 32-bit, over a string's UTF-16 code units, as 8 lowercase hex digits (notes/m3-contracts.md, "Hash").
// The undo journal keeps the hash of each title apply gives a joined group (journal v2 `joins[].titleHash`), so undo
// can tell whether the person renamed the group since without the new name ever being stored in plain text.
// It only detects a change: 32 bits are no secret, and a collision costs at worst one old title coming back over a
// name the person chose. Each code unit is folded in whole (the usual JavaScript form), so for ASCII text it equals
// the byte-wise reference FNV-1a and matches its published test vectors.
//
// The same hash fingerprints each tab's address (journal v3 `tabs[].urlHash`, urlHash below), so the journal never
// holds an address, its query, fragment or local path. Salted per journal (newUrlSalt), the same address gives a
// different fingerprint in every journal, so two journals can't be compared to see which pages stayed open. A short
// address can still be found by trying candidates against the salt; the fingerprint only tells undo whether the tab
// still shows the page it showed at the tidy (a strong match) or navigated since (a weak one), and a collision costs
// at worst one navigated tab taken for a strong match.

const OFFSET_BASIS = 0x811c9dc5;
const PRIME = 0x01000193;

// A missing title (null or undefined) hashes like "", which is never a title apply sets (they all start with SIG).
export function fnv1a32(text) {
  const s = String(text ?? "");
  let hash = OFFSET_BASIS;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    // Math.imul keeps the product in 32 bits; a plain * would lose the low bits to float rounding.
    hash = Math.imul(hash, PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// A tab address's fingerprint in one journal: fnv1a32(salt + url). A missing salt or URL counts as "", so a v1 or v2
// journal's plain URL, fingerprinted with the empty salt, compares like a v3 one.
export function urlHash(salt, url) {
  return fnv1a32(`${salt ?? ""}${url ?? ""}`);
}

// A journal's salt: 8 random lowercase hex digits (crypto.getRandomValues), fresh for every journal.
export function newUrlSalt(random = globalThis.crypto) {
  return [...random.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
