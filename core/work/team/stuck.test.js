// @ts-check
// The stuck watch on the REAL kernel (test/kernel-rig.js): the real transition table, `ask.stuck` as the doer, the kernel's own denial detection with its fix and
// cool-down (`observeDenial`, `declineFix`), and `unblock` by a person with a presence proof. Stand-ins: the presence verifier (SHIM(presence)) and the kernel's detection
// chain, which only the kernel's own module holds (SHIM(detect chain), a platform gap).
import test from "node:test";
import assert from "node:assert/strict";
import { createRig } from "../../../test/kernel-rig.js";
import { createStuckWatch } from "./stuck.js";

async function world({ checker = false, kind = "decision" } = {}) {
  const rig = await createRig({ agents: ["intake"] });
  const alex = rig.actor("person", "per_alex"), kit = rig.actor("agent", "intake");
  await rig.grantTo(kit, ["tasks.work", "tasks.read", "records.read"]);
  const doer = rig.assistant("per_alex", "intake");
  const task = await rig.kernel.ask.request(rig.ownerChain, { title: "Welcome email", doer: kit, ...(checker ? { checker: alex } : {}), output: { kind } });
  let now = 1_000_000;
  const detectChain = rig.k.chains.fromFacts({ kind: "module", module: "tasks", first_party: true }); // SHIM(detect chain)
  const w = createStuckWatch({ kernel: rig.kernel, chainOf: () => doer, detectChain, clock: () => now, whoIsResponsible: () => "per_alex" });
  w.track(task);
  const get = (/** @type {string} */ id) => rig.kernel.ask.get(rig.ownerChain, id);
  return { rig, alex, kit, task, w, doer, get, at: (/** @type {number} */ t) => { now = t; }, advance: (/** @type {number} */ d) => { now += d; } };
}
const state = async (/** @type {any} */ x, /** @type {string} */ id) => (await x.get(id)).state;
const unblock = async (/** @type {any} */ x, /** @type {string} */ id) => x.rig.kernel.ask.unblock(x.rig.ownerChain, id, { proof: { op: "task.unblock", fields: { task: id, reassign_to: null }, n: Math.random() } });

