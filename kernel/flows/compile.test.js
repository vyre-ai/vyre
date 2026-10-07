import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkFlow, canonical, flowHash, sourceHash } from "./schema.js";
import { compileFlow, deriveCaps, urnCovers, parseCron, nextCron } from "./compile.js";
import { catalog, onPayment, SPACE } from "./testing/fixtures.js";

const bad = (flow, re, cat = catalog()) => {
  const r = compileFlow(flow, cat);
  assert.equal(r.ok, false, "should not compile");
  assert.ok(r.errors.some(e => re.test(e.message)), `expected ${re}, got ${JSON.stringify(r.errors)}`);
  return r;
};
const mutate = f => { const x = structuredClone(onPayment()); f(x); return x; };

test("schema: the sample Flow is valid and compiles, with its effects spelled out", () => {
  assert.deepEqual(checkFlow(onPayment()), []);
  const r = compileFlow(onPayment(), catalog());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.effects.reads, ["payment"]);
  assert.deepEqual(r.effects.writes, ["matter"]);
  assert.equal(r.effects.asks, 1);
  assert.deepEqual(r.effects.assigns.map(a => a.to), ["role:manager"]);
  assert.ok(r.caps.some(c => c.action === "records.create" && c.resource === `vyre://${SPACE}/matter/*`), "caps are derived from the steps");
  assert.ok(r.warnings.some(w => /no caps are declared/.test(w.message)));
});

test("schema: every problem is reported with a path, not just the first", () => {
  const f = mutate(x => { x.name = "Bad Name"; x.steps[0].id = "Open"; x.steps[1].kind = "teleport"; x.trigger.on = "nope"; });
  const p = checkFlow(f).map(e => e.path);
  assert.ok(p.includes("name") && p.includes("steps[0].id") && p.includes("steps[1].kind") && p.includes("trigger"));
});

test("compile: unknown types, fields, stages, teammates, roles and actions are errors before anything is saved", () => {
  bad(mutate(x => { x.steps[0].type = "ghost"; }), /no record type ghost/);
  bad(mutate(x => { x.steps[0].set.nope = 1; }), /no field nope/);
  bad(mutate(x => { x.steps.push({ id: "mv", kind: "stage", type: "matter", record: { expr: "steps.open.record" }, to: "Closed" }); }), /no stage Closed/);
  bad(mutate(x => { x.steps[2].then[0].to = "role:janitor"; }), /no role janitor/);
  bad(mutate(x => { x.steps.push({ id: "ag", kind: "agent", assistant: "teammate:ghost", title: "t", instructions: "i", output: { kind: "note" } }); }), /no teammate ghost/);
  bad(mutate(x => { x.steps.push({ id: "c", kind: "call", action: "email.teleport", resource: `vyre://${SPACE}/mail/*` }); }), /no action email.teleport/);
  bad(mutate(x => { x.trigger = { on: "stage", type: "matter", stage: "Nowhere" }; }), /no stage Nowhere/);
});

test("compile: a sealed field cannot be written by a Flow", () => {
  bad(mutate(x => { x.steps[0].set.ssn = "123-45-6789"; }), /sealed: a Flow cannot write a sealed value/);
});

test("compile: expressions may read only what exists at that point, and only steps that already ran", () => {
  bad(mutate(x => { x.steps[1].where = "record.client == secret.value"; }), /secret is not available/);
  bad(mutate(x => { x.steps[1].where = "record.client == steps.ok.answer"; }), /steps.ok is not a step that has already run/);
  bad(mutate(x => { x.steps[1].where = "record.client =="; }), /does not parse|ends too soon/);
  const inLoop = mutate(x => { x.steps.push({ id: "each", kind: "repeat", over: "steps.who.rows", as: "row", steps: [{ id: "n", kind: "assign", to: "role:manager", title: { expr: "row.client" }, output: { kind: "note" } }] }); });
  assert.equal(compileFlow(inLoop, catalog()).ok, true);
  const outside = mutate(x => { x.steps.push({ id: "n2", kind: "assign", to: "role:manager", title: { expr: "row.client" }, output: { kind: "note" } }); });
  bad(outside, /row is not available/);
});

