// An approval is a single-use authority for EXACTLY the bound act, given to the task's doer (the approval queue's own token; no new permission). On the real kernel: the Flows service, which holds
// no service.call grant, carries out an act the owner approved, once; another body, another doer, a second use, and an act nobody approved are all refused.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "./index.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const canonical = x => JSON.stringify(x, Object.keys(x).sort());
const presence = (() => { const used = new Set(); return { check: async q => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; })();
const RES = `vyre://${SPACE}/service/mail`;

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  // the Flows service as the daemon makes it (core/daemon/flows-host.js): its own grants are the task acts, and nothing that sends
  k.kernelFor({ name: "flows", needs: { kernel: { actions: ["records.read", "records.create", "records.update", "records.remove", "tasks.request", "tasks.read", "tasks.work"], prefixes: ["*"] } } });
  k.kernelFor({ name: "tasks", needs: { kernel: { actions: ["tasks.read"], prefixes: ["*"] } } });
  const doer = k.chains.forModule({ module: "flows", approver: owner });
  const other = k.chains.forModule({ module: "tasks", approver: owner });
  const gw = k.gateway;
  /** hold an act, have the doer start it, and the owner approve it */
  const approved = async (bind, act = { action: "service.call", resource: RES }) => {
    const task = await gw.ask.request(owner, { title: "Send it?", doer: { kind: "service", id: "flows", space: SPACE }, checker: { kind: "person", id: OWNER, space: SPACE }, output: { kind: "decision" }, source: "flow_step",
      form: { kind: "held_act", flow: "t", run: "r1", step: "s1", action: act.action, resource: act.resource, why: "outside", bind } }, { idem: `t-${bind}` });
    for (const [step, arg] of [["start"], ["complete", { answer: "yes", reason: "outside" }]]) { try { await (step === "start" ? gw.ask.start(doer, task.id) : gw.ask.complete(doer, task.id, arg)); } catch (e) { if (!["bad_state", "not_allowed"].includes(e.code)) throw e; } }
    const row = await gw.ask.get(owner, task.id);
    await gw.ask.decide(owner, task.id, { outcome: "approved", proof: { op: "task.decide", fields: { task: task.id, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
    return task.id;
  };
  const az = (chain, extra = {}) => gw.authorize({ chain, action: "service.call", resource: RES, ...extra });
  return { gw, owner, doer, other, approved, az };
}

test("the doer carries out exactly the approved act with no standing grant, once", async () => {
  const { doer, approved, az } = await rig();
  const id = await approved("bind-A");
  assert.notEqual((await az(doer)).effect, "allow", "with no approval the Flows service holds no grant to send");
  assert.notEqual((await az(doer, { approval: id })).effect, "allow", "an approval that names no bind covers nothing");
  assert.equal((await az(doer, { approval: id, bind: "bind-A" })).effect, "allow", "the approved act, as the doer");
  assert.notEqual((await az(doer, { approval: id, bind: "bind-A" })).effect, "allow", "a second use is refused: the approval is spent");
});

test("another body, another doer, an unapproved task and a peek that spends nothing", async () => {
  const { gw, doer, other, owner, approved, az } = await rig();
  const id = await approved("bind-B");
  assert.notEqual((await az(doer, { approval: id, bind: "bind-OTHER" })).effect, "allow", "another body (another request) is another act");
  assert.notEqual((await az(other, { approval: id, bind: "bind-B" })).effect, "allow", "another doer cannot spend it");
  assert.notEqual((await az(owner, { approval: id, bind: "bind-B" })).effect, "allow", "nor can the person who approved it: it is the doer's");
  const peek = (/** @type {any} */ chain, /** @type {any} */ extra) => gw.authorizePeek({ chain, action: "service.call", resource: RES, ...extra });
  assert.equal((await peek(doer, { approval: id, bind: "bind-B" })).effect, "allow", "a peek decides and spends nothing");
  assert.equal((await peek(doer, { approval: id, bind: "bind-B" })).effect, "allow", "so it can be asked again");
  // AT-2: peek is the Flows runner's alone: the gateway a module is handed drops it, so `peek: true` there spends like any other call
  assert.equal((await az(doer, { approval: id, bind: "bind-B", peek: true })).effect, "allow", "the one real use, though it said peek");
  assert.notEqual((await az(doer, { approval: id, bind: "bind-B", peek: true })).effect, "allow", "spent: a module cannot peek its way to a second act");
  const id3 = await approved("bind-P");
  assert.equal((await az(doer, { approval: id3, bind: "bind-P" })).effect, "allow");
  assert.notEqual((await az(doer, { approval: id, bind: "bind-B" })).effect, "allow", "and no second");
  assert.notEqual((await az(doer, { approval: "task_nobody", bind: "bind-B" })).effect, "allow", "no such approval");
  // another resource under the same approval is another act
  const id2 = await approved("bind-C");
  assert.notEqual((await gw.authorize({ chain: doer, action: "service.call", resource: `vyre://${SPACE}/service/other`, approval: id2, bind: "bind-C" })).effect, "allow", "another service");
});

// An act that GIVES access (risk grant) takes the same approval as an outward one: single use, the bound form's action and resource, the doer's chain, an approver who still stands, and the bind required.
test("an access-giving act: the doer makes exactly the approved grant with no standing grant and no fresh proof, once; another act, another bind and another doer are refused", async () => {
  const { gw, doer, other, owner, approved } = await rig();
  const GR = `vyre://${SPACE}/grant/g1`;
  const azg = (/** @type {any} */ chain, /** @type {any} */ extra = {}, action = "grants.create", resource = GR) => gw.authorize({ chain, action, resource, ...extra });
  const id = await approved("bind-G", { action: "grants.create", resource: GR });
  const none = await azg(doer);
  assert.notEqual(none.effect, "allow", "with no approval the doer holds no grant to give access");
  assert.notEqual((await azg(doer, { approval: id })).effect, "allow", "an approval that names no bind covers nothing");
  assert.notEqual((await azg(doer, { approval: id, bind: "bind-X" })).effect, "allow", "another body is another act");
  assert.notEqual((await azg(other, { approval: id, bind: "bind-G" })).effect, "allow", "another doer cannot spend it");
  assert.notEqual((await azg(doer, { approval: id, bind: "bind-G" }, "grants.role", GR)).effect, "allow", "another action under the same approval");
  assert.notEqual((await azg(doer, { approval: id, bind: "bind-G" }, "grants.create", `vyre://${SPACE}/grant/g2`)).effect, "allow", "another resource under the same approval");
  const peek = await gw.authorizePeek({ chain: doer, action: "grants.create", resource: GR, approval: id, bind: "bind-G" });
  assert.equal(peek.effect, "allow", "a peek decides and spends nothing");
  assert.equal((await azg(doer, { approval: id, bind: "bind-G" })).effect, "allow", "the approved grant, as the doer, with no presence proof");
  assert.notEqual((await azg(doer, { approval: id, bind: "bind-G" })).effect, "allow", "a second use is refused: the approval is spent");
  // an approval for a service call does not stand for a grant, and the reverse
  const mail = await approved("bind-M");
  assert.notEqual((await azg(doer, { approval: mail, bind: "bind-M" })).effect, "allow", "a mail approval is not a grant");
});
