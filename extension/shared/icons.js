// Zen's selectable folder icons (chrome://browser/skin/zen-icons/selectable/<name>.svg).
// The array index is the icon's code in a tidy group's title marker.
// APPEND-ONLY: never reorder or remove entries, or existing groups will show the wrong icon.
// Index 0 ("folder") is the default for unknown or missing icons.

export const ICONS = Object.freeze([
  "folder",
  "airplane", "american-football", "baseball", "basket", "bed", "bell", "book", "bookmark",
  "briefcase", "brush", "bug", "build", "cafe", "call", "card", "chat", "checkbox", "circle",
  "cloud", "code", "coins", "construct", "cutlery", "egg", "extension-puzzle", "eye",
  "fast-food", "fish", "flag", "flame", "flask", "game-controller", "globe-1", "globe",
  "grid-2x2", "grid-3x3", "heart", "ice-cream", "image", "inbox", "key", "layers", "leaf",
  "lightning", "location", "lock-closed", "logo-github", "logo-rss", "logo-usd", "mail", "map",
  "megaphone", "moon", "music", "navigate", "nuclear", "page", "palette", "paw", "people",
  "pizza", "planet", "present", "rocket", "school", "shapes", "shirt", "skull", "square",
  "squares", "star-1", "star", "stats-chart", "sun", "tada", "terminal", "ticket", "time",
  "trash", "triangle", "video", "volume-high", "wallet", "warning", "water", "weight",
]);

export const DEFAULT_ICON = "folder";

export function iconIndex(name) {
  if (typeof name !== "string") return -1;
  return ICONS.indexOf(name.trim().toLowerCase());
}
