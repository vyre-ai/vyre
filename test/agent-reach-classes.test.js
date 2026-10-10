// @ts-check
// The person's assistant does what its person can, except where there is a written reason (core/modules/agent-reach.js). These are the classifications the 10 Oct sweep made for tools that arrived
// unclassified: what the person's assistant may call (OPEN), what stays the person's own and why (PERSON_ONLY), and that no tool sits in two lists.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { OPEN, PERSON_ONLY, ASK_FIRST } from "../core/modules/agent-reach.js";

test("the release notes and the run and stage answers are open to the person's assistant", () => {
  for (const t of ["update.whats-new", "update.whats-new-seen", "flows.settle", "flows.advance"]) assert.ok(OPEN.has(t), `${t} is open`);
});

test("approving, rolling back, removing a test case, spending on an eval and the Mac's lid stay the person's own, each with a reason", () => {
  for (const t of ["approvals.local-yes", "flows.rollback", "flows.test.remove", "models.eval-approve", "models.eval-decline", "models.eval-record", "link.sleep", "link.wake"]) {
    assert.ok(PERSON_ONLY.has(t), `${t} is person only`);
    assert.ok(String(PERSON_ONLY.get(t)).length > 30, `${t} says why`);
  }
});

test("a tool is in at most one of the three lists", () => {
  const seen = new Map();
  for (const [list, names] of /** @type {[string, Iterable<string>][]} */ ([["open", OPEN], ["person only", PERSON_ONLY.keys()], ["ask first", ASK_FIRST.keys()]])) {
    for (const n of names) { assert.equal(seen.get(n), undefined, `${n} is in ${seen.get(n)} and ${list}`); seen.set(n, list); }
  }
});
