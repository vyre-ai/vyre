// @ts-check
// The agent records are a DERIVED view of the roster (R031-02/09), on a REAL vyred: they follow every change to the store, tags go in through agents.update, a hand-written change is put back, and a
// record that went missing or strayed is repaired by the one reconcile path. The manifest's type is the module's own export (no second definition).
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { AGENT } from "../core/agents/mirror.js";
import { tempHome } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("the manifest declares the module's own Agent type, not a copy that can differ", () => {
  const m = JSON.parse(fs.readFileSync(new URL("../core/agents/module.json", import.meta.url), "utf8"));
  assert.deepEqual(m.needs.kernel.types, [JSON.parse(JSON.stringify(AGENT))]);
});

test("agent records follow the roster and cannot drift from it", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await d.kernel.surfaces.open(chain, {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await meta());
  const recs = async () => (await d.kernel.gateway.records.query(chain, "agent", { page: { limit: 100 } })).rows;
  const roster = async () => (await call("agents.list")).data;
  const level = async () => { const r = await roster(), have = await recs(); return r.length === have.length && r.every((/** @type {any} */ a) => have.some((/** @type {any} */ h) => h.data.uid === a.uid && h.data.name === a.name)); };

  await until(level, "the built-in Engineer to appear as a record");
  assert.ok((await recs()).some((/** @type {any} */ r) => r.data.name === "engineer" && r.data.builtin === true));
  assert.equal((await call("agents.create", { name: "kit", kind: "agent", projects: [], model: "sonnet" })).error, undefined);
  await until(async () => (await recs()).find((/** @type {any} */ r) => r.data.name === "kit"), "kit to appear");
  const kit = () => /** @type {Promise<any>} */ (recs().then(l => l.find((/** @type {any} */ r) => r.data.name === "kit")));
  assert.deepEqual([(await kit()).data.owner, (await kit()).data.model, (await kit()).data.kind], [owner, "sonnet", "agent"]);

  // tags are written through the roster
  await call("agents.update", { name: "kit", tags: ["Research", "client-work"] });
  const tagged = await until(async () => { const k = await kit(); return k.data.tags ? k : null; }, "the tags to reach the record");
  assert.equal(tagged.data.tags, '["research","client-work"]');

  // a hand-written change is put back, and a stray record is removed
  await d.kernel.gateway.records.update(chain, "agent", tagged.id, { tags: '["x"]' }, tagged.version);
  await until(async () => (await kit()).data.tags === '["research","client-work"]', "the hand-written tags to be put back");
  await d.kernel.gateway.records.create(chain, "agent", { name: "ghost", uid: "agt_ghost", kind: "agent" });
  await until(async () => (await recs()).every((/** @type {any} */ r) => r.data.name !== "ghost"), "the stray record to go");

  // a record that went missing, and a stray one, are repaired by the single reconcile path
  await d.kernel.gateway.records.remove(chain, "agent", tagged.id).catch(() => {});
  const fixed = await d.registry.call("agents.mirror", {}, "module:vyred");
  assert.equal(fixed.error, undefined, JSON.stringify(fixed));
  assert.equal(await level(), true);
  assert.equal((await (await kit()).data.tags), '["research","client-work"]', "and it came back as the roster says");
  assert.equal((await d.registry.call("agents.mirror", {}, "module:vyred")).data.created + (await d.registry.call("agents.mirror", {}, "module:vyred")).data.updated, 0, "a level mirror changes nothing");

  // delete follows
  assert.equal((await call("agents.delete", { agent: "kit" })).error, undefined);
  await until(async () => !(await kit()), "kit's record to go");
  assert.equal(await level(), true);
});
