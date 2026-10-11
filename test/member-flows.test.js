// @ts-check
// A team member sets up and starts Flows through her own door (core/flows/member.js), on a REAL daemon: the Flows tools check no role and no owner, so the door's rows carry the rules.
// Her own Flow: made, approved inside the bound, started, run as HER. The owner's: listed and startable, never changed or approved by her. A schedule Flow of hers, or one with an AI or outward step, waits
// for an owner or admin. A non-member gets nothing. Pausing the Space's Flows, rolling back and the AI budget are not calls she has. A step's yes lands on the person the step names.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { CALLS } from "../kernel/remote/wire.js";
import { createMemberTools } from "../core/work/member-tools.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const BOB = "per_" + "b".repeat(26), CAROL = "per_" + "c".repeat(26), DAVE = "per_" + "d".repeat(26);
const CONTACT = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "status", kind: "text", label: "Status" }] };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };
const find = (/** @type {string} */ name, trigger = { on: "manual" }, extra = {}) => ({ format: 1, name, label: name, authorship: "human", trigger, steps: [{ id: "f", kind: "find", type: "contact", limit: 1 }], ...extra });

test("a member sets up, approves inside the bound, and starts Flows of her own, and the rules hold against the owner's and the unattended", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const space = d.kernel.id.space, owner = d.kernel.id.owner;
  const host = () => d.registry.deps.flowsHost.get(space);
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s" });
  await d.kernel.gateway.records.define(chainOf(owner), { add_types: [CONTACT] });
  await d.kernel.gateway.grants.setRole(chainOf(owner), { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
  const svc = /** @type {any} */ (createMemberTools({ space, kernel: d.kernel, registry: d.registry }).flows);
  const bob = chainOf(BOB), dave = chainOf(DAVE);
  const words = async (/** @type {Promise<any>} */ p) => { try { await p; return ""; } catch (e) { return String(/** @type {any} */ (e).message); } };

  // the owner's Flow, approved by the owner
  const od = await host().flows.tools["flows.define"](chainOf(owner), { flow: find("owners_flow") });
  assert.ok(od.ok, JSON.stringify(od));
  await host().flows.tools["flows.approve"](chainOf(owner), { id: od.id, version: od.version, hash: od.hash });

  // she sees it (approved), can read it and start it; a run she starts is tagged with her
  const listed = await svc.list(bob, {});
  assert.ok(listed.some((/** @type {any} */ r) => r.id === od.id), "an approved Flow of the owner's is on her list");
  assert.ok((await svc.get(bob, { id: od.id })).flow, "and she may read it");
  await d.kernel.gateway.records.create(chainOf(owner), "contact", { name: "Dana Reyes private" });
  const started = await svc.start(bob, { id: od.id });
  const runId = started.id || started.run || (started.run && started.run.id);
  assert.ok(runId, JSON.stringify(started));
  const mineRuns = await svc.runs(bob, { id: od.id });
  assert.ok(mineRuns.some((/** @type {any} */ r) => r.started_by_me === true), "she sees the run she started, marked as hers");
  assert.equal((await host().flows.store.getRun(mineRuns[0].id)).trigger.key.startsWith("mem:" + BOB + ":"), true, "and the run itself says who started it");

  // the owner's run read a contact on the OWNER's authority: the owner sees what it read, she sees the run and not that data
  const oRun = mineRuns[0].id;
  const ownerSees = await until(async () => { const r = await host().flows.tools["flows.run"](chainOf(owner), { run: oRun }); return JSON.stringify(r).includes("Dana Reyes private") ? r : null; }, "the owner's run to show what it read");
  assert.ok(ownerSees, "the owner sees the step's output");
  for (const [what, got] of [["run", await svc.run(bob, { run: oRun })], ["timeline", await svc.timeline(bob, { run: oRun })], ["step", await svc.timeline(bob, { run: oRun, step: "f" })], ["describe", await svc.describe(bob, { run: oRun })]]) {
    assert.ok(!JSON.stringify(got).includes("Dana Reyes"), `${what}: the data the owner's run read is not shown to her`);
  }
  const hiddenRun = await svc.run(bob, { run: oRun });
  assert.equal(hiddenRun.run.state, ownerSees.run.state, "she still sees the run's state");
  assert.match(String(hiddenRun.run.hidden_for), /authority/, "and is told in words whose authority it ran on");
  assert.ok(String(hiddenRun.run.hidden_for).includes(owner), "naming the person");

  // Flows belong to the Space: she may write a new version of the owner's Flow (a draft), but her yes never replaces the version that runs on the owner's authority
  const v2 = await svc.define(bob, { id: od.id, flow: find("owners_flow", { on: "manual" }, { label: "improved by bob" }) });
  assert.ok(v2.ok && v2.version === od.version + 1, JSON.stringify(v2));
  // the app is told, not left to infer: the Flow runs as the owner, and the draft was made by her
  const g1 = await svc.get(bob, { id: od.id }), g2 = await svc.get(bob, { id: od.id, version: v2.version });
  assert.equal(g1.runs_as, owner, "the Flow runs as the person who approved the active version");
  assert.equal(g2.runs_as, owner, "a draft of it still runs as them");
  assert.equal(g2.by, BOB, "and the draft says she made it");
  // a second draft after a big one: its card compares with what RUNS, so the first draft's change is still shown to the approver
  const v3 = await svc.define(bob, { id: od.id, flow: { ...find("owners_flow", { on: "manual" }, { label: "improved by bob" }), steps: [{ id: "f", kind: "find", type: "contact", limit: 2 }] } });
  assert.ok(v3.ok && v3.version === v2.version + 1, JSON.stringify(v3));
  const c2 = (await svc.card(bob, { id: od.id, version: v2.version })).changes, c3 = (await svc.card(bob, { id: od.id, version: v3.version })).changes;
  assert.ok(c2.length > 0, "the first draft changes something");
  for (const c of c2) assert.ok(c3.some((/** @type {any} */ x) => JSON.stringify(x) === JSON.stringify(c)), `the second draft's card still shows the first draft's change: ${JSON.stringify(c)}`);
  // attention shows a member Flow runs only, never the Space's stuck tasks
  assert.deepEqual(Object.keys(await svc.attention(bob, {})), ["runs"], "attention carries runs and nothing else");
  // drafts waiting on one Flow are capped per member
  let made = 2;
  for (; made < 20; made++) { const x = await svc.define(bob, { id: od.id, flow: find("owners_flow", { on: "manual" }, { label: "draft " + made }) }); assert.ok(x.ok, JSON.stringify(x)); }
  assert.match(await words(svc.define(bob, { id: od.id, flow: find("owners_flow", { on: "manual" }, { label: "one too many" }) })), /20 drafts.*Ask the person it runs for/s, "the 21st waiting draft is refused, with a next step");
  assert.match(await words(svc.approve(bob, { id: od.id, version: v2.version, hash: v2.hash })), /runs on someone else's authority.*Propose it/s, "her own yes does not approve a new version of the owner's Flow");
  assert.equal((await host().flows.store.active(od.id)).version, od.version, "the owner's version still runs");
  // she proposes it: a card goes to the person the Flow runs for (the owner), who approves it with their own yes; it then runs on the owner's authority
  const prop = await svc.propose(bob, { id: od.id, version: v2.version, note: "a clearer label" });
  assert.equal(prop.asked, owner, "the owner is asked");
  const card = await until(async () => (await d.kernel.gateway.ask.list(chainOf(owner), { state: ["waiting", "ready", "working", "needs_check"] })).find((/** @type {any} */ x) => /waiting for your yes/.test(x.title)) || null, "the owner's card");
  assert.equal(card.doer.id, owner);
  await host().flows.tools["flows.approve"](chainOf(owner), { id: od.id, version: v2.version, hash: v2.hash });
  assert.equal((await host().flows.store.active(od.id)).version, v2.version, "the owner approved it: it runs on the owner's authority");

  // her own Flow: made, approved (inside the bound), started, run as HER
  const bd = await svc.define(bob, { flow: find("bobs_flow") });
  assert.ok(bd.ok, JSON.stringify(bd));
  const ap = await svc.approve(bob, { id: bd.id, version: bd.version, hash: bd.hash });
  assert.equal(ap.approver.id, BOB, "approved in her own name");
  const bs = await svc.start(bob, { id: bd.id });
  const brun = await until(async () => { const r = (await svc.runs(bob, { id: bd.id })).find((/** @type {any} */ x) => x.state !== "running" && x.state !== "queued"); return r || null; }, "her Flow's run to finish");
  const full = await svc.run(bob, { run: brun.id });
  assert.ok(!full.run.hidden_for && JSON.stringify(full).includes("Dana Reyes private"), "her own run is shown whole, data included");
  assert.equal(full.run.approver.id, BOB, "it ran as HER: she is its approver, so its authority is her role's, never the owner's");

  // any trigger: an unattended Flow of hers is hers to approve, and she is told in words what it will do and on whose allowance
  const nd = await svc.define(bob, { flow: find("bobs_nightly", { on: "time", cron: "0 3 * * *" }) });
  assert.ok(nd.ok, JSON.stringify(nd));
  const nap = await svc.approve(bob, { id: nd.id, version: nd.version, hash: nd.hash });
  assert.equal(nap.approver.id, BOB);
  assert.match(nap.notice, /runs as you.*never with the owner's authority.*starts by itself.*pauses and the owner is told/s, nap.notice);

  // a Connection step needs service.read, which her role does not hold: such a Flow of hers is not hers to approve (the Space's credential is the Vault's, and the vault is the owner's)
  const sd = await svc.define(bob, { flow: { ...find("bobs_service"), steps: [{ id: "s", kind: "service", connector: "demo", method: "GET", path: "/status" }] } });
  if (sd.ok) {
    const refusal = await words(svc.approve(bob, { id: sd.id, version: sd.version, hash: sd.hash }));
    assert.match(refusal, /beyond what you can approve yourself/, `a Connection step stays a draft: ${refusal}`);
  } else console.log("NOTE|a Flow with an unknown Connection does not compile here: " + JSON.stringify(sd.errors).slice(0, 160));

  // a step's yes lands on the person the step names
  const yes = await svc.define(bob, { flow: { ...find("bobs_yes"), steps: [{ id: "q", kind: "ask", to: `person:${BOB}`, title: "Carry on?" }] } });
  assert.ok(yes.ok, JSON.stringify(yes));
  await svc.approve(bob, { id: yes.id, version: yes.version, hash: yes.hash });
  await svc.start(bob, { id: yes.id });
  const mine = await until(async () => (await d.kernel.gateway.ask.list(bob, { state: ["waiting", "ready", "working", "needs_check"] })).find((/** @type {any} */ x) => x.title === "Carry on?") || null, "her task card");
  assert.equal(mine.doer.id, BOB, "the yes comes to her");

  // an AI step: allowed, and the notice says in words that it runs on the Space's allowance, not on her own sign-in
  const ai = await svc.define(bob, { flow: { ...find("bobs_ai"), steps: [{ id: "k", kind: "classify", input: "hello", labels: ["new client", "spam"] }] } });
  assert.ok(ai.ok, JSON.stringify(ai));
  const aap = await svc.approve(bob, { id: ai.id, version: ai.version, hash: ai.hash });
  assert.match(aap.notice, /AI steps use the Space's AI credentials.*daily allowance.*200,000 tokens a day/s, aap.notice);

  // a second member cannot read or change her Flow through the Records door, and cannot approve it by hand
  await d.kernel.gateway.grants.setRole(chainOf(owner), { person: CAROL, role: "member" }, { presence: { method: "stand-in" } });
  const carolMember = chainOf(CAROL);
  // a second member improves bob's Flow: it is a draft; only bob (whose authority it runs on) or an owner/admin approves it
  assert.ok((await svc.list(carolMember, {})).some((/** @type {any} */ r) => r.id === bd.id), "every member sees every Flow of the Space");
  assert.ok((await svc.runs(carolMember, { id: bd.id })).length >= 1, "and the runs of every Flow of the Space");
  const cv2 = await svc.define(carolMember, { id: bd.id, flow: find("bobs_flow", { on: "manual" }, { label: "carol's improvement" }) });
  assert.ok(cv2.ok, JSON.stringify(cv2));
  assert.match(await words(svc.approve(carolMember, { id: bd.id, version: cv2.version, hash: cv2.hash })), /runs on someone else's authority/, "she cannot approve her version of bob's Flow herself");
  assert.equal((await host().flows.store.active(bd.id)).version, bd.version, "bob's version still runs");
  const bobApproves = await svc.approve(bob, { id: bd.id, version: cv2.version, hash: cv2.hash });
  assert.equal(bobApproves.approver.id, BOB, "bob approves carol's version: it now runs on bob's authority");
  assert.equal((await host().flows.store.active(bd.id)).version, cv2.version);
  // new Flows nobody has approved are capped per member (50), with a next step
  let waiting = 0;
  for (const r of await host().flows.store.list()) if (r.active === null) { const row = await host().flows.store.flowRow(r.id); if (row.versions[0].by.id === CAROL) waiting++; }
  for (let n = waiting; n < 50; n++) { const x = await svc.define(carolMember, { flow: find("cap_flow_" + n) }); assert.ok(x.ok, JSON.stringify(x)); }
  assert.match(await words(svc.define(carolMember, { flow: find("one_new_flow_too_many") })), /50 new Flows waiting.*Approve or remove/s, "the 51st unapproved new Flow is refused, with a next step");
  // the Flow record types are protected: a member's records.* sees none of them and can write none (she could otherwise create an approval naming the owner, or set a version active by hand)
  const seen = await d.kernel.gateway.records.query(carolMember, "flow-state", { page: { limit: 5 } }).then((/** @type {any} */ r) => r.rows.length, () => 0);
  assert.equal(seen, 0, "a second member reads no Flow state through Records");
  const seenDefs = await d.kernel.gateway.records.query(carolMember, "def-flow", { page: { limit: 5 } }).then((/** @type {any} */ r) => r.rows.length, () => 0);
  assert.equal(seenDefs, 0, "nor Flow definitions");
  assert.ok(await words(d.kernel.gateway.records.create(carolMember, "flow-approval", { flow_id: bd.id, version: 1, hash: bd.hash, approver: "person:" + owner, at: 1 })), "and cannot write an approval naming the owner");

  // a chain that is a member with the Flows service hop appended is not the Flows service: it changes or removes no Flow row (the two-hop case)
  const twoHop = d.kernel.chains.appendService(carolMember, "flows", true);
  const stateRow = (await d.kernel.gateway.records.query(chainOf(owner), "flow-state", { page: { limit: 1 } })).rows[0];
  assert.ok(stateRow, "there is a Flow state row to try");
  assert.ok(await words(d.kernel.gateway.records.update(twoHop, "flow-state", stateRow.id, { status: "disabled" }, stateRow.version)), "[member, flows service] cannot change a Flow's state");
  assert.ok(await words(d.kernel.gateway.records.remove(twoHop, "flow-state", stateRow.id, stateRow.version)), "nor remove it");
  assert.equal((await d.kernel.gateway.records.get(chainOf(owner), "flow-state", stateRow.id)).data.status, stateRow.data.status, "and the row is as it was");

  // a Flow of hers that runs by itself stops when she is removed from the Space, and the owner sees it
  const sched = await svc.define(bob, { flow: find("bobs_morning", { on: "time", cron: "* * * * *" }, {}) });
  assert.ok(sched.ok, JSON.stringify(sched));
  await svc.approve(bob, { id: sched.id, version: sched.version, hash: sched.hash });
  await d.kernel.gateway.grants.removeMember(chainOf(owner), { person: BOB }, { presence: { method: "stand-in" } });
  await host().flows.store.putSchedule(sched.id, Date.now() - 120_000);
  host().flows.runner.lastFire.set(sched.id, Date.now() - 120_000);
  await host().flows.tick();
  const paused = await until(async () => { const r = await host().flows.store.flowRow(sched.id); return r && r.status === "paused" ? r : null; }, "her scheduled Flow to pause after she left the team");
  assert.equal(paused.status, "paused");
  const needs = await host().flows.tools["flows.attention"](chainOf(owner), {});
  assert.ok(JSON.stringify(needs).includes(sched.id), "the owner's list of what needs a person shows it: " + JSON.stringify(needs).slice(0, 200));

  // someone who is not a member gets nothing; the Space-wide switches are not calls she has
  assert.match(await words(svc.list(dave, {})), /not found/i, "a non-member is told nothing");
  for (const call of ["pause", "resume", "rollback", "budget", "kit-propose", "control"]) assert.equal(svc[call], undefined, `${call} is not a call a member has`);
  assert.deepEqual(Object.keys(svc).sort(), [...CALLS.flows].sort(), "the service answers exactly the calls the wire lists");
});
