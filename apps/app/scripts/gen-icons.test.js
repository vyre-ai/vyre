// @ts-check
// gen-icons.mjs's pure pieces: the icons.txt parser, the generated module, and --check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { HEADER, isStale, parseIcons, renderIcons } from "./gen-icons.mjs";

const FIXTURE = [
  'Icon set for the one-app boards. 16 grid, class "ic" (1.5 stroke, currentColor).',
  'Use exactly: <svg class="ic" viewBox="0 0 16 16"><path d="..."></path></svg>',
  'check     <path d="M3 8.5l3 3 7-7"></path>',
  'vault     <rect x="3" y="7" width="10" height="7" rx="1.5"></rect><path d="M5 7V5a3 3 0 0 1 6 0v2"></path>',
  'chev-l    <path d="M10 3.5l-4.5 4.5 4.5 4.5"></path>',
  'more      <circle cx="3.5" cy="8" r="0.8"></circle><circle cx="8" cy="8" r="0.8"/>',
  'bar       <line x1="2" y1="8" x2="14" y2="8"></line><polyline points="2,2 8,6 14,2"></polyline>',
  'The Vyre mark (20-22px): <svg width="22" height="22" viewBox="0 0 24 24"><circle cx="20.5" cy="5.5" r="2.3"></circle></svg>',
].join("\n");

test("gen-icons: the set's lines in order, elements with numbers as numbers; notes and the mark skipped", () => {
  assert.deepEqual(parseIcons(FIXTURE), [
    ["check", [{ el: "path", d: "M3 8.5l3 3 7-7" }]],
    ["vault", [{ el: "rect", x: 3, y: 7, width: 10, height: 7, rx: 1.5 }, { el: "path", d: "M5 7V5a3 3 0 0 1 6 0v2" }]],
    ["chev-l", [{ el: "path", d: "M10 3.5l-4.5 4.5 4.5 4.5" }]],
    ["more", [{ el: "circle", cx: 3.5, cy: 8, r: 0.8 }, { el: "circle", cx: 8, cy: 8, r: 0.8 }]],
    ["bar", [{ el: "line", x1: 2, y1: 8, x2: 14, y2: 8 }, { el: "polyline", points: "2,2 8,6 14,2" }]],
  ]);
});

test("gen-icons: an unknown element, a stray word, a missing attribute or a repeated name is refused", () => {
  assert.throws(() => parseIcons('odd  <ellipse cx="8" cy="8" rx="4" ry="2"></ellipse>'), /ellipse/);
  assert.throws(() => parseIcons('odd  <path d="M1 1h2"></path> and more'), /not an element/);
  assert.throws(() => parseIcons('odd  <circle cx="8" cy="8"></circle>'), /no r/);
  assert.throws(() => parseIcons('x  <path d="M1 1h2"></path>\nx  <path d="M2 2h2"></path>'), /twice/);
});

test("gen-icons: the module carries the header, the name union and one line per icon", () => {
  const out = renderIcons(parseIcons(FIXTURE));
  assert.equal(out.split("\n")[0], HEADER);
  assert.match(out, /export type IconName =\n {2}\| "check"\n {2}\| "vault"\n {2}\| "chev-l"\n {2}\| "more"\n {2}\| "bar";/);
  assert.match(out, /\n {2}"chev-l": \[\{ el: "path", d: "M10 3\.5l-4\.5 4\.5 4\.5 4\.5" \}\],\n/);
  assert.match(out, /\n {2}vault: \[\{ el: "rect", x: 3, y: 7, width: 10, height: 7, rx: 1\.5 \}, \{ el: "path", d: "M5 7V5a3 3 0 0 1 6 0v2" \}\],\n/);
});

test("gen-icons --check: stale when the file is missing or differs, not when it matches", () => {
  const next = renderIcons(parseIcons(FIXTURE));
  assert.equal(isStale(next, next), false);
  assert.equal(isStale(null, next), true);
  assert.equal(isStale(next.replace("7-7", "7-6"), next), true);
});
