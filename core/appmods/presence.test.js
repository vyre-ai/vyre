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

  // what the presence floor itself says about these tools (the same question the registry asks before every call)
  const floor = /** @type {any} */ (d.registry.deps.presence), def = (/** @type {string} */ n) => /** @type {any} */ (d.registry).tools.get(n);
  assert.equal(floor.required("appmods.install", def("appmods.install"), { name: "documents" }), false, "installing asks for no proof");
  assert.equal(floor.required("appmods.remove", def("appmods.remove"), { name: "documents" }), false, "removing and keeping the data asks for none");
  assert.equal(floor.required("appmods.remove", def("appmods.remove"), { name: "documents", data: false }), false);
  assert.equal(floor.required("appmods.remove", def("appmods.remove"), { name: "documents", data: true }), true, "deleting the data asks");
  assert.equal(floor.required("appmods.remove", def("appmods.remove")), true, "a listing of the tool (no input) counts as asking");

  // the owner's paired device or tailnet node still needs the person's session (the sign-in rule, unchanged: reach person), and with it the install runs with no proof
  for (const who of ["device:abcdefghijklmnop", "tailnet:alex@example.com"]) {
    const without = await d.registry.call("appmods.install", { name: "not-an-app" }, who, {});
    assert.equal(String(without.error && without.error.code), "person_session_required", `${who} without a person session: ${JSON.stringify(without).slice(0, 200)}`);
    const withSession = await d.registry.call("appmods.install", { name: "not-an-app" }, who, { person: { id: owner } });
    assert.ok(withSession.error && /no app module called/.test(String(withSession.error.message)) && !/presence|held|approval/.test(String(withSession.error.code)), `${who} with a person session reaches the install: ${JSON.stringify(withSession).slice(0, 300)}`);
  }
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
  assert.ok(!/presence/.test(code(keep)) && keep.data && keep.data.removed === true, "the failed install left a row, and removing it asks no proof: " + JSON.stringify(keep).slice(0, 200));
});
