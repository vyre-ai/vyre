import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
// A build check: no file in the Expo app holds a colour of its own. Every colour is a role from the generated token file (src/theme/tokens.ts), so a space's look,
// the paper scheme and a person's contrast choice reach every screen. The same rule the Deck's stylesheets were held to (it read deck/ui/tokens-only.test.js).
// A literal colour fails this test unless its file is in EXCEPTIONS below, which is short and says why each one is there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Files that may hold literal colours, and why. Keep it short; a new entry needs a reviewer to agree the colour is not a role. */
export const EXCEPTIONS = Object.freeze({
  "src/terminal/palettes.ts": "the terminal's ANSI colours: a terminal needs its reds and greens to carry meaning, they are not roles",
  "ui/marks/source.js": "the avatar illustration (skin, hair, clothes and background palettes): art, drawn the same under either scheme",
});

// src/vendor holds the Deck's own domain modules and third-party code copied in as they are (the token source, the avatar art, xterm): not screens, not ours to recolour.
const SKIP_DIRS = new Set(["vendor", "node_modules", "dist", "dist-ios", ".expo", "android", "ios", "assets", "public", "scripts"]);
const SKIP_FILES = new Set(["src/theme/tokens.ts"]);
const EXT = /\.(?:ts|tsx|js|jsx|cjs|mjs|css)$/;

/** Literal colours in code, comments left out: hex of 3, 4, 6 or 8 digits, and rgb(, rgba(, hsl(, hsla( with a number inside (a template that builds one from a token has none). @param {string} src */
export function colourLiterals(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\w])\/\/.*$/gm, "$1");
  const hex = [...code.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/g)].map(m => m[0]);
  const fn = [...code.matchAll(/\b(?:rgba?|hsla?)\(\s*[\d.]/g)].map(m => m[0]);
  return [...hex, ...fn];
}

/** @param {string} dir @param {string[]} [out] */
function files(dir, out = []) {
  for (const e of fs.readdirSync(path.join(APP, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) files(rel, out); continue; }
    if (EXT.test(e.name) && !/\.test\.[cm]?js$/.test(e.name) && !SKIP_FILES.has(rel)) out.push(rel);
  }
  return out;
}
const all = () => ["app", "src", "ui", "screens", "modules", "perf", "plugins"].filter(d => fs.existsSync(path.join(APP, d))).flatMap(d => files(d));

test("raw colours: the checker finds what it should and leaves the rest", () => {
  assert.deepEqual(colourLiterals("const a = '#7AA2F7'; const b = '#fff'; c = 'rgba(0,0,0,.4)'; d = 'hsl(10 20% 30%)'"), ["#7AA2F7", "#fff", "rgba(0", "hsl(1"]);
  assert.deepEqual(colourLiterals("// #ff00aa\n/* rgb(1,2,3) */ go('#/rows'); id = '#abc123x'; const u = 'http://x/#fff'; `rgba(${r}, ${g}, ${b}, ${a})`; x = tokens.color.dark.text"), ["#fff"]);
});

test("raw colours: no file in the app holds a colour of its own", () => {
  const list = all();
  assert.ok(list.includes("ui/components/Card.tsx") && list.includes("src/chat/Blocks.tsx") && list.includes("src/terminal/theme.ts"), "the UI, chat and terminal are checked");
  const found = list.filter(f => !(f in EXCEPTIONS)).map(f => [f, colourLiterals(fs.readFileSync(path.join(APP, f), "utf8"))]).filter(([, l]) => l.length);
  assert.deepEqual(found, [], "use a role from src/theme/tokens.ts (tokens.color.dark or .paper), or the resolved colour from useUiTheme()");
});

test("raw colours: every exception is real and still holds a literal", () => {
  for (const [f, why] of Object.entries(EXCEPTIONS)) {
    assert.ok(why.length > 20, `${f} says why`);
    assert.ok(fs.existsSync(path.join(APP, f)), `${f} exists`);
    assert.ok(colourLiterals(fs.readFileSync(path.join(APP, f), "utf8")).length > 0, `${f} no longer holds a colour: take it off the list`);
  }
});
