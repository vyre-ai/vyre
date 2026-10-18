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
import fs from "node:fs";
import path from "node:path";
import { tempHome, present } from "./helpers.js";
import { FAKE } from "../core/sessions/testing/boot.js";
import { createMemberTools } from "../core/work/member-tools.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";

/** What this walk cannot do in a bare daemon, and why. */
export const SKIPPED = Object.freeze({
  "a real device signature": "the daemon here verifies proofs with a stand-in that checks the signed operation and fields (and one use per proof), not a Secure Enclave or phone key: the card's own sign fields are what is signed",
  "a file in Drive": "there is no Drive gateway in a bare daemon, so the file and the draft are handed in as relative Drive paths, whose form is all the kernel checks (kernel/tasks/facts.js); a hand-in that names a record is read on the doer's own chain and is covered by test/prod-wiring-daemon.test.js",
  "a running agent session": "the agent's hand-in is made on the agent's own chain; no model runs",
  "an outward send held at the Gate": "no sender is configured in a bare daemon",
  "a model in a woken session": "the wake tests use the stand-in provider the session tests use: a job thread starts, nothing is thought, and the round's grant is minted by the test the way the Flows host mints it once the wake has ended",
  "a joined member's notes on a record": "records.log refuses a note (it belongs to the planner) and the member's notes on a record stay her home's until 0.6.3",
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
async function boot(t, { fake = false } = {}) {
  const root = tempHome(t);
  if (fake) {
    // a stand-in model (the fake provider the session tests use), so a wake starts a real job thread: no model runs, which is what the wake tests need and no more
    const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
    const transcripts = path.join(root, "transcripts");
    Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = /** @type {string} */ (v); } });
    fs.mkdirSync(transcripts);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  }
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence, ...(fake ? { presence: present } : {}) });
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
  const handed = await ask.complete(agentChain, draft.id, { draft: "drafts/rivera-letter.md" });
  assert.equal(handed.state, "in_review", "a task with a reviewer waits for the review");
  // the owner is not the manager role: they cannot review it; the manager can
  await assert.rejects(() => ask.review(ownerChain, draft.id, { result: "pass" }), (/** @type {any} */ e) => e && e.code !== undefined);
  const passed = await ask.review(miaChain, draft.id, { result: "pass", note: "reads well" });
  assert.equal(passed.state, "needs_check", "after the review it waits for the owner's approval");
  // the owner signs exactly what the card says to sign; a proof over anything else is refused
  const card = await ask.card(ownerChain, draft.id);
  assert.ok(card.sign && card.sign.op === "task.decide" && card.sign.fields && card.sign.fields.payload_hash, `the card carries what to sign: ${JSON.stringify(card).slice(0, 300)}`);
  const sign = (/** @type {any} */ fields) => ({ op: "task.decide", fields, n: Math.random(), key_id: "k_owner" });
  await assert.rejects(() => ask.decide(ownerChain, draft.id, { outcome: "approved", proof: sign({ ...card.sign.fields, payload_hash: "other" }) }), { code: "needs_presence" });
  const done = await ask.decide(ownerChain, draft.id, { outcome: "approved", proof: sign(card.sign.fields) });
  assert.equal(done.state, "done");
  // the second task is the owner's own: a file, handed in as a relative Drive path (the kernel checks its form only; the file itself is the doer's claim)
  await ask.start(ownerChain, idFile.id);
  assert.equal((await ask.complete(ownerChain, idFile.id, { file: "ids/rivera-id.pdf" })).state, "done");
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
  const back = await callAs(miaChain, "planner.get", { item: made.data.id });
  assert.equal(back.data && back.data.item && back.data.item.title, "Mia's private thought", `and she reads it back by id: ${JSON.stringify(back).slice(0, 300)}`);
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

