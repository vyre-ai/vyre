import "../../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { initialsOf, paletteIndex, spaceTile, TILE_PALETTE } from "./space-tile.js";

test("initials: two words give two letters, one word gives its first two, an empty name gives one dot-free fallback", () => {
  assert.equal(initialsOf("Juniper Studio"), "JS");
  assert.equal(initialsOf("northwind"), "NO");
  assert.equal(initialsOf("  Juniper   Studio  Co "), "JS");
  assert.equal(initialsOf("Mine"), "MI");
  assert.equal(initialsOf("X"), "X");
  assert.equal(initialsOf(""), "?");
  assert.equal(initialsOf("Émile & Fils"), "ÉF");
});

test("palette: the same id always gets the same tile, in range, and the ids spread over the palette", () => {
  assert.equal(paletteIndex("spc_abcdefghijkl"), paletteIndex("spc_abcdefghijkl"));
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const n = paletteIndex(`spc_${i}x`); assert.ok(n >= 0 && n < TILE_PALETTE.length); seen.add(n); }
  assert.ok(seen.size >= TILE_PALETTE.length - 1);
});

test("a space with a logo shows the logo; a broken or empty logo falls back to the monogram, never a pattern", () => {
  assert.deepEqual(spaceTile({ id: "a", name: "Juniper Studio", logo: "https://x/y.png" }), { kind: "logo", uri: "https://x/y.png", initials: "JS", palette: paletteIndex("a") });
  assert.equal(spaceTile({ id: "a", name: "Juniper Studio", logo: "https://x/y.png" }, { failed: true }).kind, "monogram");
  assert.equal(spaceTile({ id: "a", name: "Juniper Studio", logo: "" }).kind, "monogram");
  assert.equal(spaceTile({ id: "a", name: "Juniper Studio", logo: "javascript:alert(1)" }).kind, "monogram");
  assert.equal(spaceTile({ id: "a", name: "Juniper Studio", logo: "data:image/svg+xml;base64,AAAA" }).kind, "monogram", "an SVG can carry script, so it is never drawn");
  assert.equal(spaceTile({ id: "a", name: "Juniper Studio" }).kind, "monogram");
});

test("every palette entry has paper and dark pairs of hex", () => {
  for (const p of TILE_PALETTE) for (const s of ["paper", "dark"]) { assert.match(p[s].bg, /^#[0-9A-F]{6}$/i); assert.match(p[s].ink, /^#[0-9A-F]{6}$/i); }
});
