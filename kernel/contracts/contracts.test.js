// @ts-check
// The studs are data: every table is frozen, internally consistent and free of functions.
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "./index.js";

test("every export is frozen data, never a function", () => {
  for (const [name, v] of Object.entries(c)) {
    assert.notEqual(typeof v, "function", `${name} must not be a function`);
    if (Array.isArray(v)) assert.ok(Object.isFrozen(v), `${name} must be frozen`);
  }
});

test("enum tables have no duplicates", () => {
  for (const [name, v] of Object.entries(c)) if (Array.isArray(v) && typeof v[0] === "string") assert.equal(new Set(v).size, v.length, name);
});

test("the task transitions only use known states, and terminal states have no exits", () => {
  const states = new Set(c.TASK_STATES);
  for (const r of c.TASK_TRANSITIONS) {
    assert.ok(states.has(r.from) && states.has(r.to), JSON.stringify(r));
    assert.ok(Object.isFrozen(r));
    assert.ok(!["done", "skipped"].includes(r.from), "done and skipped are terminal");
  }
});

test("a checked or outward task can never be skipped or completed by its doer alone", () => {
  const guarded = c.TASK_TRANSITIONS.filter(r => r.guarded === true);
  for (const r of guarded.filter(r => r.to === "skipped")) assert.equal(r.by, "proposal_for_person_with_presence");
  const toDone = c.TASK_TRANSITIONS.filter(r => r.to === "done" && r.from === "needs_check");
  assert.deepEqual(toDone.map(r => r.by), ["checker_approval"]);
  assert.ok(!c.TASK_TRANSITIONS.some(r => r.from === "working" && r.to === "done" && r.guarded !== false), "working to done only for tasks with no checker");
});

test("trust and redaction orders match the contract", () => {
  assert.deepEqual([...c.TRUST_ORDER], ["untrusted", "external", "member", "system"]);
  assert.ok(c.REDACTION_ORDER.indexOf("privileged") > c.REDACTION_ORDER.indexOf("pii"));
});

test("every outward risk is a risk", () => {
  for (const r of c.OUTWARD_RISKS) assert.ok(c.RISKS.includes(r));
});

test("roles: five fixed bundles, each a subset of the one above, temp needs a scope", async () => {
  const { ROLE_IDS, ROLE_BUNDLES } = await import("./index.js");
  assert.deepEqual([...ROLE_IDS], ["owner", "admin", "manager", "member", "temp"]);
  for (const id of ROLE_IDS) assert.equal(ROLE_BUNDLES[id].role, id);
  for (const [hi, lo] of [["owner", "admin"], ["admin", "manager"], ["manager", "member"]]) {
    for (const a of ROLE_BUNDLES[lo].abilities) assert.ok(ROLE_BUNDLES[hi].abilities.includes(a), `${lo} has ${a} that ${hi} lacks`);
  }
  for (const id of ROLE_IDS) for (const a of ROLE_BUNDLES[id].never) assert.ok(!ROLE_BUNDLES[id].abilities.includes(a), `${id} both has and never has ${a}`);
  assert.equal(ROLE_BUNDLES.temp.requires_scope, true);
  assert.equal(ROLE_BUNDLES.temp.assistants_act_for_holder, false);
  assert.ok(!ROLE_BUNDLES.admin.abilities.includes("space.delete"));
  assert.ok(Object.isFrozen(ROLE_BUNDLES.owner) && Object.isFrozen(ROLE_BUNDLES.owner.abilities));
});
