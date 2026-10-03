import { test } from "node:test";
import assert from "node:assert/strict";
import { graph, paintRun, seeAsCode, fromCode, flowChanges, describeStep, describeTrigger, ops } from "./canvas.js";
import { checkFlow, canonical } from "./schema.js";
import { world, install, settle } from "./testing/world.js";
import { catalog, onPayment, SPACE } from "./testing/fixtures.js";

const cat = () => { const c = catalog(); c.actions["email.send"] = { risk: "outward.send", label: "Send an email" }; return c; };

test("canvas: the graph is the Flow in plain words, with a lane for each branch and marks for what is outward, sealed or waits", () => {
  const f = onPayment();
  f.steps.push({ id: "mail", kind: "call", action: "email.send", resource: `vyre://${SPACE}/mail/*`, input: { to: "a@example.com" } });
  const g = graph(f, cat());
  assert.equal(g.nodes[0].label, "When payment.received happens and the condition holds");
  const by = Object.fromEntries(g.nodes.map(n => [n.id, n]));
  assert.equal(by.open.label, "Create a matter");
  assert.equal(by.who.label, "Look up payment records that match");
  assert.equal(by.big.label, "Decide");
  assert.equal(by.note.lane, 1, "the then-branch is its own lane");
  assert.equal(by.ok.label, "Ask the attorney");
  assert.equal(by.ok.waits, true);
  assert.equal(by.mail.outward, true);
  assert.equal(by.mail.label, "Send an email");
  assert.ok(g.edges.some(e => e.from === "big" && e.to === "note" && e.kind === "then"));
  assert.ok(g.edges.some(e => e.from === "trigger" && e.to === "open"));
  assert.deepEqual(new Set(g.nodes.map(n => n.id)).size, g.nodes.length);
  assert.doesNotMatch(JSON.stringify(g.nodes.map(n => n.label)), /—|§/, "no em dashes or section signs in what a person reads");
  assert.equal(describeTrigger({ on: "time", every_ms: 7_200_000 }), "Every 2 hours");
  assert.equal(describeStep({ kind: "wait", for_ms: 86_400_000 }, cat()), "Wait 1 day");
});

test("canvas: a run is painted over the graph, with why it stopped", async () => {
  const w = await world();
  w.kernel.rules.push({ match: i => i.action === "records.create" && !i.approval, effect: "ask", reason: "needs_approval" });
  const { id } = await install(w, onPayment());
  w.kernel.inbound("payment.received", { amount: 1, client: "J" });
  await settle(w);
  const run = (await w.runner.listRuns({ flow: id }))[0];
  const p = paintRun(onPayment(), run, w.cat);
  const by = Object.fromEntries(p.nodes.map(n => [n.id, n]));
  assert.equal(by.trigger.state, "done");
  assert.equal(by.open.state, "waiting");
  assert.match(by.open.note, /Waiting for a person's yes/);
  assert.equal(by.who.state, "pending");
  assert.equal(p.state, "waiting");
});

test("canvas: See as code and back again gives the same Flow, and the hash is what an approval binds to", () => {
  const f = onPayment();
  const { text, hash } = seeAsCode(f);
  const r = fromCode(text, f, catalog());
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.same, true);
  assert.equal(r.hash, hash);
  assert.deepEqual(r.changes, []);
});

test("canvas: editing the code says in words what changed, and refuses what is not valid with a line", () => {
  const f = onPayment();
  const { text } = seeAsCode(f);
  const edited = text.replace("limit: 5", "limit: 9").replace("'Repeat client'", "'Repeat client, look twice'");
  const r = fromCode(edited, f, catalog());
  assert.equal(r.ok, true);
  assert.ok(r.changes.some(c => /Changes a step: Look up payment records/.test(c)));
  assert.ok(r.changes.some(c => /Changes a step: Give a task to the manager/.test(c)));
  const missingType = fromCode(text.replace("type: 'matter'", "type: 'ghost'"), f, catalog());
  assert.equal(missingType.ok, false);
  assert.match(missingType.errors[0].message, /no record type ghost/);
  const notTs = fromCode(text.replace("export default", "const x = require('fs');\nexport default"), f, catalog());
  assert.equal(notTs.ok, false);
  assert.match(notTs.errors[0].path, /^line \d+$/);
  assert.match(notTs.errors[0].message, /require is not allowed/);
});

test("canvas: flowChanges names trigger, authorship, added, removed, changed and reordered steps", () => {
  const a = onPayment();
  let b = ops.updateStep(a, "who", { limit: 2 });
  b = ops.removeStep(b, "note");
  b = ops.addStep(b, { id: "extra", kind: "wait", for_ms: 3_600_000 }, "open");
  b = ops.moveStep(b, "ok", -1);
  b = ops.setTrigger(b, { on: "manual" });
  b.authorship = "model";
  const c = flowChanges(a, b, catalog());
  assert.ok(c.some(x => /trigger changes/.test(x)));
  assert.ok(c.some(x => /Who made it changes from human to model/.test(x)));
  assert.ok(c.some(x => /Adds a step: Wait 1 hour/.test(x)));
  assert.ok(c.some(x => /Removes a step: Give a task to the manager/.test(x)));
  assert.ok(c.some(x => /Changes a step: Look up payment records/.test(x)));
  assert.ok(c.some(x => /different order/.test(x)));
});

test("canvas: the builder's edits never change their input and keep the Flow valid", () => {
  const a = onPayment();
  const before = canonical(a);
  const b = ops.addStep(a, { id: "n1", kind: "assign", to: "role:manager", title: "x", output: { kind: "note" } }, null);
  assert.equal(canonical(a), before);
  assert.equal(b.steps[0].id, "n1");
  const inBlock = ops.addStep(a, { id: "n2", kind: "wait", for_ms: 1000 }, null, { into: "big", block: "then" });
  assert.equal(inBlock.steps[2].then.length, 2);
  assert.deepEqual(checkFlow(inBlock), []);
  assert.throws(() => ops.updateStep(a, "open", { kind: "find" }), /keeps its id and kind/);
  assert.throws(() => ops.removeStep(a, "nope"), /no such step/);
  const unset = ops.updateStep(a, "who", { limit: undefined });
  assert.equal("limit" in unset.steps[1], false);
});
