// @ts-check
// Ranked matching for the composer's pickers: tiers, offsets, paths and multi-token queries.

import "../../../../../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreMatch, compareScores, scorePath, scoreFields } from "./match.js";

test("tiers, best to worst", () => {
  assert.deepEqual(scoreMatch("", "anything"), { tier: 0, offset: 0 });
  assert.deepEqual(scoreMatch("Juno", "juno"), { tier: 0, offset: 0 });
  assert.deepEqual(scoreMatch("harlow", "harlow legal"), { tier: 1, offset: 0 });
  assert.deepEqual(scoreMatch("legal", "harlow legal"), { tier: 1, offset: 7 });
  assert.deepEqual(scoreMatch("harl", "harlow legal"), { tier: 2, offset: 0 });
  assert.deepEqual(scoreMatch("leg", "harlow legal"), { tier: 3, offset: 7 });
  assert.deepEqual(scoreMatch("low", "harlow legal"), { tier: 4, offset: 3 });
  assert.deepEqual(scoreMatch("nwb", "northwind-bakery"), { tier: 5, offset: 0, spread: 11 });
  assert.equal(scoreMatch("nb", "north bakery"), null, "a subsequence stays in one word");
  assert.equal(scoreMatch("zz", "kit"), null);
});

test("the best occurrence wins: a later whole word beats an earlier substring", () => {
  assert.deepEqual(scoreMatch("kit", "toolkit kit"), { tier: 1, offset: 8 });
});

test("compareScores orders by tier, then offset, then spread", () => {
  const list = [{ tier: 5, offset: 0, spread: 9 }, { tier: 2, offset: 3 }, { tier: 2, offset: 0 }, { tier: 5, offset: 0, spread: 3 }];
  list.sort(compareScores);
  assert.deepEqual(list, [{ tier: 2, offset: 0 }, { tier: 2, offset: 3 }, { tier: 5, offset: 0, spread: 3 }, { tier: 5, offset: 0, spread: 9 }]);
});

test("paths: direct first, then with separators ignored", () => {
  assert.deepEqual(scorePath("app", "src/app.js"), { tier: 1, offset: 4 });
  assert.deepEqual(scorePath("src app", "src/app.js"), { tier: 2, offset: 0 });
  assert.deepEqual(scorePath("appjs", "src/app.js")?.offset, 4);
  assert.equal(scorePath("---", "src/app.js"), null);
  assert.equal(scorePath("zz", "src/app.js"), null);
});

test("fields: every token must match some field; tiers add up", () => {
  assert.deepEqual(scoreFields("  ", ["x"]), { tier: 0, offset: 0, spread: 0 });
  assert.deepEqual(scoreFields("northwind bak", ["Northwind", "Bakery orders"]), { tier: 2, offset: 0, spread: 12 });
  assert.equal(scoreFields("northwind zz", ["Northwind", "Bakery"]), null);
});
