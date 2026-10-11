// @ts-check
// A team member sets up and starts Flows through her own door (core/flows/member.js), on a REAL daemon: the Flows tools check no role and no owner, so the door's rows carry the rules.
// Her own Flow: made, approved inside the bound, started, run as HER. The owner's: listed and startable, never changed or approved by her. A schedule Flow of hers, or one with an AI or outward step, waits
// for an owner or admin. A non-member gets nothing. Pausing the Space's Flows, rolling back and the AI budget are not calls she has. A step's yes lands on the person the step names.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { CALLS } from "../kernel/remote/wire.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const BOB = "per_" + "b".repeat(26), CAROL = "per_" + "c".repeat(26);
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
  const svc = /** @type {any} */ (d.registry.modules.get("flows").handle.peerService({ space, kernel: d.kernel, registry: d.registry }));
  const bob = chainOf(BOB), carol = chainOf(CAROL);
  const words = async (/** @type {Promise<any>} */ p) => { try { await p; return ""; } catch (e) { return String(/** @type {any} */ (e).message); } };

  // the owner's Flow, approved by the owner
  const od = await host().flows.tools["flows.define"](chainOf(owner), { flow: find("owners_flow") });
  assert.ok(od.ok, JSON.stringify(od));
  await host().flows.tools["flows.approve"](chainOf(owner), { id: od.id, version: od.version, hash: od.hash });

  // she sees it (approved), can read it and start it; a run she starts is tagged with her
  const listed = await svc.list(bob, {});
  assert.ok(listed.some((/** @type {any} */ r) => r.id === od.id), "an approved Flow of the owner's is on her list");
  assert.ok((await svc.get(bob, { id: od.id })).flow, "and she may read it");
  const started = await svc.start(bob, { id: od.id });
  const runId = started.id || started.run || (started.run && started.run.id);
  assert.ok(runId, JSON.stringify(started));
  const mineRuns = await svc.runs(bob, { id: od.id });
  assert.ok(mineRuns.some((/** @type {any} */ r) => r.started_by_me === true), "she sees the run she started, marked as hers");
  assert.equal((await host().flows.store.getRun(mineRuns[0].id)).trigger.key.startsWith("mem:" + BOB + ":"), true, "and the run itself says who started it");

  // she cannot change or approve the owner's Flow
  assert.match(await words(svc.define(bob, { id: od.id, flow: find("owners_flow", { on: "manual" }, { label: "mine now" }) })), /someone else's/, "a new version of the owner's Flow is refused in words");
  assert.match(await words(svc.patch(bob, { id: od.id, base: 1, ops: [] })), /someone else's/);
  assert.match(await words(svc.approve(bob, { id: od.id, version: od.version, hash: od.hash })), /only a version you made yourself/);

  // her own Flow: made, approved (inside the bound), started, run as HER
  const bd = await svc.define(bob, { flow: find("bobs_flow") });
  assert.ok(bd.ok, JSON.stringify(bd));
  const ap = await svc.approve(bob, { id: bd.id, version: bd.version, hash: bd.hash });
  assert.equal(ap.approver.id, BOB, "approved in her own name");
  const bs = await svc.start(bob, { id: bd.id });
  const brun = await until(async () => { const r = (await svc.runs(bob, { id: bd.id })).find((/** @type {any} */ x) => x.state !== "running" && x.state !== "queued"); return r || null; }, "her Flow's run to finish");
  const full = await svc.run(bob, { run: brun.id });
  assert.equal(full.run.approver.id, BOB, "it ran as HER: she is its approver, so its authority is her role's, never the owner's");

  // beyond the bound: an unattended Flow of hers waits for an owner or admin
  const nd = await svc.define(bob, { flow: find("bobs_nightly", { on: "time", cron: "0 3 * * *" }) });
  assert.ok(nd.ok, JSON.stringify(nd));
  assert.match(await words(svc.approve(bob, { id: nd.id, version: nd.version, hash: nd.hash })), /starts by itself.*owner or admin/s, "a schedule Flow of hers is not hers to approve");

  // a step's yes lands on the person the step names
  const yes = await svc.define(bob, { flow: { ...find("bobs_yes"), steps: [{ id: "q", kind: "ask", to: `person:${BOB}`, title: "Carry on?" }] } });
  assert.ok(yes.ok, JSON.stringify(yes));
  await svc.approve(bob, { id: yes.id, version: yes.version, hash: yes.hash });
  await svc.start(bob, { id: yes.id });
  const mine = await until(async () => (await d.kernel.gateway.ask.list(bob, { state: ["waiting", "ready", "working", "needs_check"] })).find((/** @type {any} */ x) => x.title === "Carry on?") || null, "her task card");
  assert.equal(mine.doer.id, BOB, "the yes comes to her");

  // someone who is not a member gets nothing; the Space-wide switches are not calls she has
  assert.match(await words(svc.list(carol, {})), /not found/i, "a non-member is told nothing");
  for (const call of ["pause", "resume", "rollback", "budget", "kit-propose", "control"]) assert.equal(svc[call], undefined, `${call} is not a call a member has`);
  assert.deepEqual(Object.keys(svc).sort(), [...CALLS.flows].sort(), "the service answers exactly the calls the wire lists");
});
