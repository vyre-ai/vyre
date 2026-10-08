import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { AUTONOMY, BUDGET_STEPS, budgetLine, money, overLine, settingsGroups, toggleAccount, usedPercent, usedShare } from "./logic.js";

test("money has a dollar sign and thousands", () => {
  assert.equal(money(200), "$200");
  assert.equal(money(1200), "$1,200");
});

test("used share is a share of the budget, and no budget is no share", () => {
  assert.equal(usedShare(63, 200), 0.315);
  assert.equal(usedPercent(63, 200), 32);
  assert.equal(usedShare(10, 0), 0);
});

test("the budget line says the budget and what is used", () => {
  assert.equal(budgetLine({ budget: 200, used: 63 }), "Budget $200 a month, used $63 this month");
});

test("close and over budgets say so, an ordinary one says nothing", () => {
  assert.equal(overLine({ name: "Claude", budget: 100, used: 50 }), "");
  assert.equal(overLine({ name: "Claude", budget: 100, used: 95 }), "Claude is close to its budget.");
  assert.match(overLine({ name: "Claude", budget: 100, used: 120 }), /over its budget/);
});

test("connecting gives a budget and disconnecting clears it", () => {
  const on = toggleAccount({ name: "Grok", on: false, plan: "", budget: 0, used: 0 });
  assert.equal(on.on, true);
  assert.equal(on.budget, 50);
  assert.equal(toggleAccount(on).budget, 0);
});

test("three autonomy levels and five budget steps", () => {
  assert.equal(AUTONOMY.length, 3);
  assert.equal(BUDGET_STEPS.length, 5);
});

test("settings has five groups and the space group carries the space name", () => {
  const g = settingsGroups("Juniper Studio");
  assert.equal(g.length, 5);
  assert.equal(g[2].title, "Juniper Studio");
  assert.ok(g.flatMap((x) => x.rows).every((r) => r[2].startsWith("/u/")));
});

test("settings hides what a role cannot use", () => {
  const hrefs = (role) => settingsGroups("Juniper Studio", role).flatMap((g) => g.rows).map((r) => r[2]);
  assert.ok(hrefs(undefined).includes("/u/settings/rules"));
  assert.ok(hrefs("admin").includes("/u/settings/customize"));
  assert.ok(!hrefs("member").includes("/u/settings/customize"));
  assert.ok(!hrefs("manager").includes("/u/settings/privacy"));
  assert.ok(hrefs("member").includes("/u/settings/rules"));
  assert.ok(!hrefs("temp").includes("/u/settings/rules"));
  assert.ok(hrefs("member").includes("/u/spaces"));
  assert.ok(!hrefs("temp").includes("/u/memory"));
  assert.ok(hrefs("member").includes("/u/memory"));
  assert.ok(hrefs("temp").includes("/u/sidebar"), "everyone arranges their own sidebar");
});
