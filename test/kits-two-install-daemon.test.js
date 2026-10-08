// @ts-check
// Two Kits that both define the role `attorney` (estate-planning and law-firm), installed one after the other on a real daemon: both install, and the role is one record that holds both Kits' grants.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const presence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? { ok: true, method: "passkey", keyId: "k1" } : { ok: false, message: "needs a person" }; }, required: () => false, summary: async () => "", covered: () => false, coverage: () => ({ covered: false }) }; };

test("estate-planning then law-firm: both install, and the shared attorney role is one role with both Kits' grants", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const install = async (/** @type {string} */ id) => {
    const got = (await d.registry.call("records.kits.get", { id }, "cli", await meta())).data;
    const p = await d.registry.call("flows.kit.propose", { kit: got.kit || got }, "cli", await meta());
    assert.ok(p.data && p.data.ok, `${id}: ${JSON.stringify(p)}`);
    const row = await d.kernel.gateway.ask.get(chain, p.data.task);
    await d.kernel.gateway.ask.decide(chain, p.data.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.data.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
    await until(async () => ((await d.registry.call("flows.kit.list", {}, "cli", await meta())).data || []).find((/** @type {any} */ k) => (k.id ?? k.kit_id) === id && k.status === "installed"), `${id} to install`);
  };
  await install("estate-planning");
  await install("law-firm");
  const roles = (await d.kernel.gateway.records.query(chain, "def-role", { page: { limit: 50 } })).rows.filter((/** @type {any} */ r) => r.data.name === "attorney");
  assert.equal(roles.length, 1, "one attorney role, not two");
  const grants = JSON.parse(roles[0].data.body).grants.map((/** @type {any} */ g) => JSON.stringify(g));
  assert.ok(grants.some((/** @type {string} */ g) => g.includes("matter")), "estate-planning's grants are there");
  assert.ok(grants.some((/** @type {string} */ g) => g.includes("project")), "law-firm's grants are there");
  assert.equal(new Set(grants).size, grants.length, "no grant twice");
  const all = (await d.kernel.gateway.records.query(chain, "def-role", { page: { limit: 50 } })).rows.map((/** @type {any} */ r) => r.data.name).sort();
  assert.deepEqual(all, ["attorney", "paralegal"]);
});