test("compile: an action and a resource are written out, never read from a value", () => {
  const f = mutate(x => { x.steps.push({ id: "c", kind: "call", action: { expr: "trigger.action" }, resource: `vyre://${SPACE}/mail/*` }); });
  assert.ok(checkFlow(f).some(e => /written out/.test(e.message)));
});

test("compile: declared caps must cover every step, and a narrower cap list is honoured", () => {
  const cat = catalog();
  const caps = deriveCaps(onPayment(), cat);
  const withCaps = mutate(x => { x.caps = caps; });
  assert.equal(compileFlow(withCaps, cat).ok, true);
  const narrow = mutate(x => { x.caps = caps.filter(c => c.action !== "records.create"); });
  bad(narrow, /caps do not cover records.create/);
  assert.ok(urnCovers("vyre://s/matter/*", "vyre://s/matter/abc"));
  assert.ok(!urnCovers("vyre://s/matter/*", "vyre://s/payment/abc"));
  assert.ok(urnCovers("vyre://*/matter/*", "vyre://s/matter/abc"));
});

test("compile: a model-drafted Flow with an outward step to a computed destination needs an Ask on every run", () => {
  const f = mutate(x => { x.authorship = "model"; x.steps.push({ id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: { expr: "trigger.email" }, body: "hello" } }); });
  const r = compileFlow(f, catalog());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.effects.needs_run_ask, true);
  assert.equal(r.effects.outward[0].destination_constant, false);
  const human = mutate(x => { x.steps.push({ id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com", body: "hello" } }); });
  const rh = compileFlow(human, catalog());
  assert.equal(rh.effects.needs_run_ask, false);
  assert.equal(rh.effects.outward[0].destination_constant, true);
});

test("schema: a Code step names its inputs and outputs and its hash must match its source", () => {
  const src = "return { total: inputs.a + inputs.b };";
  const ok = mutate(x => { x.steps.push({ id: "sum", kind: "fn", language: "js", source: src, hash: sourceHash(src), inputs: { a: 1, b: { expr: "trigger.amount" } }, outputs: ["total"], needs: [] }); });
  assert.equal(compileFlow(ok, catalog()).ok, true);
  assert.equal(compileFlow(ok, catalog()).effects.code[0].hash, sourceHash(src));
  const tampered = mutate(x => { x.steps.push({ id: "sum", kind: "fn", language: "js", source: src + " ", hash: sourceHash(src), inputs: {}, outputs: ["total"] }); });
  bad(tampered, /hash does not match/);
});

test("schema: canonical form is key-order independent and the hash follows content", () => {
  const a = onPayment(), b = JSON.parse(JSON.stringify(onPayment(), (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)));
  assert.equal(canonical(a), canonical(b));
  assert.equal(flowHash(a), flowHash(b));
  assert.notEqual(flowHash(a), flowHash(mutate(x => { x.name = "other"; })));
});

test("cron: five fields, ranges and steps, and the next fire time", () => {
  assert.equal(parseCron("0 3 * * *").ok, true);
  assert.equal(parseCron("*/15 * * * *").ok, true);
  assert.equal(parseCron("61 * * * *").ok, false);
  assert.equal(parseCron("* * *").ok, false);
  const t = Date.UTC(2026, 9, 3, 12, 0, 0);
  assert.equal(nextCron("0 3 * * *", t), Date.UTC(2026, 9, 4, 3, 0, 0));
  assert.equal(nextCron("*/15 * * * *", t), Date.UTC(2026, 9, 3, 12, 15, 0));
  assert.equal(nextCron("30 9 * * 1", t), Date.UTC(2026, 9, 5, 9, 30, 0));
  assert.equal(nextCron("0 0 31 2 *", t), null);
});
