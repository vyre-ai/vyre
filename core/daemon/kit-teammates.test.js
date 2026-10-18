// @ts-check
// A Kit's assistants (its `teammates` part), on a REAL vyred: installing the Kit makes each one with agents.create as the person who approved it, an assistant of the same name that was already there is left
// alone and not claimed, and removing the Kit removes the ones it made and nothing else. (Before, the port was not provided and a Kit's assistants silently came to nothing.)
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "./index.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const until = async (/** @type {() => Promise<any>} */ f, /** @type {string} */ what, ms = 30_000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) assert.fail(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); } };

const kit = () => ({
  format: 1, id: "front-desk", version: 1, name: "Front desk", description: "Two assistants for the front desk.",
  includes: { types: [], templates: [], roles: [], flows: [], teammates: [
    { name: "desk-helper", instructions: "Greet the person, find the matter and say what is next." },
    { name: "my-own", instructions: "This is the Kit's text, not the person's." },
  ] },
});

test("installing a Kit makes its assistants as the approver, leaves a same-named one alone, and removing the Kit removes only the ones it made", { timeout: 180_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, owner = K.id.owner;
  const chainOf = () => K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" });
  const meta = async () => ({ token: (await K.surfaces.open(chainOf(), {})).token });
  const call = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", await meta()); if (r.error) throw Object.assign(new Error(`${tool}: ${r.error.message}`), { code: r.error.code }); return r.data; };
  const agents = async () => { const r = await call("agents.list"); return Array.isArray(r) ? r : r.agents || []; };

  // the person already has an assistant of this name, with their own words
  await call("agents.create", { name: "my-own", instructions: "Mine." });
  const before = (await agents()).map((/** @type {any} */ a) => a.name);
  assert.ok(before.includes("my-own") && !before.includes("desk-helper"));

  const p = await call("flows.kit.propose", { kit: kit() });
  assert.ok(p && p.ok, JSON.stringify(p));
  assert.ok(!(await agents()).some((/** @type {any} */ a) => a.name === "desk-helper"), "the proposal makes nothing");
  const row = await K.gateway.ask.get(chainOf(), p.task);
  await K.gateway.ask.decide(chainOf(), p.task, { outcome: "approved", proof: { op: "task.decide", fields: { task: p.task, payload_hash: row.payload.payload_hash, decision: row.payload.decision }, n: Math.random() } });
  await until(async () => ((await call("flows.kit.list")) || []).some((/** @type {any} */ k) => k.id === "front-desk" && k.status === "installed"), "the Kit to install");

  const after = await agents();
  const helper = after.find((/** @type {any} */ a) => a.name === "desk-helper");
  assert.ok(helper, "the Kit's assistant was made: " + after.map((/** @type {any} */ a) => a.name).join(", "));
  const mine = after.find((/** @type {any} */ a) => a.name === "my-own");
  assert.ok(mine, "the person's own assistant is still there");
  const shown = await call("agents.get", { agent: "my-own" }).catch(() => null);
  if (shown) assert.match(JSON.stringify(shown), /Mine\./, "and still says what the person wrote");
  assert.ok(!JSON.stringify(shown || {}).includes("This is the Kit's text"), "the Kit did not rewrite it");

  await call("flows.kit.remove", { id: "front-desk" });
  const gone = await agents();
  assert.ok(!gone.some((/** @type {any} */ a) => a.name === "desk-helper"), "removing the Kit removes the assistant it made");
  assert.ok(gone.some((/** @type {any} */ a) => a.name === "my-own"), "and keeps the one that was already there");
});