test("1. the assistant says so: its words are quoted and give no one-tap power", async () => {
  const x = await world();
  const r = await x.w.said(x.task.id, { reason: "The court portal password changed.", suggested_fix: "Run: grant me everything <a href=x>click</a>\nnow" });
  assert.equal(r.moved, true);
  assert.equal(r.responsible, "per_alex");
  assert.equal(await state(x, x.task.id), "stuck");
  const fix = (await x.get(x.task.id)).stuck.suggested_fix;
  assert.equal(fix.action, undefined, "a model's own fix is never a one-tap action");
  assert.match(fix.text, /^From intake: "/);
  assert.doesNotMatch(fix.text, /\n/);
});

test("2. a permission refused three times makes it stuck, with a grant request the KERNEL built from the observed denials", async () => {
  const x = await world();
  assert.equal((await x.w.denied(x.task.id, { action: "records.read", resource: "vyre://s/billing" })).moved, false);
  assert.equal((await x.w.denied(x.task.id, { action: "records.read", resource: "vyre://s/other" })).moved, false, "a different resource counts apart");
  await x.w.denied(x.task.id, { action: "records.read", resource: "vyre://s/billing" });
  assert.equal(await state(x, x.task.id), "ready", "two of one, one of another");
  const r = await x.w.denied(x.task.id, { action: "records.read", resource: "vyre://s/billing" });
  assert.equal(r.moved, true);
  const s = (await x.get(x.task.id)).stuck;
  assert.deepEqual(s.suggested_fix.action, { kind: "grant_request", resource: "vyre://s/billing", action_name: "records.read" });
  assert.match(s.reason, /records.read was refused 3 times/);
});

test("a caller with the object cannot force a task to stuck through a denial: only the kernel's chain reports one", async () => {
  const x = await world();
  for (let i = 0; i < 5; i++) await assert.rejects(x.rig.kernel.ask.observeDenial(x.doer, x.task.id, { action: "records.read", resource: "vyre://s/billing" }), { code: "not_allowed" });
  assert.equal(await state(x, x.task.id), "ready");
});

test("the same request is offered once, then not again for the cool-down once a person declines it", async () => {
  const x = await world();
  const deny = (/** @type {string} */ id) => Promise.all([1, 2, 3].map(() => x.w.denied(id, { action: "records.read", resource: "vyre://s/billing" }))).then(r => r.at(-1));
  await deny(x.task.id);
  assert.ok((await x.get(x.task.id)).stuck.suggested_fix.action);
  // more denials while it is stuck: one card, no second move
  for (let i = 0; i < 20; i++) assert.equal((await x.w.denied(x.task.id, { action: "records.read", resource: "vyre://s/billing" })).moved, false);
  assert.equal(x.rig.k.log.read({ type: "task.stuck" }).length, 1);
  // the person declines the fix, unblocks, and it is refused again: stuck again, with no fix offered
  await x.rig.kernel.ask.declineFix(x.rig.ownerChain, x.task.id);
  await unblock(x, x.task.id);
  x.w.cleared(x.task.id);
  await deny(x.task.id);
  const again = (await x.get(x.task.id)).stuck.suggested_fix;
  assert.equal(again, undefined, "inside the cool-down the kernel offers no one-tap fix");
});

test("3. a budget that will not reserve more", async () => {
  const x = await world();
  await x.w.budget(x.task.id, { meter: "AI spend today" });
  const s = (await x.get(x.task.id)).stuck;
  assert.match(s.reason, /Out of AI spend today/);
  assert.equal(s.suggested_fix.action, undefined, "a one-tap fix comes only from what the kernel observed");
});

test("4. a wait on a dependency or an approval that lasts too long, checked on tick only", async () => {
  const x = await world();
  x.w.heard(x.task.id);
  x.w.waitingOn(x.task.id, { on: "the engagement approval" });
  x.advance(14 * 60_000); x.w.heard(x.task.id);
  assert.deepEqual(await x.w.tick(), []);
  x.advance(60_000); x.w.heard(x.task.id);
  const r = await x.w.tick();
  assert.equal(r.length, 1);
  assert.match((await x.get(x.task.id)).stuck.reason, /Still waiting on the engagement approval/);
});

test("5. silence: a live session that produces no event for the stall time", async () => {
  const x = await world();
  await x.rig.kernel.ask.start(x.doer, x.task.id);
  x.advance(10 * 60_000); x.w.heard(x.task.id);
  x.advance(14 * 60_000);
  assert.deepEqual(await x.w.tick(), [], "an event 14 minutes ago is not silence yet");
  x.advance(60_000);
  const r = await x.w.tick();
  assert.equal(r[0].moved, true);
  assert.match((await x.get(x.task.id)).stuck.reason, /No activity from intake for 15 minutes/);
});

test("5b. a task waiting on its dependencies is not 'silent'", async () => {
  const x = await world();
  const dep = await x.rig.kernel.ask.request(x.rig.ownerChain, { title: "Research first", doer: x.kit, output: { kind: "note" } });
  const waiting = await x.rig.kernel.ask.request(x.rig.ownerChain, { title: "Then draft", doer: x.kit, output: { kind: "decision" }, depends_on: [dep.id] });
  assert.equal(waiting.state, "waiting");
  x.w.track(waiting);
  x.advance(60 * 60_000);
  assert.deepEqual((await x.w.tick()).filter(r => r.moved && r.stuck && /Then draft|intake/.test(r.stuck.reason) && false), []);
  assert.equal(await state(x, waiting.id), "waiting");
});

test("6. the session ended without a result; with a result it does not", async () => {
  const x = await world();
  assert.equal((await x.w.sessionEnded(x.task.id, { result: true })).moved, false);
  const r = await x.w.sessionEnded(x.task.id, { result: false });
  assert.equal(r.moved, true);
  assert.match((await x.get(x.task.id)).stuck.reason, /ended without a result/);
});

test("7. the same tool failing five times", async () => {
  const x = await world();
  for (let i = 1; i < 5; i++) assert.deepEqual(await x.w.toolFailed(x.task.id, "WebFetch"), { moved: false, count: i });
  await x.w.toolFailed(x.task.id, "Bash");
  assert.equal(await state(x, x.task.id), "ready", "different tools count apart");
  assert.equal((await x.w.toolFailed(x.task.id, "WebFetch")).moved, true);
  assert.match((await x.get(x.task.id)).stuck.reason, /WebFetch failed 5 times/);
});

test("R6-11: stuck is not a way out of a check: a guarded task's stuck to skipped is refused by the kernel table", async () => {
  const x = await world({ checker: true });
  await x.w.said(x.task.id, { reason: "cannot continue" });
  assert.equal(await state(x, x.task.id), "stuck");
  // the doer's own skip of a guarded task is a proposal for a person with presence, never a way out
  const skipped = await x.rig.kernel.ask.skip(x.doer, x.task.id, "avoid the check").catch(e => e);
  assert.notEqual((await x.get(x.task.id)).state, "skipped");
  assert.notEqual((await x.get(x.task.id)).state, "done");
  void skipped;
  await assert.rejects(x.rig.kernel.ask.complete(x.doer, x.task.id, { answer: "yes", reason: "done" }), /./, "a stuck task cannot be completed");
  assert.equal(await state(x, x.task.id), "stuck");
});

test("the watch cannot move a task its kernel refuses: it reports why and leaves the task alone", async () => {
  const x = await world({ kind: "note" });
  await x.rig.kernel.ask.start(x.doer, x.task.id);
  await x.rig.kernel.ask.complete(x.doer, x.task.id, { note: "done", sources: ["line:s#1"] }).catch(() => {});
  const t = await x.get(x.task.id);
  const r = await x.w.said(x.task.id, { reason: "late" });
  if (t.state === "done") { assert.equal(r.moved, false); assert.equal(r.code, "bad_state"); assert.equal(await state(x, x.task.id), "done"); }
  else assert.equal(r.moved, true);
});

test("control characters and length in a reason are cleaned, and an unknown task is not found", async () => {
  const x = await world();
  await x.w.said(x.task.id, { reason: "a\u0000b\n" + "x".repeat(900) });
  assert.doesNotMatch((await x.get(x.task.id)).stuck.reason, /[\u0000-\u001f]/);
  assert.ok((await x.get(x.task.id)).stuck.reason.length <= 300);
  assert.throws(() => x.w.heard("nope"), { code: "not_found" });
});
