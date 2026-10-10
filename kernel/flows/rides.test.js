// A later send that rides an earlier step's yes (`with`): the signing Flow costs one yes and sends both messages.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { world, install, settle, ALEX } from "./testing/world.js";
import { catalog, SPACE } from "./testing/fixtures.js";
import { compileFlow } from "./compile.js";
import { printLines, parseLines } from "./lines.js";
import { sameFlow } from "./text.js";
import { checkRides, ridesOf, cardTitle } from "./rides.js";

const DAY = 86_400_000;
const cat = () => {
  const c = catalog();
  Object.assign(c.actions, {
    "esign.request": { risk: "outward.send", label: "Send for signature", tool: true, covers: ["esign.copy"] },
    "esign.copy": { risk: "outward.send", label: "Email the signed copy", tool: true },
    "esign.other": { risk: "outward.send", label: "Email something else", tool: true },
    "docs.send": { risk: "outward.send", label: "Send a document", tool: true, covers: ["comms.send", "mail.send"] },
    "docs.send-signed": { risk: "outward.send", label: "Email the signed copy", tool: true, covers: ["comms.send"] },
    "docs.send-other": { risk: "outward.send", label: "Email another way", tool: true, covers: ["sms.send"] },
    "esign.peek": { risk: "read", label: "Look up a document", tool: true },
  });
  return c;
};
const RES = `vyre://${SPACE}/esign`;
const request = { id: "request", kind: "call", action: "esign.request", resource: RES, input: { to: "dana@example.com" } };
const copy = (extra = {}) => ({ id: "copy", kind: "call", action: "esign.copy", resource: RES, label: "email Dana the signed copy", input: { to: "dana@example.com" }, with: "request", ...extra });
const flowOf = steps => ({ format: 1, name: "signing", label: "Signing", authorship: "human", trigger: { on: "event", event: "payment.received" }, steps });
const errorsOf = steps => { const out = []; checkRides(steps, cat(), out); return out.map(e => e.message); };

test("with: a later send rides when it files only sends the earlier one files too, even if the earlier list does not name the later tool", () => {
  const docs = { id: "docs", kind: "call", action: "docs.send", resource: RES, input: {} };
  const back = (action) => ({ id: "back", kind: "call", action, resource: RES, input: {}, with: "docs" });
  assert.deepEqual(errorsOf([docs, back("docs.send-signed")]), []);
  assert.match(errorsOf([docs, back("docs.send-other")])[0], /does not name docs.send-other/, "a send that goes out another way is not covered");
});

test("with: the rule is checked when the Flow is saved, with words that say what to change", () => {
  assert.deepEqual(errorsOf([request, { id: "w", kind: "wait", for_ms: DAY }, copy()]), []);
  assert.match(errorsOf([copy(), request])[0], /not an earlier send step/, "a step before it is no help");
  assert.match(errorsOf([request, copy({ with: "copy" })])[0], /its own yes/);
  assert.match(errorsOf([request, copy({ action: "esign.other" })])[0], /does not name esign.other among the sends it covers/, "the tool's own list decides, not the Flow's wish");
  assert.match(errorsOf([request, copy({ action: "esign.peek" })])[0], /not a send/);
  assert.match(errorsOf([{ id: "d", kind: "decide", if: "true", then: [request], else: [] }, copy()])[0], /not an earlier send step/, "a step in another branch is not on the path");
  assert.match(errorsOf([request, { id: "r", kind: "repeat", over: "[1,2]", as: "x", steps: [copy()] }])[0], /not an earlier send step/, "one yes is not spent again on every turn of a loop");
  assert.match(errorsOf([request, { id: "m", kind: "create", type: "matter", set: {}, with: "request" }])[0], /only a call step/);
  const c = compileFlow(flowOf([request, copy()]), cat());
  assert.equal(c.ok, true, JSON.stringify(c.errors));
  assert.equal(c.effects.outward.find(o => o.step === "copy").with, "request");
  const bad = compileFlow(flowOf([copy(), request]), cat());
  assert.equal(bad.ok, false);
});

test("with: the earlier step's card names both sends in plain words", () => {
  const rides = ridesOf(flowOf([request, copy()]), "request", cat());
  assert.deepEqual(rides, [{ step: "copy", action: "esign.copy", resource: RES, line: "email Dana the signed copy" }]);
  assert.equal(cardTitle("Signing", "Send for signature", rides), "Signing: Send for signature, and then email Dana the signed copy with this same yes?");
  assert.equal(cardTitle("Signing", "Send for signature", []), "Signing: Send for signature?");
});

