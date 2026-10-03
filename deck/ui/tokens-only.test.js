// @ts-check
// The build check of ui-primitives.md section 6: nothing in the UI build's stylesheets or scripts holds a colour, a font size or a radius of its own. The
// stylesheets (css/ui.css and every css/ui-*.css) may not contain a colour literal (#hex, rgb(, rgba(, hsl(, hsla(), a font-size or a border-radius in raw px (0 is
// fine), or the size in a font shorthand; every value comes from a token (var(--...)). The scripts under deck/ui, except tokens-v3.js, theme.js and tests, may not
// contain a hex colour. A colour that must come from data comes through tokens-v3.js or theme.js, never from a literal.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Without comments. @param {string} css */
const bare = css => css.replace(/\/\*[\s\S]*?\*\//g, "");
/** A value with its var(...) calls taken out, so a fallback or a name cannot hide or cause a hit. @param {string} v */
const noVars = v => { let s = v, p; do { p = s; s = s.replace(/var\([^()]*\)/g, " "); } while (s !== p); return s; };
const RAW_PX = /(?:^|[^\w.-])(?:\d*\.)?\d*[1-9]\d*(?:\.\d+)?px\b/;

/**
 * Every problem in a stylesheet, as "prop: value".
 * @param {string} css @returns {string[]}
 */
export function problems(css) {
  const out = /** @type {string[]} */ ([]);
  for (const m of bare(css).matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/gi)) {
    const prop = m[1].toLowerCase(), value = m[2].trim();
    if (/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bhwb\(|\blab\(|\blch\(|\boklch\(/i.test(value)) out.push(`${prop}: ${value} (a colour literal)`);
    const bareValue = noVars(value);
    if (prop === "font-size" && RAW_PX.test(bareValue)) out.push(`${prop}: ${value} (a raw font size)`);
    if (prop === "font" && /(?:^|\s)(?:\d*\.)?\d+px\b/.test(bareValue.replace(/\/\s*[\d.]+(?:px)?/, ""))) out.push(`${prop}: ${value} (a raw font size)`);
    if (/radius$/.test(prop) && RAW_PX.test(bareValue)) out.push(`${prop}: ${value} (a raw radius)`);
  }
  return out;
}

/** Hex colours in a script, comments left out. @param {string} src */
export function hexIn(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w])\/\/.*$/gm, "$1");
  return [...code.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/g)].map(m => m[0]);
}

const sheets = () => fs.readdirSync(path.join(DECK, "css")).filter(f => f === "ui.css" || /^ui-.+\.css$/.test(f)).map(f => path.join("css", f));

/** @param {string} dir @returns {string[]} */
function scripts(dir) {
  return fs.readdirSync(path.join(DECK, dir), { withFileTypes: true }).flatMap(e => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return scripts(rel);
    return e.name.endsWith(".js") && !e.name.endsWith(".test.js") && !["tokens-v3.js", "theme.js"].includes(e.name) ? [rel] : [];
  });
}

test("tokens only: the checks catch what they should", () => {
  assert.deepEqual(problems(".a { color: var(--text); font: 600 var(--fs-body)/1 var(--sans); border-radius: var(--r-card); border: 1px solid var(--edge); border-radius: 0; border-radius: 50%; }"), []);
  assert.equal(problems(".a { color: #fff; }").length, 1);
  assert.equal(problems(".a { background: rgba(0,0,0,.4); }").length, 1);
  assert.equal(problems(".a { color: var(--x, #123456); }").length, 1, "a fallback is still a literal");
  assert.equal(problems(".a { background: hsl(10 20% 30%); }").length, 1);
  assert.equal(problems(".a { font-size: 13px; }").length, 1);
  assert.equal(problems(".a { font: 600 13px/1 var(--sans); }").length, 1);
  assert.equal(problems(".a { border-radius: 8px; }").length, 1);
  assert.equal(problems(".a { border-top-left-radius: 6px 4px; }").length, 1);
  assert.deepEqual(problems(".a { font-size: var(--fs-body); border-radius: calc(var(--r-chip) * 2); } /* #fff 13px */"), []);
  assert.deepEqual(hexIn("const a = 1; // #ff00aa\nconst b = '#7AA2F7';"), ["#7AA2F7"]);
  assert.deepEqual(hexIn("go('#/rows'); id = '#abc123x'; const u = 'http://x/#fff';"), ["#fff"]);
});

test("tokens only: the UI stylesheets hold no colour, font size or radius of their own", () => {
  const files = sheets();
  assert.ok(files.includes(path.join("css", "ui.css")), "css/ui.css is checked");
  for (const f of files) assert.deepEqual(problems(fs.readFileSync(path.join(DECK, f), "utf8")), [], f);
});

test("tokens only: no script under deck/ui holds a hex colour, except tokens-v3.js, theme.js and tests", () => {
  const files = scripts("ui");
  assert.ok(files.some(f => f.endsWith("components/index.js")), "the components are checked");
  for (const f of files) assert.deepEqual(hexIn(fs.readFileSync(path.join(DECK, f), "utf8")), [], f);
});
