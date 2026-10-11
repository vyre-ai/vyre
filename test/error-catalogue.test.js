// @ts-check
// G28 error catalogue: every error code a person can meet has a catalogue entry (lib/error-catalogue.js): a title, what it means, what to do, and an owner. A NEW refusal code that has no entry fails
// here. The codes still without one (when the catalogue began) are in test/error-catalogue.baseline.json; that list may only shrink: a code that got an entry must leave it, and one nobody throws
// any more must too.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refusalsIn } from "../lib/errors-teach.js";
import { CATALOGUE, entryFor } from "../lib/error-catalogue.js";
import { sourceFiles, ROOT } from "./source-files.js";

const IN_SCOPE = /^(core|lib|harness|local|modules|records|stores|kernel)\//;
const BASELINE = path.join(ROOT, "test", "error-catalogue.baseline.json");

/** Every refusal code written as a literal in the code, with the first place it is thrown. @returns {Map<string, string>} */
export function usedCodes() {
  /** @type {Map<string, string>} */ const out = new Map();
  for (const f of sourceFiles()) {
    if (!IN_SCOPE.test(f)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const r of refusalsIn(text)) if (!out.has(r.code)) out.set(r.code, `${f}:${text.slice(0, r.index).split("\n").length}`);
  }
  return out;
}
const baseline = () => /** @type {string[]} */ (JSON.parse(fs.readFileSync(BASELINE, "utf8")).codes);

test("every entry has a title, a description, a recourse and an owner, in words a person can read", () => {
  for (const [code, e] of Object.entries(CATALOGUE)) {
    assert.match(code, /^[a-z][a-z_]+$/, `${code}: a code is lower case with underscores`);
    for (const k of /** @type {const} */ (["title", "description", "recourse", "owner"])) assert.ok(typeof e[k] === "string" && e[k].trim().length >= 3, `${code}.${k} is empty`);
    assert.ok(e.description.length >= 25 && e.recourse.length >= 15, `${code}: say what it means and what to do in a sentence each`);
    const words = `${e.title} ${e.description} ${e.recourse}`;
    assert.doesNotMatch(words, /\b[a-z]+\.[a-z][a-z-]*\.[a-z-]+\b|\b[a-z]+\.(list|status|create|get)\b/, `${code}: no tool names in what a person reads`);
    assert.doesNotMatch(words, /§|\bper_[a-z2-7]{10,}|\bspc_/, `${code}: no section signs or raw ids`);
  }
  assert.equal(entryFor("not_found")?.owner, "all");
  assert.equal(entryFor("nope_not_a_code"), null);
});

/** The codes in `used` that neither the catalogue nor the baseline knows. @param {Map<string, string>} used @param {Iterable<string>} known */
export const newCodes = (used, known) => { const k = new Set(known); return [...used].filter(([code]) => !k.has(code)).map(([code, at]) => `${code} (${at})`); };

test("the check itself: a made-up code in a refusal is reported, a catalogued or baselined one is not", () => {
  const src = 'throw refuse("nothing here", "brand_new_code");\nthrow refuse("no such thing", "not_found");';
  const used = new Map(refusalsIn(src).map(r => [r.code, "fake.js:1"]));
  assert.deepEqual(newCodes(used, [...Object.keys(CATALOGUE)]), ["brand_new_code (fake.js:1)"]);
  assert.deepEqual(newCodes(used, [...Object.keys(CATALOGUE), "brand_new_code"]), [], "a baselined code is tolerated");
});

test("a refusal code with no catalogue entry and not in the baseline is new: add its entry", () => {
  const fresh = newCodes(usedCodes(), [...Object.keys(CATALOGUE), ...baseline()]);
  assert.deepEqual(fresh, [], "these codes need an entry in lib/error-catalogue.js (title, description, recourse, owner): a person sees the code and must be told what to do");
});

test("the baseline only shrinks: a code that has an entry, or that nothing throws any more, leaves it", () => {
  const used = usedCodes();
  const now = baseline().filter(c => Object.hasOwn(CATALOGUE, c));
  assert.deepEqual(now, [], "these now have an entry: remove them from test/error-catalogue.baseline.json");
  const gone = baseline().filter(c => !used.has(c));
  assert.deepEqual(gone, [], "nothing throws these any more: remove them from test/error-catalogue.baseline.json");
  const sorted = [...baseline()].sort();
  assert.deepEqual(baseline(), sorted, "keep the list sorted");
});
