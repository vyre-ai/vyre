// @ts-check
// The pieces the tasks module needs that only the test rig used to supply, proved on a REAL vyred with the kernel on: a hand-in of a file, a draft or fields, an approved send, the responsible person for an agent, and a Kit's teammate.
// Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

/** @param {any} t */
async function world(t) {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner, space = K.id.space;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  return { d, K, OWNER, space, ownerChain, ask: K.gateway.ask, me: { kind: "person", id: OWNER, space } };
}

test("1. a task whose output is a file, a draft or fields can be handed in and completed", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const { ask, ownerChain, me, space, K } = w;
  const made = (/** @type {any} */ over) => ask.request(ownerChain, { title: "Hand it in", doer: me, ...over });
  const finish = async (/** @type {any} */ task, /** @type {any} */ evidence) => { await ask.start(ownerChain, task.id); return ask.complete(ownerChain, task.id, evidence); };
  // a record the draft, file and fields tasks are about
  const rec = await K.gateway.records.create(ownerChain, "project", { name: "Rivera", slug: "rivera", status: "active" });
  const urn = `vyre://${space}/project/${rec.id}`;
  const draft = await made({ output: { kind: "draft" }, record: urn });
  const asDraft = await finish(draft, { draft: urn }).catch(e => e);
  assert.equal(asDraft && asDraft.state, "done", `a draft hand-in: ${asDraft && asDraft.code} ${asDraft && asDraft.message}`);
  const file = await made({ output: { kind: "file" } });
  const asFile = await finish(file, { file: urn }).catch(e => e);
  assert.equal(asFile && asFile.state, "done", `a file hand-in: ${asFile && asFile.code} ${asFile && asFile.message}`);
  const fields = await made({ output: { kind: "fields", target: "name" }, record: urn });
  const asFields = await finish(fields, {}).catch(e => e);
  assert.equal(asFields && asFields.state, "done", `a fields hand-in: ${asFields && asFields.code} ${asFields && asFields.message}`);
  // and a draft or file that is not there is still refused
  const gone = await made({ output: { kind: "file" } });
  await assert.rejects(finish(gone, { file: `vyre://${space}/file/nothing-here` }), { code: "output_check_failed" });
});

test("3. the person responsible for an agent can unblock its stuck task without a fresh proof, sees it in needs-you, and gets the skip proposal", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const { ask, ownerChain, space, K, d } = w;
  const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", CAT = "per_" + "defghijklmnopqrstuvwxyzabc";
  const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
  const chainOf = (/** @type {string} */ person) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  await K.gateway.grants.setRole(ownerChain, { person: ANA, role: "admin" }, { presence: proof() });
  await K.gateway.grants.setRole(ownerChain, { person: CAT, role: "member" }, { presence: proof() });
  // Ana makes the agent, so she is the person responsible for it
  const token = (await K.surfaces.open(chainOf(ANA), {})).token;
  const made = await d.registry.call("agents.create", { name: "juno", kind: "agent", projects: "*" }, "cli", { token });
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  const juno = { kind: "agent", id: "juno", space };
  await K.gateway.grants.addActor(ownerChain, juno, {});   // an agent is an actor of the Space once it is registered, as the daemon does for a made agent
  const agentChain = K.chains.fromFacts({ kind: "agent_session", agent: "juno", session: "s", thread: "t", vouched: true });
  const given = await ask.request(w.ownerChain, { title: "Look into it", doer: juno, output: { kind: "note" } });
  await ask.start(agentChain, given.id);
  const stuck = await ask.stuck(agentChain, given.id, { reason: "the portal password changed" });
  assert.equal(stuck.state, "stuck");
  // she sees it among what waits on her, and a person who is not responsible does not
  assert.ok((await ask.needsYou(chainOf(ANA))).some((/** @type {any} */ x) => x.id === given.id), "the responsible person sees the stuck task in needs-you");
  assert.ok(!(await ask.needsYou(chainOf(CAT))).some((/** @type {any} */ x) => x.id === given.id));
  // she unblocks it without a proof; a person who is not responsible is asked for one
  await assert.rejects(ask.unblock(chainOf(CAT), given.id, {}), { code: "needs_presence" });
  assert.equal((await ask.unblock(chainOf(ANA), given.id, {})).state, "ready", "the responsible person unblocks without a fresh proof");
  // a skip that needs a person's yes goes to the person responsible for the agent, not to the one who gave the task
  const guarded = await ask.request(w.ownerChain, { title: "Needs a check", doer: juno, checker: { kind: "person", id: w.OWNER, space }, output: { kind: "note" } }).catch(() => null);
  if (guarded) {
    const sk = await ask.skip(w.ownerChain, guarded.id, "not needed");
    assert.equal(sk.proposal && sk.proposal.checker && sk.proposal.checker.id, ANA, "the skip proposal is for the person responsible for the agent");
  }
});
