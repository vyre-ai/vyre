// @ts-check
// A named agent is not a delegate: it holds no right on a task of its own. The Flows service lends it tasks.read and tasks.work on the ONE task it was given (a minted grant on that task's address);
// the agent can then start and hand in that task, no other, and loses it when the lend ends.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";

const S = "spc_aaaaaaaaaaaa", OWNER = "per_owner";

test("a named agent can start its lent task, not another, and not after the lend ends", async () => {
  const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const flows = k.kernelFor({ name: "flows", needs: { kernel: { actions: [], mints: [{ prefix: "task", actions: ["tasks.read", "tasks.work"] }] } } });
  const scribe = { kind: "agent", id: "scribe", space: S };
  await k.gateway.grants.addActor(owner, scribe, {});
  const asAgent = () => k.chains.fromFacts({ kind: "agent_session", agent: "scribe", session: "s1", thread: "t1", person: OWNER, vouched: true });
  const mk = async (/** @type {string} */ title) => k.gateway.ask.request(owner, { title, doer: scribe, output: { kind: "note" }, source: "manual" });
  const mine = await mk("Draft the note"), other = await mk("Something else");

  await assert.rejects(() => k.gateway.ask.start(asAgent(), mine.id), /./, "before the lend it holds nothing on the task");

  const lend = (/** @type {string} */ id) => flows.mint.make({ subject: { kind: "actor", actor: scribe }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${S}/task/${id}` }, conditions: { when: { expires: Date.now() + 3600_000 } }, source: `flows:task:${id}`, reason: "the agent was given this task" });
  await lend(mine.id);
  const started = await k.gateway.ask.start(asAgent(), mine.id);
  assert.equal(started.state, "working", "the lent task starts");
  await assert.rejects(() => k.gateway.ask.start(asAgent(), other.id), /./, "another task stays closed");
  const done = await k.gateway.ask.complete(asAgent(), mine.id, { note: "Drafted.", sources: ["vyre://x/y/z"] });
  assert.ok(["done", "needs_check"].includes(done.state));

  const mine2 = await mk("Second");
  await lend(mine2.id);
  await flows.mint.end({ source: `flows:task:${mine2.id}`, reason: "the task is over" });
  await assert.rejects(() => k.gateway.ask.start(asAgent(), mine2.id), /./, "after the lend ends it holds nothing again");
});

test("a lend dies the moment its task is withdrawn, before anything takes the grant back", async () => {
  const k = await createKernel({ space: S, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const flows = k.kernelFor({ name: "flows", needs: { kernel: { actions: ["tasks.withdraw"], mints: [{ prefix: "task", actions: ["tasks.read", "tasks.work"] }] } } });
  const scribe = { kind: "agent", id: "scribe", space: S };
  await k.gateway.grants.addActor(owner, scribe, {});
  const asAgent = () => k.chains.fromFacts({ kind: "agent_session", agent: "scribe", session: "s1", thread: "t1", person: OWNER, vouched: true });
  const task = await k.gateway.ask.request(owner, { title: "Draft the note", doer: scribe, output: { kind: "note" }, source: "manual" });
  await flows.mint.make({ subject: { kind: "actor", actor: scribe }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${S}/task/${task.id}` }, conditions: { when: { expires: Date.now() + 3600_000 } }, source: `flows:task:${task.id}`, reason: "the task" });
  assert.equal((await k.gateway.ask.get(asAgent(), task.id)).id, task.id, "the lend works while the task is open");
  await k.gateway.ask.withdraw(k.chains.forModule({ module: "flows", approver: owner }), task.id, { reason: "due time" });
  // the grant is still there (nothing has taken it back yet) but it holds nothing
  assert.ok((await flows.mint.list({ source: `flows:task:${task.id}` })).length >= 1, "the lend has not been ended");
  await assert.rejects(() => k.gateway.ask.get(asAgent(), task.id), /./, "reading the task with the lend is refused");
  await assert.rejects(() => k.gateway.ask.complete(asAgent(), task.id, { note: "late", sources: ["vyre://x/y/z"] }), /./, "handing it in is refused");
});
