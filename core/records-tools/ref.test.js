// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refPrefix, refNumber, formatRef, nextRef, isClash, clashStep, MAX_MINT_TRIES, mintRef } from "./ref.js";

test("an ID is a type prefix and a counter: PER-0001, and the next one follows the highest", () => {
  assert.deepEqual(["contact", "organization", "task", "memo", "invoice", "x"].map(refPrefix), ["PER", "ORG", "TSK", "NOT", "INV", "X"]);
  assert.equal(formatRef("PER", 7), "PER-0007");
  assert.equal(nextRef("contact", []), "PER-0001", "the first");
  assert.equal(nextRef("contact", ["PER-0001", "PER-0009", "PER-0003"]), "PER-0010", "after the highest, in any order");
  assert.equal(nextRef("contact", ["PER-9999", "PER-10000"]), "PER-10001", "past four digits it still counts up");
  assert.equal(nextRef("contact", ["ORG-0044", "junk", null, undefined, 5]), "PER-0001", "another type's ID and junk do not count");
  assert.equal(refNumber("PER", "PER-0042"), 42);
  assert.equal(refNumber("PER", "per-0042"), 0);
});

test("a clash is told by its words, and the steps past it grow so a hidden high ID is passed in a few tries", () => {
  assert.equal(isClash(new Error("ref must be unique")), true);
  assert.equal(isClash(new Error("duplicate key")), true);
  assert.equal(isClash(new Error("not allowed")), false);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(clashStep), [1, 1, 1, 10, 10, 10, 100, 100, 100, 1000]);
  let n = 1, tries = 0;
  const hidden = 250;   // a record the caller cannot see holds PER-0250
  while (n <= hidden && tries < MAX_MINT_TRIES) { tries++; n += clashStep(tries); }
  assert.ok(n > hidden && tries < MAX_MINT_TRIES, "a hidden ID 250 ahead is passed within the tries");
});

test("mintRef: a caller who cannot see the records holding the higher IDs still gets a free one, and the refusal's words go nowhere", async () => {
  const taken = new Set(Array.from({ length: 40 }, (_, k) => `PER-${String(k + 1).padStart(4, "0")}`));   // a member sees none of these
  const tried = /** @type {string[]} */ ([]);
  const out = await mintRef({ type: "contact", start: 1, create: async (ref) => { tried.push(ref); if (taken.has(ref)) throw new Error(`ref ${ref} must be unique: a record already has it`); return { ref }; } });
  assert.ok(!taken.has(out.made.ref), "a free one");
  assert.ok(tried.length <= MAX_MINT_TRIES, "within the tries");
  // a failure that is not a clash is passed up as it is, at once
  await assert.rejects(() => mintRef({ type: "contact", start: 1, create: async () => { throw Object.assign(new Error("not allowed"), { code: "denied" }); } }), (e) => e.code === "denied");
  // nothing ever free: a plain answer that names no record
  await assert.rejects(() => mintRef({ type: "contact", start: 1, create: async () => { throw new Error("must be unique: PER-9999 exists"); } }), (e) => e.code === "unavailable" && !/PER-|unique|exists/.test(e.message));
});
