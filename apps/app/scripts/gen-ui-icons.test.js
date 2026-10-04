// @ts-check
// gen-ui-icons.mjs's pure pieces: the fragment parser, the alias table, the generated module.
import "./test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ALIASES, HEADER, isStale, parseFragment, parseSet, renderIcons } from "./gen-ui-icons.mjs";

const SRC = JSON.parse(readFileSync(new URL("../src/ui/icons.source.json", import.meta.url), "utf8"));

test("gen-ui-icons: a fragment becomes elements with numbers as numbers", () => {
  assert.deepEqual(parseFragment("x", '<rect x="4" y="5" width="5" height="14" rx="1.2"/><path d="M1 1h2"/><ellipse cx="12" cy="6.5" rx="7" ry="2.7"/>'), [
    { el: "rect", x: 4, y: 5, width: 5, height: 14, rx: 1.2 }, { el: "path", d: "M1 1h2" }, { el: "ellipse", cx: 12, cy: 6.5, rx: 7, ry: 2.7 },
  ]);
  assert.throws(() => parseFragment("x", '<line x1="1"/>'), /not one of/);
  assert.throws(() => parseFragment("x", '<path d="M1 1"/> junk'), /not an element/);
  assert.throws(() => parseFragment("x", '<circle cx="1" cy="1"/>'), /no r/);
});

test("gen-ui-icons: the set holds the 95 icons of the family and every old name still resolves", () => {
  const set = parseSet(SRC);
  const names = new Set(set.map(([n]) => n));
  for (const n of ["chevron", "chevron-down", "chevron-up", "chevron-left", "lock", "filter", "sort", "spark", "sealed", "wink", "space"]) assert.ok(names.has(n), n);
  assert.ok(names.size >= 95);
  const out = renderIcons(set);
  assert.equal(out.split("\n")[0], HEADER);
  for (const old of ["now", "chat", "agents", "projects", "memory", "vault", "planner", "devices", "settings", "search", "check", "x", "failed", "chev-r", "chev-l", "chev-d", "plus", "more", "terminal", "mic", "send", "stop", "faceid", "eye", "hand", "clock", "bell", "file", "key", "copy", "qr", "phone", "laptop", "box", "wifi-off", "refresh", "drive", "link", "download", "share", "globe", "shield", "pause", "play", "cable", "alarm", "todo", "unlock", "minus"]) {
    assert.ok(names.has(old) || old in ALIASES, `old icon name ${old} must still work`);
    assert.match(out, new RegExp(`\\| "${old}"`), old);
  }
});

test("gen-ui-icons: an alias to a missing drawing, or one that shadows a drawing, is refused", () => {
  const set = parseSet({ a: '<path d="M1 1"/>' });
  assert.throws(() => renderIcons(set, { b: "zz" }), /not in the set/);
  assert.throws(() => renderIcons(set, { a: "a" }), /also a drawing/);
});

test("gen-ui-icons: stale only when the text differs", () => {
  assert.equal(isStale("a", "a"), false);
  assert.equal(isStale(null, "a"), true);
});
