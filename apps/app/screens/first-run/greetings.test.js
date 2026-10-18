import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { GREET, pickGreeting, poolFor, slotOf } from "./greetings.js";

test("there are sixteen greeting pairs, each with a greeting and a line", () => {
  const all = Object.values(GREET).flat();
  assert.equal(all.length, 16);
  for (const [g, line] of all) { assert.ok(g.length > 2); assert.ok(line.length > 2); }
});

test("the hour picks the part of the day", () => {
  assert.deepEqual([4, 5, 11, 12, 16, 17, 21, 22, 0].map(slotOf), ["night", "morning", "morning", "afternoon", "afternoon", "evening", "evening", "night", "night"]);
});

test("the hour's own pairs count double beside the any-time ones", () => {
  assert.equal(poolFor(9).length, GREET.morning.length * 2 + GREET.any.length);
  assert.equal(poolFor(23).filter((g) => g[0] === "Up late?").length, 2);
});

test("a greeting never repeats the last one, whatever the dice say", () => {
  for (let h = 0; h < 24; h++) {
    for (const g of poolFor(h)) {
      for (const r of [0, 0.3, 0.999]) assert.notEqual(pickGreeting({ hour: h, last: g[0], random: () => r })[0], g[0]);
    }
  }
});

test("a pick comes from the hour's pool, and the dice choose which", () => {
  const pool = poolFor(9);
  assert.deepEqual(pickGreeting({ hour: 9, random: () => 0 }), pool[0]);
  assert.deepEqual(pickGreeting({ hour: 9, random: () => 0.999999 }), pool[pool.length - 1]);
});
