// @ts-check
// An agent asked to review or to approve a task holds that one task for the round, through the grant the Flows service mints (core/daemon/flows-host.js slotLend), on a REAL vyred with the kernel on: the reviewer
// can review it and nothing else, the approver can decide an internal task, a reviewer's grant cannot decide, and another task is out of reach. Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a reviewer or approver agent holds one task for a round through the minted grant, and nothing else", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space, ask = K.gateway.ask;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const anaChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" });
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "member" }, { presence: proof() });
  const token = (await K.surfaces.open(ownerChain, {})).token;
  const made = await d.registry.call("agents.create", { name: "rev", kind: "agent", projects: "*" }, "cli", { token });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  const rev = { kind: "agent", id: "rev", space };
  await K.gateway.grants.addActor(ownerChain, rev, {});
  // what the Flows host mints for the round: the manifest's own list of what it may lend
  const needs = JSON.parse(fs.readFileSync(new URL("../core/flows/module.json", import.meta.url), "utf8")).needs;
  const sh = K.kernelFor({ name: "flows", needs });
  const lend = (/** @type {any} */ task, /** @type {string} */ slot, /** @type {string | undefined} */ thread) => sh.mint.make({ subject: { kind: "actor", actor: rev }, actions: slot === "approver" ? ["tasks.read", "tasks.work", "tasks.decide"] : ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/${task.id}` }, conditions: { when: { expires: Date.now() + 3600_000 }, ...(thread ? { where: { sessions: [thread] } } : {}) }, source: `flows:task:${task.id}:${slot}`, reason: "test" });
  const agentChain = (/** @type {string} */ thread) => K.chains.fromFacts({ kind: "agent_session", agent: "rev", session: thread, thread, person: OWNER, vouched: true });
  const given = (/** @type {any} */ over) => ask.request(ownerChain, { title: "Write it", doer: { kind: "person", id: ANA, space }, output: { kind: "note" }, ...over });
  // The daemon wakes an agent that holds a slot as soon as the task enters it (agent-wake.js), and with no model to run here that wake ends and takes its hold back. The test waits for that to happen, then mints the
  // round's grant itself, so what it proves does not depend on the race. Under load the wake can come late, so the wait is on the state, not a pause: first the wake's grant appears (any status), then none is active.
  const mine = async (/** @type {string} */ id) => (await K.gateway.grants.list(ownerChain)).filter((/** @type {any} */ g) => String(g.source || "").startsWith(`flows:task:${id}:`));
  const settle = async (/** @type {string} */ id) => {
    const until = Date.now() + 40_000;
    while (Date.now() < until && !(await mine(id)).length) await new Promise(r => setTimeout(r, 100));
    while (Date.now() < until && (await mine(id)).some((/** @type {any} */ g) => g.status === "active")) await new Promise(r => setTimeout(r, 100));
  };
  const handIn = async (/** @type {string} */ id) => { await ask.start(anaChain, id); const done = await ask.complete(anaChain, id, { note: "done", sources: ["https://example.test/a"] }); await settle(id); return done; };

  // reviewer: before the grant it can do nothing; with it, it reviews this task, not another
  const a = await given({ reviewer: rev });
  const other = await given({ reviewer: rev });
  assert.equal((await handIn(a.id)).state, "in_review");
  await handIn(other.id);
  await assert.rejects(ask.review(agentChain("job-1"), a.id, { result: "pass" }), "no grant, no review");
  await lend(a, "reviewer", "job-1");
  await assert.rejects(ask.review(agentChain("job-2"), a.id, { result: "pass" }), "the grant is held to the job's thread");
  await assert.rejects(ask.review(agentChain("job-1"), other.id, { result: "pass" }), "another task is out of reach");
  // the round's grant is for reviewing, not for acting as the doer: with it in force the agent cannot work, hand in, flag or change the task
  for (const act of [() => ask.start(agentChain("job-1"), a.id), () => ask.complete(agentChain("job-1"), a.id, { note: "x", sources: ["https://example.test/b"] }), () => ask.stuck(agentChain("job-1"), a.id, { reason: "x" }), () => ask.update(agentChain("job-1"), a.id, { note: "x" }), () => ask.decline(agentChain("job-1"), a.id, "x")]) await assert.rejects(act(), e => ["not_allowed", "not_found", "bad_state"].includes(e.code));
  assert.equal((await ask.review(agentChain("job-1"), a.id, { result: "pass" })).state, "done", "the reviewer agent passes the task it was asked to review");

  // approver: internal work, with tasks.decide lent; the reviewer's grant could not decide
  const b = await given({ checker: rev });
  assert.equal((await handIn(b.id)).state, "needs_check");
  await lend(b, "reviewer", "job-3");
  await assert.rejects(ask.decide(agentChain("job-3"), b.id, { outcome: "approved" }), "a grant to review is not a grant to decide");
  await sh.mint.end({ source: `flows:task:${b.id}:reviewer`, reason: "test" });
  await lend(b, "approver", "job-4");
  for (const act of [() => ask.start(agentChain("job-4"), b.id), () => ask.complete(agentChain("job-4"), b.id, { note: "x", sources: ["https://example.test/b"] }), () => ask.update(agentChain("job-4"), b.id, { note: "x" }), () => ask.review(agentChain("job-4"), b.id, { result: "pass" })]) await assert.rejects(act(), e => ["not_allowed", "not_found", "bad_state"].includes(e.code));
  assert.equal((await ask.decide(agentChain("job-4"), b.id, { outcome: "approved" })).state, "done", "the approver agent decides internal work");

  // the round's end takes the hold back
  const c = await given({ reviewer: rev });
  await handIn(c.id);
  await lend(c, "reviewer", "job-5");
  await sh.mint.end({ source: `flows:task:${c.id}:reviewer`, reason: "the round is over" });
  await assert.rejects(ask.review(agentChain("job-5"), c.id, { result: "pass" }), "after the round the agent holds nothing");
});
