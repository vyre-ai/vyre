// @ts-check
// An owner's walk on a REAL vyred with the kernel on, the way a person would use it, with no rig defaults (the class of bug that works in the rig and not on a server). Three walks:
//   1. a Playbook template whose stage has an agent's to-do (with a manager to review it and the owner to approve it) and a file to hand in; a project starts, the tasks are made, the agent hands in a draft,
//      the manager passes it, the owner approves it with a proof over exactly what the card says to sign, and the stage moves on by itself;
//   2. a member's private note, which the owner cannot read;
//   3. a Flow with two triggers and an If, started once by each trigger, its step inputs and outputs read back.
// What a bare daemon cannot drive is listed in SKIPPED below and stated in the test output; nothing is silently left out.
// Run it on a test box, never on a person's Mac.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

/** What this walk cannot do in a bare daemon, and why. */
export const SKIPPED = Object.freeze({
  "a real device signature": "the daemon here verifies proofs with a stand-in that checks the signed operation and fields (and one use per proof), not a Secure Enclave or phone key: the card's own sign_fields are what is signed",
  "a file in Drive": "there is no Drive gateway in a bare daemon, so the file is handed in as a reference to a record the doer can read, as the kernel's own hand-in check accepts",
  "a running agent session": "the agent's hand-in is made on the agent's own chain; no model runs",
  "an outward send held at the Gate": "no sender is configured in a bare daemon",
});

const used = new Set();
/** The stand-in presence check: the proof must be for this operation, over these exact fields, once. */
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const seen = { v: /** @type {any} */ (null) };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 40_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}; last seen: ${JSON.stringify(seen.v).slice(0, 600)}`); await new Promise(r => setTimeout(r, 100)); } };
const grantProof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const MIA = "per_" + "mnopqrstuvwxyzabcdefghijkl";   // a person id is per_ and 26 letters

const templateFor = (/** @type {string} */ owner) => ({
  name: "Walk", roles: [{ role: "researcher", agent: "research" }],
  stages: [
    { name: "Intake", tasks: [
      { title: "Draft the letter", doer: "role:researcher", output: { kind: "draft" }, reviewer: { who: "role:manager" }, approver: { who: `person:${owner}` } },
      { title: "File the ID", doer: "owner", output: { kind: "file" } },
    ] },
    { name: "Done" },
  ],
});
const INTAKE = { name: "intake", label: "Intake", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "stage", kind: "stage", label: "Stage", options: ["New", "Retained"] }], stages: [{ name: "New" }, { name: "Retained" }] };

/** @param {any} t */
async function boot(t) {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const K = d.kernel, space = K.id.space, owner = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: owner, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ chain) => ({ token: (await K.surfaces.open(chain, {})).token });
  const callAs = async (/** @type {any} */ chain, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await tokenOf(chain));
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await callAs(ownerChain, tool, input); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data ?? r; };
  // the assistant "research", an actor of the Space that may work tasks
  const agent = { kind: "agent", id: "research", space };
  await call("agents.create", { name: "research", kind: "agent", projects: [] });
  await K.gateway.grants.addActor(ownerChain, agent, { presence: grantProof("grants.role", { actor: agent }, `vyre://${space}/member/research`) });
  const g = { subject: { kind: "actor", actor: agent }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/*` }, conditions: {}, source: "test" };
  await K.gateway.grants.create(ownerChain, g, { presence: grantProof("grants.create", g, `vyre://${space}/grant/new`) });
  // a member who is a manager
  const role = { person: MIA, role: "manager" };
  await K.gateway.grants.setRole(ownerChain, role, { presence: grantProof("grants.role", role, `vyre://${space}/member/${MIA}`) });
  const miaChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-mia", person: MIA, path: "relay" });
  const agentChain = K.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "research", session: "s2", thread: "t2" });
  return { d, K, space, owner, ownerChain, miaChain, agentChain, call, callAs, host: d.registry.deps.flowsHost.get(space), ask: K.gateway.ask, R: K.gateway.records };
}

test("1. a stage's tasks: the agent hands in a draft, the manager passes it, the owner approves over the card's own fields, and the stage moves on", { timeout: 240_000 }, async t => {
  const w = await boot(t);
  const { call, ask, ownerChain, miaChain, agentChain } = w;
  await call("work.template.define", { body: templateFor(w.owner) });
  await call("work.template.golive", { template: "tpl_walk", version: 1 });
  const proj = await call("work.start-project", { template: "tpl_walk", name: "Rivera" });
  // the stage's tasks are made by the stages module as the Kit's installer, with the slots the template named
  const tasks = await until(async () => { const all = await ask.list(ownerChain, {}); seen.v = all.map((/** @type {any} */ x) => [x.title, x.record, x.state]); const l = all.filter((/** @type {any} */ x) => x.title === "Draft the letter" || x.title === "File the ID"); return l.length >= 2 ? l : null; }, "the stage's two tasks");
  const draft = tasks.find((/** @type {any} */ x) => x.title === "Draft the letter"), idFile = tasks.find((/** @type {any} */ x) => x.title === "File the ID");
  const urn = draft.record;   // the project the template started, as the task names it
  assert.deepEqual([draft.doer.kind, draft.doer.id], ["agent", "research"], "the agent is the doer");
  assert.deepEqual(draft.reviewer, { role: "manager" }, "the manager role reviews");
  assert.ok(draft.checker && draft.checker.id, "the owner approves");
  // the agent hands in a draft on its own chain: the work goes to the reviewer, not to done
  await ask.start(agentChain, draft.id);
  const handed = await ask.complete(agentChain, draft.id, { draft: urn });
  assert.equal(handed.state, "in_review", "a task with a reviewer waits for the review");
  // the owner is not the manager role: they cannot review it; the manager can
  await assert.rejects(() => ask.review(ownerChain, draft.id, { result: "pass" }), (/** @type {any} */ e) => e && e.code !== undefined);
  const passed = await ask.review(miaChain, draft.id, { result: "pass", note: "reads well" });
  assert.equal(passed.state, "needs_check", "after the review it waits for the owner's approval");
  // the owner signs exactly what the card says to sign; a proof over anything else is refused
  const card = await ask.card(ownerChain, draft.id);
  assert.ok(card.sign_fields && card.sign_fields.payload_hash, "the card carries the fields to sign");
  const sign = (/** @type {any} */ fields) => ({ op: "task.decide", fields, n: Math.random(), key_id: "k_owner" });
  await assert.rejects(() => ask.decide(ownerChain, draft.id, { outcome: "approved", proof: sign({ ...card.sign_fields, payload_hash: "other" }) }), { code: "needs_presence" });
  const done = await ask.decide(ownerChain, draft.id, { outcome: "approved", proof: sign(card.sign_fields) });
  assert.equal(done.state, "done");
  // the second task is the owner's own: a file, handed in as a reference to a record they can read
  await ask.start(ownerChain, idFile.id);
  assert.equal((await ask.complete(ownerChain, idFile.id, { file: urn })).state, "done");
  // every required task is done: the stage moves on by itself, once
  const projId = urn.slice(urn.lastIndexOf("/") + 1);
  const moved = await until(async () => { const r = await w.R.get(ownerChain, "project", projId); seen.v = r && r.data; return r && r.data.template_stage === "Done" ? r : null; }, "the project to move to its next stage");
  assert.equal(moved.data.template_stage, "Done");
});

