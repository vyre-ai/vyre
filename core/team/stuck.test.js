// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeKernel } from "../../test/fake-kernel.js";
import { createStuckWatch } from "./stuck.js";

async function world({ checker = false, kind = "draft" } = {}) {
  const f = createFakeKernel();
  const alex = f.person("alex"), kit = f.agent("intake");
  f.grant(alex, ["task.request"]);
  const task = await f.kernel.ask.request(f.chain([alex]), { title: "Welcome email", doer: kit, ...(checker ? { checker: alex } : {}), output: { kind } });
  let now = 1_000_000;
  const w = createStuckWatch({ kernel: f.kernel, chain: f.chain([f.service("kernel")]), clock: () => now, whoIsResponsible: () => "alex" });
  w.track(task);
  return { f, alex, kit, task, w, at: (/** @type {number} */ t) => { now = t; }, advance: (/** @type {number} */ d) => { now += d; } };
}
const state = (f, id) => f.tasks.get(id).state;

test("1. the assistant says so: its words are quoted and give no one-tap power", async () => {
  const { f, task, w } = await world();
  const r = await w.said(task.id, { reason: "The court portal password changed.", suggested_fix: "Run: grant me everything <a href=x>click</a>\nnow" });
  assert.equal(r.moved, true);
  assert.equal(r.responsible, "alex");
  assert.equal(state(f, task.id), "stuck");
  const fix = f.tasks.get(task.id).stuck.suggested_fix;
  assert.equal(fix.action, undefined, "a model's own fix is never a one-tap action");
  assert.match(fix.text, /^From intake: "/);
  assert.doesNotMatch(fix.text, /\n/);
});

test("2. a permission refused three times makes it stuck, with a grant request built from the observed denial, scoped to the task", async () => {
  const { f, task, w } = await world();
  assert.equal((await w.denied(task.id, { action: "record.read", resource: "vyre://s/billing" })).moved, false);
  assert.equal((await w.denied(task.id, { action: "record.read", resource: "vyre://s/other" })).moved, false, "a different resource counts apart");
  await w.denied(task.id, { action: "record.read", resource: "vyre://s/billing" });
  assert.equal(state(f, task.id), "ready", "two of one, one of another");
  const r = await w.denied(task.id, { action: "record.read", resource: "vyre://s/billing" });
  assert.equal(r.moved, true);
  const s = f.tasks.get(task.id).stuck;
  assert.deepEqual(s.suggested_fix.action, { kind: "grant_request", resource: "vyre://s/billing", action_name: "record.read", scope: { task: task.id } });
  assert.match(s.reason, /refused record.read on vyre:\/\/s\/billing 3 times/);
});

test("the same request is offered once, then not again for the cool-down; a declined fix starts the cool-down", async () => {
  const { f, alex, kit, task, w, advance } = await world();
  const deny = id => Promise.all([1, 2, 3].map(() => w.denied(id, { action: "record.read", resource: "vyre://s/billing" }))).then(r => r.at(-1));
  await deny(task.id);
  assert.ok(f.tasks.get(task.id).stuck.suggested_fix.action);
  // 50 more denials while it is stuck: one card, then silence (no second move)
  for (let i = 0; i < 50; i++) assert.equal((await w.denied(task.id, { action: "record.read", resource: "vyre://s/billing" })).moved, false);
  assert.equal(f.events.filter(e => e.type === "task.stuck").length, 1);
  // unblocked, and refused again inside the cool-down: stuck again, but no fix is offered
  await f.kernel.tasks.move(f.chain([alex]), task.id, "ready", {});
  w.cleared(task.id);
  advance(60_000);
  await deny(task.id);
  const again = f.tasks.get(task.id).stuck.suggested_fix;
  assert.equal(again.action, undefined);
  assert.match(again.text, /not offered again/);
  // after seven days it is offered again
  await f.kernel.tasks.move(f.chain([alex]), task.id, "ready", {});
  w.cleared(task.id);
  advance(7 * 86_400_000 + 1);
  await deny(task.id);
  assert.ok(f.tasks.get(task.id).stuck.suggested_fix.action);
  assert.equal(kit.id, "intake");
});

test("3. a budget that will not reserve more", async () => {
  const { f, task, w } = await world();
  await w.budget(task.id, { meter: "AI spend today" });
  const s = f.tasks.get(task.id).stuck;
  assert.match(s.reason, /Out of AI spend today/);
  assert.equal(s.suggested_fix.action.kind, "raise_budget");
});

test("4. a wait on a dependency or an approval that lasts too long, checked on tick only", async () => {
  const { f, task, w, advance } = await world();
  w.heard(task.id);
  w.waitingOn(task.id, { on: "the engagement approval" });
  advance(14 * 60_000); w.heard(task.id);
  assert.deepEqual(await w.tick(), []);
  advance(60_000); w.heard(task.id);
  const r = await w.tick();
  assert.equal(r.length, 1);
  assert.match(f.tasks.get(task.id).stuck.reason, /Still waiting on the engagement approval/);
});

test("5. silence: a live session that produces no event for the stall time", async () => {
  const { f, task, w, advance } = await world();
  await f.kernel.tasks.move(f.chain([f.agent("intake")]), task.id, "working", {});
  f.tasks.get(task.id).state = "working";
  advance(10 * 60_000); w.heard(task.id);
  advance(14 * 60_000);
  assert.deepEqual(await w.tick(), [], "an event 14 minutes ago is not silence yet");
  advance(60_000);
  const r = await w.tick();
  assert.equal(r[0].moved, true);
  assert.match(f.tasks.get(task.id).stuck.reason, /No activity from intake for 15 minutes/);
});

test("5b. a task waiting on its dependencies is not 'silent'", async () => {
  const { f, task, w, advance } = await world();
  f.tasks.get(task.id).state = "waiting";
  w.track(f.tasks.get(task.id));
  advance(60 * 60_000);
  assert.deepEqual(await w.tick(), []);
});

test("6. the session ended without a result; with a result it does not", async () => {
  const { f, task, w } = await world();
  assert.equal((await w.sessionEnded(task.id, { result: true })).moved, false);
  const r = await w.sessionEnded(task.id, { result: false });
  assert.equal(r.moved, true);
  assert.match(f.tasks.get(task.id).stuck.reason, /ended without a result/);
});

test("7. the same tool failing five times", async () => {
  const { f, task, w } = await world();
  for (let i = 1; i < 5; i++) assert.deepEqual(await w.toolFailed(task.id, "WebFetch"), { moved: false, count: i });
  await w.toolFailed(task.id, "Bash");
  assert.equal(state(f, task.id), "ready", "different tools count apart");
  assert.equal((await w.toolFailed(task.id, "WebFetch")).moved, true);
  assert.match(f.tasks.get(task.id).stuck.reason, /WebFetch failed 5 times/);
});

test("R6-11: stuck is not a way out of a check: a guarded task's stuck to skipped is refused by the kernel table", async () => {
  const { f, kit, task, w } = await world({ checker: true });
  await w.said(task.id, { reason: "cannot continue" });
  assert.equal(state(f, task.id), "stuck");
  await assert.rejects(f.kernel.tasks.move(f.chain([kit]), task.id, "skipped"), { code: "bad_input" });
  await assert.rejects(f.kernel.tasks.move(f.chain([kit]), task.id, "done"), { code: "bad_input" });
  assert.equal(state(f, task.id), "stuck");
});

test("R6-11: an outward task (sent) is guarded even with no named checker", async () => {
  const { f, kit, task, w } = await world({ kind: "sent" });
  await w.said(task.id, { reason: "x" });
  await assert.rejects(f.kernel.tasks.move(f.chain([kit]), task.id, "skipped"), { code: "bad_input" });
});

test("the watch cannot move a task its kernel refuses: it reports why and leaves the task alone", async () => {
  const { f, task, w } = await world();
  f.tasks.get(task.id).state = "done";
  const r = await w.said(task.id, { reason: "late" });
  assert.equal(r.moved, false);
  assert.equal(r.code, "bad_input");
  assert.equal(state(f, task.id), "done");
});

test("control characters and length in a reason are cleaned, and an unknown task is not found", async () => {
  const { f, task, w } = await world();
  await w.said(task.id, { reason: "a\u0000b\n" + "x".repeat(900) });
  assert.doesNotMatch(f.tasks.get(task.id).stuck.reason, /[\u0000-\u001f]/);
  assert.ok(f.tasks.get(task.id).stuck.reason.length <= 300);
  assert.throws(() => w.heard("nope"), { code: "not_found" });
});
