// The guarded CSS: what passes, and each thing the linter refuses with the reason.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintCss, tokenNames, tokensVersion } from "./css.js";

const ok = (/** @type {string} */ css, scope = "space") => lintCss(css, { scope });

test("css: a styling of the language's own hooks with design tokens passes", () => {
  assert.deepEqual(ok('[data-block="kpis"] { background-color: var(--surface-2); border-radius: var(--r-card); padding: var(--s-4) var(--s-3); }').problems, []);
  assert.equal(ok('[data-screen="orders"] [data-block="list"] div { color: var(--accent); font-weight: 600; text-transform: uppercase; }', "screen:orders").ok, true);
  assert.equal(ok('@media (max-width: 600px) { [data-block="kpis"] { gap: var(--s-2); } } @media (prefers-color-scheme: dark) { [data-block="kpis"] { opacity: 0.9; } }').ok, true);
  assert.ok(tokenNames().has("--surface-2") && tokenNames().has("--s-4") && tokenNames().has("--r-card"));
  assert.match(tokensVersion(), /^[0-9a-f]{12}$/);
});

test("css: each way out is refused, with the fix", () => {
  const bad = (/** @type {string} */ css, /** @type {RegExp} */ re, scope = "space") => { const r = ok(css, scope); assert.equal(r.ok, false, css); assert.match(r.problems.join("\n"), re, css); };
  bad("body { color: var(--text); }", /start with \[data-screen/);
  bad('[data-block="a"] { color: #ff0000; }', /use design tokens, like var\(--accent\)/);
  bad('[data-block="a"] { color: var(--nope); }', /is not a token|use design tokens/);
  bad('[data-block="a"] { padding: 12px; }', /use design tokens/);
  bad('[data-block="a"] { display: none; }', /not a property the language lets a style change/);
  bad('[data-block="a"] { position: fixed; }', /not a property/);
  bad('[data-block="a"] { opacity: 0; }', /never hide/);
  bad('[data-block="a"] { background-color: var(--bg); background-image: url(x.png); }', /no @import, url\(\)/);
  bad('@import "x.css"; [data-block="a"] { color: var(--text); }', /@import|only @media/);
  bad('[data-block="a"] { color: var(--text) !important; }', /!important/);
  bad('[data-block="a"] { co\\lor: var(--text); }', /backslash/);
  bad('@keyframes x { from { opacity: 1 } }', /only @media/);
  bad('[data-block="a"] input { color: var(--text); }', /"input" is not an allowed part/);
  bad('[data-block="b"] { color: var(--text); }', /starts at \[data-screen="orders"\]/, "screen:orders");
  bad("x".repeat(9000), /larger than 8 KB/);
});
