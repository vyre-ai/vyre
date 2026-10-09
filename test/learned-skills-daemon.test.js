// @ts-check
// A lesson becomes a skill draft (R031-44), on a REAL vyred: what learn proposes from a repeated procedure is drafted into the skills library for the owner, at the project level when it names a project, and
// nothing uses it until the owner approves.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../core/daemon/index.js";
import { tempHome } from "./helpers.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const used = new Set();
const presence = { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_payload") };
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

test("a skill drafted from a lesson waits for the owner, and approving it makes it the version in use", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {}, kernel: true, kernelPresence: presence });
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const as = async (/** @type {any} */ c) => ({ token: (await d.kernel.surfaces.open(c, {})).token });
  const call = async (/** @type {any} */ c, /** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", await as(c));
  const body = "---\nname: ship-it\ndescription: Ship a change.\n---\n1. Run the tests.\n2. Push.";
  assert.ok((await call(ownerChain, "skills.draft.learned", { name: "ship-it", body })).error, "a person's call cannot use the module-only tool");
  const made = await d.registry.call("skills.draft.learned", { name: "ship-it", body }, "module:learn");
  assert.ok(made.data, JSON.stringify(made.error));
  assert.equal(made.data.state, "draft");
  assert.equal(made.data.level, "personal");
  const v = await call(ownerChain, "skills.versions", { state: "draft" });
  assert.deepEqual((v.data.versions || []).map((/** @type {any} */ x) => [x.name, x.level, x.version]), [["ship-it", "personal", 1]], JSON.stringify(v));
  const ok = await call(ownerChain, "skills.approve", { name: "ship-it", level: "personal", version: 1 });
  assert.ok(ok.data, JSON.stringify(ok.error));
  const list = await call(ownerChain, "skills.list", {});
  assert.ok(JSON.stringify(list.data).includes("ship-it"), "approved: it is in the person's skills");
});
