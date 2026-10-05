// @ts-check
// core/config/theme.js is the palette: the Deck's stylesheets (the generated tokens.css, then
// deck.css) hold the same values, so the docs' swatches, the theme.colors defaults and what the
// Deck paints can never drift apart.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEME_COLORS, THEME_USE, ROLES_OF } from "../core/config/theme.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DECK = fs.readFileSync(path.join(REPO, "web/css/deck.css"), "utf8");
const TOKENS = fs.readFileSync(path.join(REPO, "web/css/tokens.css"), "utf8");

/** The literal colours a rule block sets: { name: value }, skipping var() and non-colours. */
function block(selector, css = DECK) {
  const at = css.indexOf(selector + " {");
  assert.ok(at >= 0, `deck.css has ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  /** @type {Record<string, string>} */ const out = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) if (/^(#|rgba?\()/.test(m[2].trim())) out[m[1]] = m[2].trim();
  return out;
}

/** What tokens.css then deck.css paint under a selector (deck.css's own literals win). */
const painted = (/** @type {string} */ sel) => ({ ...block(sel, TOKENS), ...block(sel) });
/** A swatch's value: its own custom property, or else its role's (tokens.css paints roles only). */
const swatch = (/** @type {Record<string, string>} */ all, /** @type {string} */ k) => all[k] ?? (ROLES_OF[k] ? all[ROLES_OF[k][0]] : undefined);

test("theme: THEME_COLORS.dark is what tokens.css and deck.css paint on :root", () => {
  const all = painted(":root");
  for (const [k, v] of Object.entries(THEME_COLORS.dark)) assert.equal(swatch(all, k), v, `--${k}`);
  for (const k of Object.keys(block(":root")).filter(k => !k.startsWith("swatch-"))) assert.ok(k in THEME_COLORS.dark, `deck.css paints --${k}, missing from THEME_COLORS.dark`);
});

test("theme: THEME_COLORS.light is what tokens.css and deck.css paint for Paper", () => {
  const all = painted(':root[data-theme="paper"]');
  for (const [k, v] of Object.entries(THEME_COLORS.light)) assert.equal(swatch(all, k), v, `--${k}`);
  for (const k of Object.keys(block(':root[data-theme="paper"]'))) assert.ok(k in THEME_COLORS.light, `deck.css paints --${k} on paper, missing from THEME_COLORS.light`);
});

test("theme: every colour has a use", () => {
  for (const mode of /** @type {const} */ (["dark", "light"])) {
    for (const k of Object.keys(THEME_COLORS[mode])) assert.ok(THEME_USE[mode][k], `${mode}.${k}`);
    assert.deepEqual(Object.keys(THEME_USE[mode]).sort(), Object.keys(THEME_COLORS[mode]).sort(), mode);
  }
});