/** The wake rows the daemon wrote (agents_wakes): which task and slot an agent was woken for, and the job thread it got. @param {any} d @param {string} id @param {string} slot */
const wakes = (d, id, slot) => /** @type {any[]} */ (d.registry.deps.db.prepare("SELECT task, agent, thread FROM agents_wakes WHERE substr(task, 1, ?) = ?").all(id.length + slot.length + 2, `${id}#${slot}:`));
const agentIn = (/** @type {any} */ w, /** @type {string} */ agent, /** @type {string} */ thread) => w.K.chains.fromFacts({ kind: "agent_session", agent, session: thread, thread, person: w.owner, vouched: true });
const newAgent = async (/** @type {any} */ w, /** @type {string} */ name) => {
  const r = await w.callAs(w.ownerChain, "agents.create", { name, kind: "agent", projects: "*" });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const actor = { kind: "agent", id: name, space: w.space };
  await w.K.gateway.grants.addActor(w.ownerChain, actor, {});
  return actor;
};
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";

test("4. an agent reviewer is woken once for a hand-in, holds that one task for the round, and passes it", { timeout: 180_000 }, async t => {
  const w = await boot(t, { fake: true });
  const { K, ask, ownerChain, space, d } = w;
  const grantAna = { person: ANA, role: "member" };
  await K.gateway.grants.setRole(ownerChain, grantAna, { presence: grantProof("grants.role", grantAna, `vyre://${space}/member/${ANA}`) });
  const anaChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-ana", person: ANA, path: "relay" });
  const checker = await newAgent(w, "checker");
  const task = await ask.request(ownerChain, { title: "Check the memo", doer: { kind: "person", id: ANA, space }, reviewer: checker, output: { kind: "note" } });
  await ask.start(anaChain, task.id);
  assert.equal((await ask.complete(anaChain, task.id, { note: "done", sources: ["https://example.test/a"] })).state, "in_review");
  // the daemon's own wake: one job thread for the reviewer, counted as one review round
  const row = await until(async () => { const r = wakes(d, task.id, "reviewer"); seen.v = r; return r.length ? r : null; }, "the reviewer agent to be woken");
  assert.equal(row.length, 1, "woken once for the hand-in");
  assert.equal(row[0].agent, "checker");
  assert.ok(row[0].thread, "it got a job thread");
  assert.equal((await d.registry.call("agents.wake-rounds", { task: task.id }, "module:vyred")).data.rounds, 1, "one review round");
  // with no model here the wake ends and takes its hold back; the round's grant is then minted the way the Flows host mints it, for this one task and the job's thread, and the agent passes with it
  const held = async () => (await K.gateway.grants.list(ownerChain)).filter((/** @type {any} */ g) => g.status === "active" && String(g.source || "").startsWith(`flows:task:${task.id}:`));
  await until(async () => (await held()).length === 0, "the wake's hold to end");
  const needs = JSON.parse(fs.readFileSync(new URL("../core/flows/module.json", import.meta.url), "utf8")).needs;
  const sh = K.kernelFor({ name: "flows", needs });
  await sh.mint.make({ subject: { kind: "actor", actor: checker }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/${task.id}` }, conditions: { when: { expires: Date.now() + 3600_000 }, where: { sessions: [row[0].thread] } }, source: `flows:task:${task.id}:reviewer`, reason: "test" });
  assert.equal((await ask.review(agentIn(w, "checker", row[0].thread), task.id, { result: "pass", note: "reads well" })).state, "done", "the agent reviewer passes it");
});

test("5. changes requested on an agent doer's task wake the doer again, with the reviewer's answer; its second hand-in passes", { timeout: 180_000 }, async t => {
  const w = await boot(t, { fake: true });
  const { K, ask, ownerChain, miaChain, space, d } = w;
  const writer = await newAgent(w, "writer");
  const g = { subject: { kind: "actor", actor: writer }, actions: ["tasks.read", "tasks.work"], resource: { prefix: `vyre://${space}/task/*` }, conditions: {}, source: "test" };
  await K.gateway.grants.create(ownerChain, g, { presence: grantProof("grants.create", g, `vyre://${space}/grant/new`) });
  const task = await ask.request(ownerChain, { title: "Write the memo", doer: writer, reviewer: { kind: "person", id: MIA, space }, output: { kind: "note" } });
  const wc = agentIn(w, "writer", "t-writer");
  await ask.start(wc, task.id);
  assert.equal((await ask.complete(wc, task.id, { note: "first", sources: ["https://example.test/a"] })).state, "in_review");
  const asked = await ask.review(miaChain, task.id, { result: "changes", note: "Say who it is for." });
  assert.equal(asked.state, "changes_requested");
  // the doer is woken again, in a job of its own, for the changes
  const again = await until(async () => { const r = wakes(d, task.id, "changes"); seen.v = r; return r.length ? r : null; }, "the doer agent to be woken for the changes");
  assert.equal(again.length, 1, "woken once for the changes");
  assert.equal(again[0].agent, "writer");
  assert.ok(again[0].thread, "in a job thread of its own");
  // it hands in again and the manager passes it
  await ask.start(wc, task.id);
  assert.equal((await ask.complete(wc, task.id, { note: "second, for the board", sources: ["https://example.test/b"] })).state, "in_review");
  assert.equal((await ask.review(miaChain, task.id, { result: "pass" })).state, "done");
});

test("6. a joined member works in the team's planner and records through the member door: her private note stays hers, and her changes and logged call are in the record's history as her", { timeout: 180_000 }, async t => {
  const w = await boot(t);
  const { d, K, space, owner, ownerChain, R, call } = w;
  const svc = createMemberTools({ space, kernel: K, registry: d.registry });
  const as = (/** @type {string} */ person, /** @type {string} */ door, /** @type {any} */ input) => { const [g, c] = [door.slice(0, door.indexOf(".")), door.slice(door.indexOf(".") + 1)]; return /** @type {any} */ (svc)[g][c](K.chains.fromFacts({ kind: "device", device_key_id: "d-mia", person: person, path: "relay" }), input); };
  const code = (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e && e.code);
  // her notes, as herself
  const mine = await as(MIA, "planner.add", { title: "Mia door note", body: "x" });
  const itemId = (mine.item || mine).id;
  assert.ok(itemId, "she writes a note through the door");
  const hers = (await as(MIA, "planner.list", { state: "all" })).items.map((/** @type {any} */ x) => x.title);
  assert.deepEqual(hers, ["Mia door note"]);
  const ownerSees = (await call("planner.list", { state: "all" })) || [];
  assert.ok(!ownerSees.some((/** @type {any} */ x) => x.title === "Mia door note"), "the owner's planner does not hold her private note");
  assert.equal(await code(as(owner, "planner.get", { item: itemId })), "not_found", "and the owner cannot open it by id through the door either");
  // her records work, with its history
  await R.define(ownerChain, { add_types: [INTAKE] });
  const rec = (await as(MIA, "records.create", { type: "intake", data: { name: "Okafor", stage: "New" } })).record;
  await as(MIA, "records.move", { urn: rec.urn, stage: "Retained" });
  await as(MIA, "records.log", { urn: rec.urn, kind: "call", text: "Spoke to Okafor" });
  // a note is not logged here: the door sends it to the planner (a joined member's notes on a record stay her home's until 0.6.3, see docs)
  assert.ok(await code(as(MIA, "records.log", { urn: rec.urn, kind: "note", text: "Wants a warmer blue" })), "a note is refused by records.log and goes through the planner");
  const items = (await as(MIA, "records.history", { urn: rec.urn })).items;
  assert.ok(items.some((/** @type {any} */ x) => /stage/i.test(x.text) && x.actor.id === MIA), `her stage change is in the history as her: ${JSON.stringify(items.map((/** @type {any} */ x) => [x.kind, x.text])).slice(0, 300)}`);
  assert.ok(items.some((/** @type {any} */ x) => x.kind === "call" && /Okafor/.test(x.text)), "and the call she logged");
});
