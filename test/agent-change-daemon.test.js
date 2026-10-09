// @ts-check
// An agent changes by conversation on a REAL vyred (R031-09): the agent proposes a change to itself, the owner is asked on one card, nothing changes before the yes, the yes applies it as a version, and rollback restores.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const presence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") }; };
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("an agent proposes a change to itself; its owner approves on one card; it lands as a version; rollback restores the earlier words", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const asOwner = async () => ({ token: (await d.kernel.surfaces.open(ownerChain, {})).token });
  const kitChain = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "kit", session: "s2", thread: "t2" });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {any} */ meta) => d.registry.call(tool, input, "cli", meta);

  const made = await call("agents.create", { name: "kit", kind: "agent", projects: [], instructions: "Be brief." }, await asOwner());
  assert.equal(made.error, undefined, JSON.stringify(made));
  assert.equal(made.data.owner, owner, "the person who made it owns it");

  // the agent's own session proposes, through the Flows assembly under the agent's kernel chain (a session's chain cannot mint a token of its own here)
  const host = d.registry.deps.flowsHost.get(d.kernel.id.space);
  const propose = (/** @type {any} */ chain, /** @type {any} */ input) => host.flows.tools["flows.propose"](chain, input);
  const p = { data: await propose(kitChain, { what: "agent", agent: "kit", patch: { instructions: "Be brief and cite sources." } }) };
  assert.ok(p.data && p.data.ok, JSON.stringify(p));
  assert.equal(p.data.by, "kit"); assert.equal(p.data.approver, owner);
  const still = (await call("agents.list", {}, await asOwner())).data.find((/** @type {any} */ a) => a.name === "kit");
  assert.equal(still.instructions, "Be brief.", "nothing changes before the yes");
  assert.equal((await call("agents.versions", { agent: "kit" }, await asOwner())).data.versions.length, 0);
  assert.equal((await propose(kitChain, { what: "agent", agent: "kit", patch: { instructions: "Be brief and cite sources." } })).task, p.data.task, "asking again is the same card");

  const row = await d.kernel.gateway.ask.get(ownerChain, p.data.task);
  assert.equal(row.form.what, "agent"); assert.match(row.title, /^Change kit: instructions\?/);
  await d.kernel.gateway.ask.decide(ownerChain, p.data.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.data.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  const landed = await until(async () => { const a = (await call("agents.list", {}, await asOwner())).data.find((/** @type {any} */ x) => x.name === "kit"); return a.instructions === "Be brief and cite sources." ? a : null; }, "the approved change to land");
  assert.ok(landed);
  const v = (await call("agents.versions", { agent: "kit" }, await asOwner())).data.versions;
  assert.deepEqual([v.length, v[0].approved_by, v[0].by, v[0].before.instructions], [1, owner, "kit", "Be brief."]);

  const back = await call("agents.update", { name: "kit", rollback: 0 }, await asOwner());
  assert.equal(back.data.instructions, "Be brief.", "rolled back to how it began");
  assert.equal((await call("agents.versions", { agent: "kit" }, await asOwner())).data.versions.length, 2, "and the rollback is a version too");

  // a stranger's assistant is not the agent's owner, an admin, or the agent: not asked
  const other = d.kernel.chains.fromFacts({ kind: "agent_session", vouched: true, person: owner, agent: "scout", session: "s3", thread: "t3" });
  const r = await propose(other, { what: "agent", agent: "kit", patch: { effort: "low" } });
  assert.ok(r && r.ok, "the owner's own assistant is the owner acting: asked, not refused");
  await assert.rejects(propose(other, { what: "agent", agent: "kit", patch: { projects: "*" } }), /permissions/);
});
