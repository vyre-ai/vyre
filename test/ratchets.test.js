// @ts-check
// The ratchet check of scripts/team/preflight.mjs (R1): a list that may only shrink and grew needs `[ratchet +N: why]`. The pure parts, and the real lists read as they are today.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RATCHETS, weigh, growth, ruled } from "../scripts/team/ratchets.mjs";

const json = (/** @type {unknown} */ o) => JSON.stringify(o);

test("weigh counts leaf entries and the sum of positive numbers, and ignores _comment keys", () => {
  assert.deepEqual(weigh({ _comment: "x", files: { "a.js": 2, "b.js": 1 } }), { entries: 2, mass: 3 });
  assert.deepEqual(weigh({ tools: { "x.y": { reason: "read-only" } } }), { entries: 1, mass: 0 });
  assert.deepEqual(weigh([]), { entries: 0, mass: 0 });
});

test("a list that gained an entry, or whose counts rose, is growth; one that shrank or stood still is not", () => {
  const r = { file: "test/x.json", kind: "json" };
  assert.equal(growth(r, json({ a: 1 }), json({ a: 1, b: 1 })).length >= 1, true, "a new entry");
  assert.equal(growth(r, json({ a: 1 }), json({ a: 2 })).length, 1, "a count rose with no new entry: provider-adapters, description baseline");
  assert.deepEqual(growth(r, json({ a: 2, b: 1 }), json({ a: 1 })), []);
  assert.deepEqual(growth(r, json({ a: 1 }), json({ a: 1 })), []);
  assert.deepEqual(growth(r, null, json({ a: 1 })), [], "a new file is born with its reasons");
});

test("a list shrunk to nothing is accepted, and is not growth", () => {
  const r = { file: "test/x.json", kind: "json" };
  assert.deepEqual(weigh({ _comment: "all gone", files: {} }), { entries: 0, mass: 0 });
  assert.deepEqual(growth(r, json({ a: 1, b: 2 }), json({ _comment: "all gone" })), []);
});

test("a cap that rose is growth", () => {
  const r = { file: "kernel/size.test.js", kind: "cap", pattern: /\bconst CAP = (\d+)/ };
  assert.equal(growth(r, "const CAP = 9440;", "const CAP = 9500;").length, 1);
  assert.deepEqual(growth(r, "const CAP = 9440;", "const CAP = 9440;"), []);
});

test("the tag must carry a reason", () => {
  assert.equal(ruled("fix: x\n\n[ratchet +3: three tools opened by the 4 Oct ruling]"), true);
  assert.equal(ruled("[ratchet +3:]"), false);
  assert.equal(ruled("ratchet +3 because"), false);
});

test("every named list exists and reads, so the check cannot pass by looking at nothing", () => {
  assert.ok(RATCHETS.length >= 10);
  for (const r of RATCHETS) {
    assert.ok(fs.existsSync(r.file), `${r.file} is named as a ratchet and is gone`);
    const text = fs.readFileSync(r.file, "utf8");
    // (a list shrunk to nothing is the goal, so empty is allowed; the file must still exist and parse)
    if (r.kind === "json") assert.ok(weigh(JSON.parse(text)).entries >= 0);
    else assert.ok(r.pattern && r.pattern.test(text), `${r.file} no longer has the number the check reads`);
  }
});
