// @ts-check
// Reading a plan (ExitPlanMode's markdown) into the plan card's parts: several shapes a plan comes
// in, and one with none of the sections. Nothing is made up. Sample world only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, fileOf, filesSummary, fileCounts, inlinePieces, planText, isPlanAsk, PLAN_MODES, planModeLabel } from "./plan.js";

const FULL = [
  "# Move the Northwind Bakery prices into one file",
  "",
  "The menu and the site each keep their own prices; this puts them in one table.",
  "",
  "1. Read `menu.md` and `site/prices.json` to list every item and price.",
  "2. Add `src/prices.js` with one table of items and prices.",
  "3. Change `site/menu.html` to read its prices from `src/prices.js`.",
  "4. Update `menu.md` so the autumn specials match the table.",
  "5. Run `npm test`, and add a test that every price has two decimals.",
  "",
  "Will not touch: the order form, `src/payments/` or anything outside ~/work/northwind.",
  "",
  "## Files it expects to change",
  "",
  "- `src/prices.js` (new, +60)",
  "- `site/menu.html` (+18 −12)",
  "- `menu.md` (+4 -4)",
  "- `test/prices.test.js` (new, +22)",
].join("\n");

test("plan: a full plan reads into its title, steps, what it will not touch, files and the rest", () => {
  const p = parsePlan(FULL);
  assert.equal(p.title, "Move the Northwind Bakery prices into one file");
  assert.equal(p.steps.length, 5);
  assert.equal(p.steps[0], "Read `menu.md` and `site/prices.json` to list every item and price.");
  assert.equal(p.steps[4], "Run `npm test`, and add a test that every price has two decimals.");
  assert.equal(p.notTouch, "the order form, `src/payments/` or anything outside ~/work/northwind.");
  assert.deepEqual(p.files.map(f => f.path), ["src/prices.js", "site/menu.html", "menu.md", "test/prices.test.js"]);
  assert.deepEqual(p.files[0], { path: "src/prices.js", added: 60, removed: null, isNew: true });
  assert.deepEqual(p.files[1], { path: "site/menu.html", added: 18, removed: 12, isNew: false });
  assert.equal(p.files[2].removed, 4, "a plain hyphen counts as a minus too");
  assert.equal(p.rest, "The menu and the site each keep their own prices; this puts them in one table.");
  assert.deepEqual(filesSummary(p.files), { count: "4 files", totals: "+104 −16" });
  assert.equal(fileCounts(p.files[0]), "new · +60");
  assert.equal(fileCounts(p.files[1]), "+18 −12");
});

test("plan: none of the sections: the first line is the title, bullets are the steps, nothing else is invented", () => {
  const p = parsePlan("Tidy the menu page\n\n- Fix the heading sizes\n- Move the opening hours to the footer\n");
  assert.equal(p.title, "Tidy the menu page");
  assert.deepEqual(p.steps, ["Fix the heading sizes", "Move the opening hours to the footer"]);
  assert.equal(p.notTouch, null);
  assert.deepEqual(p.files, []);
  assert.equal(p.rest, "");
});

test("plan: plain prose has a title and no steps; empty or missing input is empty", () => {
  const p = parsePlan("I will read menu.md and then tell alex what the specials are.");
  assert.equal(p.title, "I will read menu.md and then tell alex what the specials are.");
  assert.deepEqual(p.steps, []);
  assert.equal(p.rest, "");
  for (const v of ["", null, undefined, 42]) assert.deepEqual(parsePlan(v), { title: null, steps: [], notTouch: null, files: [], rest: "" });
});

test("plan: a numbered list wins over an earlier bullet list; a step's wrapped line and nested bullets stay with it", () => {
  const p = parsePlan([
    "## Plan: autumn specials",
    "",
    "Context:",
    "- the menu is `menu.md`",
    "- kit reviews the copy",
    "",
    "1) Swap the summer tart for the pumpkin loaf",
    "   and the apple cider donut.",
    "   - keep the prices at two decimals",
    "2) Run the menu tests",
  ].join("\n"));
  assert.equal(p.title, "Plan: autumn specials");
  assert.deepEqual(p.steps, ["Swap the summer tart for the pumpkin loaf and the apple cider donut.", "Run the menu tests"]);
  assert.match(p.rest, /Context:/);
  assert.match(p.rest, /kit reviews the copy/, "the bullet list that is not the steps stays in the rest");
});