async function signing(extra = {}) {
  const calls = [];
  const w = await world({ cat: cat(), ports: { call: async (c, action, res, input, opts) => { calls.push({ action, input, opts }); return { sent: true }; } } });
  const { id } = await install(w, flowOf([request, { id: "w", kind: "wait", for_ms: 2 * DAY }, copy(extra)]));
  w.kernel.inbound("payment.received", {});
  await settle(w);
  return { w, id, calls };
}
const held = w => w.kernel.tasks.filter(t => t.form && t.form.kind === "held_act");

test("with: the signing Flow costs exactly one yes and sends exactly two messages, days apart", async () => {
  const { w, id, calls } = await signing();
  const [card] = held(w);
  assert.equal(held(w).length, 1, "one question so far");
  assert.match(card.title, /send for signature, and then email Dana the signed copy/i, "the card names both");
  assert.deepEqual(card.form.rides.map(r => r.step), ["copy"]);
  w.kernel.completeTask(card.id, { outcome: "approved" });
  await settle(w);
  assert.deepEqual(calls.map(c => c.action), ["esign.request"], "the request went out");
  assert.equal((await w.runner.listRuns({ flow: id }))[0].state, "waiting", "the run waits for the signature");

  w.advance(2 * DAY + 60_000);
  await w.runner.tick(); await settle(w);
  assert.equal(held(w).length, 1, "no second question two days later");
  assert.deepEqual(calls.map(c => c.action), ["esign.request", "esign.copy"], "and the signed copy went out");
  const [first, second] = calls.map(c => c.opts);
  assert.equal(first.approval, card.id);
  assert.equal(first.ride, undefined);
  assert.equal(second.approval, card.id, "the copy carries the yes of the request");
  assert.deepEqual(second.ride, { run: (await w.runner.listRuns({ flow: id }))[0].id, step: "copy", with: "request" });
  assert.equal((await w.runner.listRuns({ flow: id }))[0].state, "done");
});

test("with: a no to the earlier step means the copy never goes", async () => {
  const { w, id, calls } = await signing();
  w.kernel.completeTask(held(w)[0].id, { outcome: "rejected" });
  await settle(w);
  w.advance(2 * DAY + 60_000);
  await w.runner.tick(); await settle(w);
  assert.deepEqual(calls.map(c => c.action), []);
  assert.equal((await w.runner.listRuns({ flow: id }))[0].state, "failed");
});

test("with: a step that is not declared to ride asks for itself", async () => {
  const { w, calls } = await signing({ with: undefined });
  w.kernel.completeTask(held(w)[0].id, { outcome: "approved" });
  await settle(w);
  w.advance(2 * DAY + 60_000);
  await w.runner.tick(); await settle(w);
  assert.equal(held(w).length, 2, "the copy asked its own question");
  assert.deepEqual(calls.map(c => c.action), ["esign.request"]);
});

test("with: a practice run counts one question for the pair", async () => {
  const w = await world({ cat: cat() });
  const t0 = w.clock.t;
  w.advance(DAY); w.kernel.inbound("payment.received", {});
  const sim = await w.runner.simulate(flowOf([request, copy()]), { approver: ALEX, since: t0, until: w.clock.t });
  assert.equal(sim.ok, true, JSON.stringify(sim.errors));
  assert.match(sim.summary, /asked for 1 approval\./);
  const alone = await w.runner.simulate(flowOf([request, copy({ with: undefined })]), { approver: ALEX, since: t0, until: w.clock.t });
  assert.match(alone.summary, /asked for 2 approvals\./, "and two without the ride");
});

test("with: the lines form and back keeps it", () => {
  const f = flowOf([request, copy()]);
  const back = parseLines(printLines(f));
  assert.equal(back.steps[1].with, "request");
  assert.equal(sameFlow(f, back), true);
});

test("with: a run that read content from outside, or a Flow a model drafted, asks about the rider too", async () => {
  for (const [label, flow, source] of [["outside content", flowOf([request, { id: "w", kind: "wait", for_ms: 2 * DAY }, copy()]), "external"], ["a model's Flow", { ...flowOf([request, { id: "w", kind: "wait", for_ms: 2 * DAY }, copy()]), authorship: "model" }, undefined]]) {
    const calls = [];
    const w = await world({ cat: cat(), ports: { call: async (c, action, res, input, opts) => { calls.push(action); return {}; } } });
    w.kernel.rules.push({ match: i => i.action === "esign.request" || i.action === "esign.copy", effect: "allow", reason: "x" });
    await install(w, flow);
    w.kernel.inbound("payment.received", {}, source);
    await settle(w);
    w.kernel.completeTask(held(w)[0].id, { outcome: "approved" });
    await settle(w);
    w.advance(2 * DAY + 60_000);
    await w.runner.tick(); await settle(w);
    assert.equal(held(w).length, 2, `${label}: the copy asked its own question`);
    assert.deepEqual(calls, ["esign.request"], `${label}: and did not go without it`);
  }
});
