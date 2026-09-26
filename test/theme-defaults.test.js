// @ts-check
// core/config/theme.js is the palette: the Deck's stylesheet holds the same values, so the docs'
// swatches, the theme.colors defaults and what the Deck paints can never drift apart.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_COLORS, THEME_USE } from "../core/config/theme.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(REPO, "deck/css/deck.css"), "utf8");

/** The literal colours a rule block sets: { name: value }, skipping var() and non-colours. */
function block(selector) {
  const at = css.indexOf(selector + " {");
  assert.ok(at >= 0, `deck.css has ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  /** @type {Record<string, string>} */ const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) if (/^(#|rgba?\()/.test(m[2].trim())) out[m[1]] = m[2].trim();
  return out;
}

test("theme: THEME_COLORS.dark is what deck.css paints on :root", () => {
  assert.deepEqual(THEME_COLORS.dark, block(":root"));
});

test("theme: THEME_COLORS.light is what deck.css paints for Paper", () => {
  assert.deepEqual(THEME_COLORS.light, block(':root[data-theme="paper"]'));
});

test("theme: every colour has a use", () => {
  for (const mode of /** @type {const} */ (["dark", "light"])) {
    for (const k of Object.keys(THEME_COLORS[mode])) assert.ok(THEME_USE[mode][k], `${mode}.${k}`);
    assert.deepEqual(Object.keys(THEME_USE[mode]).sort(), Object.keys(THEME_COLORS[mode]).sort(), mode);
  }
});