test("plan: sections as headings, bold labels and lists; a steps heading is just a heading", () => {
  const p = parsePlan([
    "# Harlow Legal intake form, second pass",
    "",
    "## Steps",
    "1. Add the phone field to `src/intake/form.ts`",
    "2. Keep it optional",
    "",
    "## Will not touch",
    "- the general intake",
    "- `src/billing/`",
    "",
    "**Files:**",
    "- `src/intake/form.ts`",
    "- `src/intake/form.test.ts`",
  ].join("\n"));
  assert.equal(p.title, "Harlow Legal intake form, second pass");
  assert.deepEqual(p.steps, ["Add the phone field to `src/intake/form.ts`", "Keep it optional"]);
  assert.equal(p.notTouch, "the general intake, `src/billing/`");
  assert.deepEqual(p.files.map(f => f.path), ["src/intake/form.ts", "src/intake/form.test.ts"]);
  assert.deepEqual(filesSummary(p.files), { count: "2 files", totals: null }, "no counts in the plan, no totals");
  assert.equal(fileCounts(p.files[0]), "");
  assert.equal(p.rest, "## Steps");
});

test("plan: a list inside 'will not touch' is never the steps; a heading about files that is not a files list stays a heading", () => {
  const p = parsePlan("# File uploads for the bakery\n\nOut of scope:\n- payments\n- the order form\n\n- Add an upload button\n- Save uploads under `uploads/`\n");
  assert.equal(p.title, "File uploads for the bakery", "'File uploads' is a title, not a files section");
  assert.equal(p.notTouch, "payments, the order form");
  assert.deepEqual(p.steps, ["Add an upload button", "Save uploads under `uploads/`"]);
  assert.deepEqual(p.files, []);
});

test("plan: a file row without code spans takes its first word; counts only when written", () => {
  assert.deepEqual(fileOf("site/menu.html, +3 −1"), { path: "site/menu.html", added: 3, removed: 1, isNew: false });
  assert.deepEqual(fileOf("docs/price-list.md"), { path: "docs/price-list.md", added: null, removed: null, isNew: false }, "a hyphen in a path is not a count");
  assert.equal(fileOf("   "), null);
  assert.deepEqual(filesSummary([{ path: "a.js", added: 1, removed: null, isNew: true }]), { count: "1 file", totals: "+1 −0" });
});

test("plan: inline pieces, where the plan text sits on an ask, which asks are plans, and the two modes", () => {
  assert.deepEqual(inlinePieces("Run `npm test` then **stop**."), [
    { kind: "text", text: "Run " }, { kind: "code", text: "npm test" }, { kind: "text", text: " then " }, { kind: "strong", text: "stop" }, { kind: "text", text: "." }]);
  assert.deepEqual(inlinePieces(""), []);
  assert.equal(planText({ detail: { input: { plan: "# A" } } }), "# A");
  assert.equal(planText({ detail: { plan: "# B" } }), "# B");
  assert.equal(planText({ input: { plan: "# C" } }), "# C");
  assert.equal(planText({ detail: { input: {} } }), "");
  assert.equal(planText(null), "");
  assert.equal(isPlanAsk({ kind: "permission", tool: "ExitPlanMode" }), true);
  assert.equal(isPlanAsk({ kind: "plan" }), true);
  assert.equal(isPlanAsk({ kind: "permission", tool: "Bash" }), false);
  assert.equal(isPlanAsk(null), false);
  assert.deepEqual(PLAN_MODES.map(m => m.label), ["Asks first", "Edits allowed"]);
  assert.equal(planModeLabel("acceptEdits"), "Edits allowed");
  assert.equal(planModeLabel("anything"), "Asks first");
});
