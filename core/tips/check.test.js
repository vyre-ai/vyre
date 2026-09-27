// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkTips, compareVersions } from "./check.js";

const good = { id: "remind", text: "Type `vyre remind 5pm call juno` to set a reminder.", surfaces: ["cli"], level: "first-use", trigger: "on-use", since: "0.1.0" };

test("tips check: a good tip gets its full id and its module as what it is about", () => {
  const r = checkTips("planner", [good, { ...good, id: "deck", about: "deck", docs: "using/deck.md#now", key: "g n" }]);
  assert.deepEqual(r.problems, []);
  assert.equal(r.tips[0].id, "planner/remind");
  assert.equal(r.tips[0].about, "planner");
  assert.equal(r.tips[1].about, "deck");
});

test("tips check: a bad tip is dropped with a reason, and the good ones stay", () => {
  const r = checkTips("planner", [
    good,
    { ...good, id: "long", text: "x".repeat(141) },
    { ...good, id: "dash", text: "Snooze it — or not." },
    { ...good, id: "where", surfaces: ["tv"] },
    { ...good, id: "lvl", level: "expert" },
    { ...good, id: "when", trigger: "always" },
    { ...good, id: "ver", since: "soon" },
    { ...good, id: "extra", colour: "red" },
    { ...good, id: "docs", docs: "https://example.com" },
    { ...good },
  ]);
  assert.deepEqual(r.tips.map(t => t.id), ["planner/remind"]);
  for (const want of [/141 characters/, /em dash/, /surfaces/, /level/, /trigger/, /since/, /unknown key colour/, /docs/, /used twice/]) {
    assert.ok(r.problems.some(p => want.test(p)), `no problem matched ${want}: ${r.problems.join(" | ")}`);
  }
});

test("tips check: x- keys are free, a missing list is fine, a non-list is not", () => {
  assert.deepEqual(checkTips("m", [{ ...good, "x-note": 1 }]).problems, []);
  assert.deepEqual(checkTips("m", undefined), { tips: [], problems: [] });
  assert.match(checkTips("m", {}).problems[0], /must be a list/);
});

test("tips check: versions compare by number, a prerelease before its release", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.0-beta.1", "0.2.0"), -1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
});
