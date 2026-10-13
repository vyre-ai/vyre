// @ts-check
// The space's own mark when it has no generated emblem: a person's logo, else a monogram of the name's initials on a calm tile from a small curated palette.
// Pure, so Node tests it. The palette is chosen by the space's id, so a space looks the same in the rail, a card and Settings, and never changes when it is renamed.

/** Eight calm tints. Paper: a pale wash with a deep ink of the same hue. Dark: a deep muted tile with a soft ink. Contrast is at least 4.5 to 1 in every pair. */
export const TILE_PALETTE = /** @type {const} */ ([
  { name: "sage",  paper: { bg: "#DDE7DD", ink: "#2F4A35" }, dark: { bg: "#263229", ink: "#B7D2BC" } },
  { name: "clay",  paper: { bg: "#EDDDD3", ink: "#6B3F2A" }, dark: { bg: "#382A22", ink: "#E3BFA8" } },
  { name: "slate", paper: { bg: "#DCE4EE", ink: "#2E4562" }, dark: { bg: "#232E3D", ink: "#B3C8E3" } },
  { name: "sand",  paper: { bg: "#EDE6D3", ink: "#5E5128" }, dark: { bg: "#35301F", ink: "#E0D3A0" } },
  { name: "plum",  paper: { bg: "#E6DCE8", ink: "#4F2F57" }, dark: { bg: "#302536", ink: "#D9BFE0" } },
  { name: "teal",  paper: { bg: "#D5E7E5", ink: "#1F5550" }, dark: { bg: "#1F3432", ink: "#9ED5CE" } },
  { name: "rose",  paper: { bg: "#EDDADD", ink: "#6A3340" }, dark: { bg: "#38262A", ink: "#E6B4BD" } },
  { name: "stone", paper: { bg: "#E4E2DD", ink: "#3F3C36" }, dark: { bg: "#2B2A27", ink: "#CFCBC2" } },
]);

/** Up to two letters: the first letters of the first two words, else the first two letters of a single word. Upper case. "?" for nothing. @param {string} name */
export function initialsOf(name) {
  const words = String(name ?? "").trim().split(/\s+/).filter(Boolean).map((w) => [...w].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("")).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? [...words[0]][0] + [...words[1]][0] : [...words[0]].slice(0, 2).join("");
  return letters.toLocaleUpperCase();
}

/** A stable index into the palette from an id (FNV-1a, so near ids still spread). @param {string} id */
export function paletteIndex(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id ?? "")) { h ^= ch.codePointAt(0) ?? 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h % TILE_PALETTE.length;
}

/** Only an image the app can safely draw: https, a raster data image (never SVG, which can carry script), or a local file the app made. @param {unknown} uri */
const drawable = (uri) => typeof uri === "string" && /^(https:\/\/|data:image\/(png|jpeg|webp);|file:\/\/|blob:)/i.test(uri);

/**
 * What a space's tile shows. A logo when there is one and it loaded; otherwise the monogram. `failed` is the image's own load error.
 * @param {{ id: string, name: string, logo?: string | null }} space
 * @param {{ failed?: boolean }} [state]
 * @returns {{ kind: "logo", uri: string, initials: string, palette: number } | { kind: "monogram", initials: string, palette: number }}
 */
export function spaceTile(space, state = {}) {
  const initials = initialsOf(space.name), palette = paletteIndex(space.id || space.name);
  if (drawable(space.logo) && !state.failed) return { kind: "logo", uri: /** @type {string} */ (space.logo), initials, palette };
  return { kind: "monogram", initials, palette };
}
