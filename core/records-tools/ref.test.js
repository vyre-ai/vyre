// @ts-check
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refPrefix, refNumber, formatRef, nextRef } from "./ref.js";

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
