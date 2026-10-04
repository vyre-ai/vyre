// @ts-check
// The terminal view's layout and look against the design spec (terminal.md, Design A v1): it
// fills the Chat content area, the phone key bar docks at the bottom and rides the keyboard, the
// key bar is a 7-column grid, the screen is mono 12/18 on --code-bg, and the state dots use
// --focus, --label and the failed mark, never gold or violet. Reads term.css and term.js as text.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(HERE, "term.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const js = fs.readFileSync(path.join(HERE, "term.js"), "utf8");

/** The declarations of the first rule whose selector list is exactly `sel`. @param {string} sel */
function rule(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|})\\s*${esc}\\s*\\{([^}]*)\\}`, "m"));
  assert.ok(m, `no rule for ${sel}`);
  return m[1];
}

test("term layout: the view fills the Chat content area, no card and no 880 cap", () => {
  const pad = rule(".chat-pad.chat-term");
  assert.match(pad, /height:\s*100%/);
  assert.match(pad, /max-width:\s*none/);
  assert.match(pad, /padding:\s*0/);
  const term = rule(".term");
  assert.match(term, /height:\s*100%/);
  assert.match(term, /min-height:\s*0/);
  assert.doesNotMatch(term, /border(-radius)?:/, "the view is not a floating box");
  assert.match(rule(".term-screen"), /flex:\s*1 1 auto/);
});

test("term layout: the phone page keeps no bottom padding, and leaves --kb-lift with the keyboard up", () => {
  assert.match(css, /\.view > \.page:has\(> \.chat-term\)[^{]*\{[^}]*padding-bottom:\s*0/);
  assert.match(css, /:root\[data-kb\] \.view > \.page:has\(> \.chat-term\)[^{]*\{[^}]*padding-bottom:\s*var\(--kb-lift\)/);
  assert.match(rule(".term-keys"), /env\(safe-area-inset-bottom/);
  assert.match(rule(".term-keys"), /background:\s*var\(--panel\)/);
});

test("term layout: the key bar is a grid of 7, gap 6, padding 8; keys 34 tall, radius 6, mono 12/16", () => {
  const bar = rule(".term-keys");
  assert.match(bar, /grid-template-columns:\s*repeat\(7,/);
  assert.match(bar, /gap:\s*6px/);
  assert.match(bar, /padding:\s*8px 8px calc\(8px/);
  assert.match(css, /\.term-keys \{ display: grid; \}/, "shown as a grid on touch screens");
  const key = rule(".term-key");
  assert.match(key, /height:\s*34px/);
  assert.match(key, /border-radius:\s*var\(--radius-field, 8px\)/);
  assert.match(key, /background:\s*var\(--hover\)/);
  assert.match(key, /font-size:\s*12px/);
  assert.match(key, /line-height:\s*16px/);
  const latched = rule('.term-key[aria-pressed="true"]');
  assert.match(latched, /var\(--signal-wash\)/);
  assert.match(latched, /inset 0 0 0 1px var\(--focus\)/);
});

test("term layout: the screen is on --code-bg with padding 12 14, and xterm draws mono 12/18", () => {
  assert.match(rule(".term-screen"), /background:\s*var\(--code-bg\)/);
  assert.match(rule(".term-screen .xterm"), /padding:\s*12px 14px/);
  assert.match(js, /FONT_PX = 12, ROW_PX = 18/);
  assert.match(js, /fontSize: FONT_PX, lineHeight: lineHeightFor\(ROW_PX, charHeight\(\)\)/);
  assert.match(js, /background: v\("--code-bg"/);
  assert.doesNotMatch(js, /fontSize: 13|lineHeight: 1\.2/);
});

test("term layout: dots are --focus live, --label connecting, the failed mark for error and blocked; no gold or violet", () => {
  assert.match(rule(".term-dot"), /background:\s*var\(--label\)/);
  assert.match(rule('.term[data-state="live"] .term-dot'), /var\(--focus\)/);
  assert.match(css, /\.term:is\(\[data-state="error"\], \[data-state="blocked"\]\) \.term-dot \{[^}]*width:\s*12px[^}]*inset 0 0 0 1\.5px var\(--text-2\)/);
  assert.doesNotMatch(css, /--recall|--beacon/);
  assert.doesNotMatch(js.replace(/\/\/.*$/gm, ""), /--recall|--beacon/, "ANSI never folds onto gold or violet");
});

test("term layout: the watch line is its own row, 32 on the desktop and 44 on the phone", () => {
  assert.match(rule(".term-watch"), /min-height:\s*32px/);
  assert.match(css, /\.term-watch \{ min-height: 44px/);
  assert.match(js, /h\("div", \{ class: "term-watch", hidden: true \}, eyeIcon\(\), watchWords, takeBtn\)/);
  assert.match(js, /watchLabel\(sizing, selfWord\(\)\)/);
});

test("term layout: xterm refits whenever its box changes, and the key bar never takes focus", () => {
  assert.match(js, /new ResizeObserver\([\s\S]*?fitAndSend\(\)/);
  assert.match(js, /ro\.observe\(screen\)/);
  assert.match(js, /onpointerdown: e => e\.preventDefault\(\)/);
  assert.match(js, /KEY_ROWS\.flat\(\)\.map/);
});
