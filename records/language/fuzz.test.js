import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { compile } from "./compile.js";
import { LanguageError } from "./errors.js";
import { parseExpr, evalExpr } from "./expr.js";

const SRC = fs.readFileSync(new URL("../kits/estate-planning/kit.ts", import.meta.url), "utf8");

// A small seeded generator so the fuzz is repeatable (the parser is pinned and fuzzed, R6-12).
function rng(seed) { let s = seed >>> 0; return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32; }

test("fuzz: a mutated kit file either compiles or fails with a LanguageError, quickly, never anything else", () => {
  const r = rng(20261003);
  const junk = ["(", ")", "{", "}", "[", "]", ",", ":", ";", "`", "'", '"', "${", "\\", "/*", "*/", "//", "=>", "...", "new ", "import(", "\u0000", "‮", "-", "."];
  const t0 = Date.now();
  let compiled = 0, refused = 0;
  for (let i = 0; i < 1500; i++) {
    let s = SRC;
    for (let k = 0; k < 1 + Math.floor(r() * 4); k++) {
      const at = Math.floor(r() * s.length);
      const op = r();
      if (op < 0.4) s = s.slice(0, at) + junk[Math.floor(r() * junk.length)] + s.slice(at);
      else if (op < 0.7) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 12));
      else s = s.slice(0, at) + s.slice(Math.floor(r() * s.length));
    }
    try { compile(s); compiled++; }
    catch (e) { assert.ok(e instanceof LanguageError, `unexpected ${e && e.constructor && e.constructor.name}: ${e && e.message}`); refused++; }
  }
  assert.ok(refused > 1000, "most mutations should be refused");
  assert.ok(Date.now() - t0 < 20000, "1500 mutated files in well under 20 s");
});

test("fuzz: random expression strings never throw anything but LanguageError and never hang", () => {
  const r = rng(7);
  const parts = ["a", "b", "stage", "1", "2.5", "'x'", "\"y\"", "==", "!=", "<", ">=", "and", "or", "not", "in", "(", ")", "[", "]", ",", "+", "-", "*", "/", "len(", "lower(", ".", "true", "null", "@", "$", "x.y"];
  for (let i = 0; i < 3000; i++) {
    const s = Array.from({ length: 1 + Math.floor(r() * 10) }, () => parts[Math.floor(r() * parts.length)]).join(" ");
    try { evalExpr(parseExpr(s), { values: { a: 1, b: "x", stage: "Intake" }, stageOrder: { stage: ["Intake", "Drafting"] } }); }
    catch (e) { assert.ok(e instanceof LanguageError, `unexpected: ${e && e.message} for ${s}`); }
  }
});

test("expression language: stage order, paths, functions, limits", () => {
  const ev = (src, values) => evalExpr(parseExpr(src), { values, stageOrder: { stage: ["Intake", "Engagement", "Drafting"] } });
  assert.equal(ev("stage < 'Drafting' or signed == true", { stage: "Intake", signed: false }), true);
  assert.equal(ev("stage < 'Drafting' or signed == true", { stage: "Drafting", signed: false }), false);
  assert.equal(ev("stage < 'Drafting' or signed == true", { stage: "Drafting", signed: true }), true);
  assert.equal(ev("len(client.name) > 2 and not empty(client.name)", { client: { name: "Alex" } }), true);
  assert.equal(ev("fee in [100, 200]", { fee: 200 }), true);
  assert.equal(ev("missing.path == null", {}), true);
  assert.throws(() => parseExpr("constructor == null"), LanguageError);
  assert.throws(() => parseExpr("a.__proto__ == 1"), LanguageError);
  assert.throws(() => parseExpr("x".repeat(2001)), LanguageError);
  assert.throws(() => parseExpr("(".repeat(30) + "1" + ")".repeat(30)), LanguageError);
  assert.throws(() => parseExpr("process.exit(1)"), /Unknown function|Unexpected/);
});
