import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import fs from "node:fs";
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

test("settings is your account in the Space, the Space and Everywhere with nothing behind an Advanced switch, and the space group carries the space name", () => {
  const g = settingsGroups("Juniper Studio");
  assert.deepEqual(g.map((x) => x.title), ["Your account in Juniper Studio", "Juniper Studio", "Everywhere"]);
  assert.ok(g.every((x) => !("advanced" in x)), "no Advanced group: the owner found half-built pages there (owner, 20 Oct)");
  assert.ok(g.flatMap((x) => x.rows).every((r) => r[2].startsWith("/u/")));
  assert.deepEqual(g.map((x) => x.rows.length), [5, 8, 3], "a short list an owner reads in one look");
});

test("Skills and plugins is one row, opening the library with its own Personal and Space switch", () => {
  const rows = settingsGroups("Juniper Studio").flatMap((x) => x.rows);
  assert.deepEqual(rows.filter((r) => r[2].startsWith("/u/skills")).map((r) => r[2]), ["/u/skills"]);
});

test("settings hides what a role cannot use", () => {
  const hrefs = (role, labs = false) => settingsGroups("Juniper Studio", role, { labs }).flatMap((g) => g.rows).map((r) => r[2]);
  assert.ok(hrefs("admin").includes("/u/settings/roles"));
  assert.ok(!hrefs("member").includes("/u/settings/roles"));
  assert.ok(!hrefs("manager").includes("/u/settings/privacy"));
  assert.ok(!hrefs("temp").includes("/u/settings/assistant-access"), "a temp member is not offered what agents may do");
  assert.ok(hrefs("member").includes("/u/spaces"));
  assert.ok(hrefs("temp").includes("/u/sidebar"), "everyone arranges their own sidebar");
  // the archived pages, shown with Labs on, keep their role limits
  assert.ok(hrefs("admin", true).includes("/u/settings/audit"));
  assert.ok(!hrefs("member", true).includes("/u/settings/audit"));
  assert.ok(hrefs("member", true).includes("/u/settings/rules"));
  assert.ok(!hrefs("temp", true).includes("/u/settings/rules"));
});

test("archived pages: off the list by default, back as a last Labs group with Labs on, each with a reason", async () => {
  const { ARCHIVED, archivedAt, labsRows } = await import("./archived.js");
  const shown = settingsGroups("Juniper Studio").flatMap((g) => g.rows).map((r) => r[2]);
  for (const a of ARCHIVED) {
    assert.ok(!shown.includes(a.href), `${a.title} (${a.href}) is archived but still on the Settings list`);
    assert.ok(a.reason && a.reason.length > 20 && !/[—§]/.test(a.reason), `${a.title} needs a one-line reason`);
    assert.ok(["archived", "merged", "moved"].includes(a.kind));
    if (a.kind === "merged") assert.ok(a.into, `${a.title} says where it went`);
  }
  for (const href of ["/u/settings/audit", "/u/settings/rules"]) assert.ok(archivedAt(href), `${href} is archived (owner, 20 Oct)`);
  assert.equal(archivedAt("/u/settings/devices"), null);
  assert.equal(archivedAt("/u/settings/backups"), null, "a merged page is not gated: its route goes to where it went");
  const labs = settingsGroups("Juniper Studio", undefined, { labs: true });
  assert.equal(labs.at(-1).title, "Labs");
  assert.deepEqual(labs.at(-1).rows, labsRows());
  assert.deepEqual(labs.slice(0, -1), settingsGroups("Juniper Studio"), "Labs only adds a group at the end");
});

test("every place in Settings has its own icon, and each one is in the family", () => {
  const rows = settingsGroups("Juniper Studio").flatMap((g) => g.rows);
  const icons = rows.map((r) => r[3]);
  assert.equal(new Set(icons).size, icons.length, `two places share an icon: ${icons.filter((x, i) => icons.indexOf(x) !== i).join(", ")}`);
  const family = fs.readFileSync(new URL("../../src/ui/icons.generated.ts", import.meta.url), "utf8");
  for (const icon of icons) assert.ok(family.includes(`"${icon}"`), `${icon} is not an icon of the family`);
});

test("only the sign-in and the devices are the same in every Space; every other page is the Space's", () => {
  const g = settingsGroups("Juniper Studio");
  const everywhere = g.find((x) => x.title === "Everywhere").rows.map((r) => r[2]);
  assert.ok(everywhere.includes("/u/settings/account") && everywhere.includes("/u/settings/devices"));
  for (const href of ["/u/settings/ai", "/u/settings/notifications", "/u/appearance", "/u/sidebar"]) assert.ok(!everywhere.includes(href), `${href} is per Space`);
});
