// @ts-check
// Kits across a restart on a real daemon: a proposal waiting for the owner's yes survives it and installs the APPROVED content after it; an installed Kit is still installed, with its ledger intact.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 25_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };
const presence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => { return q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof"; } }; };

test("a Kit proposal waits through a restart and installs what was approved; an installed Kit survives a restart with its ledger", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const boot = () => start({ root, log: () => {}, kernel: true, kernelPresence: presence() });
  let d = await boot();
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chainOf = (/** @type {any} */ x) => x.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async (/** @type {any} */ x) => ({ token: (await x.kernel.surfaces.open(chainOf(x), {})).token });
  const lib = (await d.registry.call("records.kits.library", {}, "cli", await meta(d))).data;
  const id = (lib.kits || lib)[0].id;
  const kit = (await d.registry.call("records.kits.get", { id }, "cli", await meta(d))).data;
  const kitObj = kit.kit || kit;
  const p = await d.registry.call("flows.kit.propose", { kit: kitObj }, "cli", await meta(d));
  assert.ok(p.data && p.data.ok, JSON.stringify(p));
  const typesBefore = (await d.kernel.store.types()).map((/** @type {any} */ x) => x.name);

  // restart with the proposal still waiting for the owner
  await d.stop();
  d = await boot();
  assert.deepEqual((await d.kernel.store.types()).map((/** @type {any} */ x) => x.name), typesBefore, "nothing installed by the restart");
  const approve = async (/** @type {string} */ task) => {
    const row = await d.kernel.gateway.ask.get(chainOf(d), task);
    await d.kernel.gateway.ask.decide(chainOf(d), task, { outcome: "approved", proof: { op: "task.decide", fields: { task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  };
  await approve(p.data.task);
  const kitRow = async () => ((await d.registry.call("flows.kit.list", {}, "cli", await meta(d))).data || []).find((/** @type {any} */ k) => k.kit_id === id || k.id === id);
  const done = await until(async () => { const k = await kitRow(); return k && k.status === "installed" ? k : null; }, "the approved Kit to install after the restart");
  assert.ok((await d.kernel.store.types()).length > typesBefore.length, "the Kit's types are defined");
  const ledger = async () => { const r = await d.kernel.gateway.records.query(chainOf(d), "kit-install", { page: { limit: 10 } }); return r.rows.map((/** @type {any} */ x) => JSON.parse(x.data.body)).find((/** @type {any} */ x) => x.kit_id === id); };
  const l1 = await ledger();
  assert.ok(l1 && l1.added && l1.added.length > 0, "the ledger names what was added");
  assert.equal(l1.hash, p.data.card.kit.hash, "what installed is the content the card showed (its hash)");

  // restart again: installed, ledger intact
  await d.stop();
  d = await boot();
  const after = await until(async () => kitRow(), "the installed Kit after a second restart");
  assert.equal(after.status, "installed");
  const l2 = await ledger();
  assert.deepEqual(l2.added, l1.added, "the ledger is the same");
  assert.equal(l2.hash, l1.hash);
});
