// @ts-check
// lib/avatar-seed: the one rule for turning a project's avatar_seed (its stored seed, its slug, or
// a loose chat's id) into the 8 bytes a project tile is drawn from (ADR 0043 section 6). Pure
// JavaScript with no imports, so the Deck (served at /lib/avatar-seed/index.js by core/daemon) and
// Node load this one file. Other surfaces (the Capsule's Swift, the App) port it byte for byte
// against the vectors in index.test.js and ADR 0043; never a second JavaScript copy.
//
// The algorithm, exactly:
//   s = "vyre:project:v1:" + seed, read as UTF-16 code units (JavaScript's charCodeAt)
//   a = FNV-1a 32 over s with offset basis 0x811C9DC5 (2166136261)
//   b = FNV-1a 32 over s with offset basis 0x811C9DC5 XOR 0x5BD1E995 (0xDACD7450)
//   FNV-1a 32: h = basis; for each unit u: h = (h XOR u) * 16777619, modulo 2^32
//   bytes = a big-endian (4 bytes), then b big-endian (4 bytes)
// projectTile reads byte 0 for the colour and byte 1 for the mark. Not a secret and not a
// fingerprint: only stable and spread.

export const PREFIX = "vyre:project:v1:";
export const BASIS_A = 0x811c9dc5;
export const BASIS_B = (0x811c9dc5 ^ 0x5bd1e995) >>> 0;

/** FNV-1a 32 over a string's UTF-16 code units. @param {string} s @param {number} basis */
export function fnv1a32(s, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** The 8 bytes a project tile is drawn from. @param {string} seed @returns {number[]} */
export function projectBytes(seed) {
  const s = PREFIX + String(seed ?? "");
  const a = fnv1a32(s, BASIS_A), b = fnv1a32(s, BASIS_B);
  return [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255];
}