test("2. a member's private note is hers alone: the owner cannot read it", { timeout: 120_000 }, async t => {
  const w = await boot(t);
  const { callAs, ownerChain, miaChain, call } = w;
  const made = await callAs(miaChain, "planner.add", { kind: "note", title: "Mia's private thought" });
  assert.ok(made.data && made.data.id, `she can write a note: ${JSON.stringify(made).slice(0, 200)}`);
  const hers = await callAs(miaChain, "planner.list", { state: "all" });
  assert.ok((hers.data || []).some((/** @type {any} */ x) => x.title === "Mia's private thought"), `she lists it: ${JSON.stringify(hers).slice(0, 300)}`);
  const ownerList = await call("planner.list", { state: "all" });
  assert.ok(!(ownerList || []).some((/** @type {any} */ x) => x.title === "Mia's private thought"), "the owner's list does not hold it");
  const peek = await callAs(ownerChain, "planner.get", { item: made.data.id });
  assert.ok(peek.error, `the owner cannot read it: ${JSON.stringify(peek).slice(0, 200)}`);
});

test("3. a Flow with two triggers and an If: each trigger starts one run, the If takes one branch, and the step inputs and outputs read back", { timeout: 240_000 }, async t => {
  const w = await boot(t);
  const { call, host, space, ownerChain, R } = w;
  await R.define(ownerChain, { add_types: [INTAKE] });
  const flow = { format: 1, name: "two_ways", label: "Two ways in", authorship: "human",
    triggers: [{ on: "stage", type: "intake", stage: "Retained" }, { on: "event", event: "intake.created" }],
    steps: [{ id: "check", kind: "decide", if: "1 < 2", then: [{ id: "look", kind: "find", type: "intake" }], else: [] }] };
  const def = await call("flows.define", { flow });
  assert.ok(def.ok, JSON.stringify(def));
  await host.flows.tools["flows.approve"](host.personChain(), { id: def.id, version: def.version, hash: def.hash });
  const rec = await R.create(ownerChain, "intake", { name: "Chen", stage: "New" });
  const first = await until(async () => { const r = await call("flows.runs", { id: def.id }); seen.v = r; const l = Array.isArray(r) ? r : r.runs || []; return l.length === 1 ? l : null; }, "the creation trigger's run");
  const firstRun = (await call("flows.run", { run: first[0].id })).run || (await call("flows.run", { run: first[0].id }));
  assert.equal(firstRun.trigger && firstRun.trigger.index, 1, `the second trigger started it: ${JSON.stringify(firstRun.trigger)}`);
  await R.update(ownerChain, "intake", rec.id, { stage: "Retained" }, rec.version);
  const both = await until(async () => { const r = await call("flows.runs", { id: def.id }); seen.v = r; const l = Array.isArray(r) ? r : r.runs || []; return l.length === 2 ? l : null; }, "the stage trigger's run");
  const idx = [];
  for (const r of both) { const x = (await call("flows.run", { run: r.id })); idx.push(((x.run || x).trigger || {}).index); }
  assert.deepEqual(idx.sort(), [0, 1], "one run for each trigger, none twice");
  const run = (await call("flows.run", { run: both[0].id })).run || (await call("flows.run", { run: both[0].id }));
  const steps = run.steps || {};
  assert.ok(steps.check && steps.check.input, `the If's input is readable: ${JSON.stringify(steps).slice(0, 300)}`);
  assert.ok(steps.look && steps.look.output !== undefined, "the step inside the taken branch ran and its output is readable");
  void space;
});
