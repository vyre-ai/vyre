// @ts-check
// Installing an app on the owner's own server asks for no presence proof (the owner's rule: a proof is for pairing a device, the Vault and sending to the outside world). It is still the owner's alone: an agent,
// a guest and a name outside this build's catalog are refused with no proof either. Removing an app keeps its data without a proof; only deleting the data asks. The real Presence is the gate here, with no way to prove.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { Presence } from "../presence/index.js";
import { seam } from "./index.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("appmods.install runs for the signed-in owner with no proof; an agent, a guest and a name outside the catalog are refused; remove asks only for data:true", { timeout: 120_000 }, async t => {
  seam.driver = /** @type {any} */ ({ kind: "fake", up: async () => { throw new Error("the runtime would not start it"); }, exec: async () => ({ code: 0, stdout: "" }), status: async () => ({ state: "stopped" }), stop: async () => {}, down: async () => {}, logs: async () => "" });
  t.after(() => { seam.driver = null; });
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true,
    presence: (/** @type {any} */ deps) => new Presence({ ...deps, touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) }, who: async () => [], statTty: () => ({ uid: 0, isCharacterDevice: () => true }), writeTty: () => {} }),
    kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, owner = K.id.owner;
  const meta = async () => ({ token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token });
  const asOwner = async (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli", await meta());
  const code = (/** @type {any} */ r) => (r && r.error ? String(r.error.code) : "");

  // the owner, no proof: past the gate (the fake runtime then refuses to start, which is not a presence refusal)
  const ok = await asOwner("appmods.install", { name: "documents" });
  assert.notEqual(code(ok), "presence_required", JSON.stringify(ok).slice(0, 300));
  assert.notEqual(code(ok), "needs_presence");
  assert.match(String(ok.error && ok.error.message), /would not start|runtime/i, "it reached the install itself: " + JSON.stringify(ok).slice(0, 300));

  // a name that is not in this build's catalog is refused, with no proof either
  const nope = await asOwner("appmods.install", { name: "not-an-app" });
  assert.ok(nope.error && !/presence/.test(code(nope)) && /no app module called/.test(nope.error.message), JSON.stringify(nope).slice(0, 300));

  // an agent and a guest never install
  for (const who of ["mcp:agent:kit", "mcp", "tailnet-guest:abc"]) {
    const r = await d.registry.call("appmods.install", { name: "documents" }, who, { thread: "t1", agent: "kit", agentKind: "agent" });
    assert.ok(r.error, `${who} is refused: ${JSON.stringify(r).slice(0, 200)}`);
  }

  // remove: the container without a proof, the data only with one
  const keep = await asOwner("appmods.remove", { name: "documents" });
  assert.ok(keep.error && !/presence/.test(code(keep)), "no proof asked to keep the data: " + JSON.stringify(keep).slice(0, 200));
  const wipe = await asOwner("appmods.remove", { name: "documents", data: true });
  assert.equal(code(wipe), "presence_required", "deleting the data asks: " + JSON.stringify(wipe).slice(0, 200));
});
