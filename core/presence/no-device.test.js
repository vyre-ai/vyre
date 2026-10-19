// @ts-check
// The owner's ruling (19 Oct): a person with no presence device enrolled passes the presence floor on their signed-in session; with a device enrolled, the proof is asked as before. The decision is the server's, from
// its table of enrolled keys; an agent, a model and another person's session never pass. The real Presence is the gate and nothing here can prove presence.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { Presence } from "./index.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

test("no enrolled device: the owner's own act passes; an enrolled device brings the proof back; an agent, another person's session and a client's say-so never pass", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true,
    presence: (/** @type {any} */ deps) => new Presence({ ...deps, touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) }, who: async () => [], statTty: () => ({ uid: 0, isCharacterDevice: () => true }), writeTty: () => {} }),
    kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, owner = K.id.owner;
  // what the daemon measures for a plain terminal: nothing above it is a model (callerFacts)
  const outside = { kind: "socket", surface: "cli", uid: 0, pid: 0, inside_model_process: false, capsule_verified: false };
  const meta = async (/** @type {any} */ more = {}) => ({ kernelFacts: outside, token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token, ...more });
  const presence = /** @type {any} */ (d.registry.deps.presence);
  const reveal = (/** @type {string} */ who, /** @type {any} */ m) => d.registry.call("vault.reveal", { name: "no-such-item" }, who, m);
  const asked = (/** @type {any} */ r) => Boolean(r && r.error && ["presence_required", "needs_presence", "held", "held_for_approval", "person_session_required"].includes(String(r.error.code)));

  // 1. the server's own table has no key: the owner's act reaches the Vault (which then says the item is not there, or that it is locked)
  assert.equal(presence.keys().length, 0, "no device enrolled");
  const free = await reveal("cli", await meta());
  assert.ok(free.error && !asked(free), "the owner with no device is not asked: " + JSON.stringify(free).slice(0, 240));
  // 2. what the client says changes nothing: a presence claim in the call's meta is not read
  const forged = await reveal("cli", await meta({ presence: { method: "yes", keyId: "k" } }));
  assert.ok(!asked(forged) === !asked(free), "the same answer with or without the claim");

  // 3. an agent, a model, a module and a guest never pass the floor, with no device enrolled either
  for (const who of ["mcp:agent:kit", "mcp", "harness", "tailnet-guest:abc"]) {
    const r = await reveal(who, { thread: "t1", agent: "kit", agentKind: "agent" });
    assert.ok(r.error && !/no item|locked|not found/i.test(String(r.error.message)), `${who} never reaches the Vault: ${JSON.stringify(r).slice(0, 200)}`);
  }
  // 3b. an agent's shell: the CLI inside a Vyre session is measured as inside a model, or not read at all, and is refused on a floor step with no device enrolled
  for (const kernelFacts of [{ ...outside, inside_model_process: true }, undefined]) {
    const m = await meta(); delete m.token; if (kernelFacts) m.kernelFacts = kernelFacts; else delete m.kernelFacts;
    const r = await reveal("cli", m);
    assert.ok(r.error && !/no item|locked|not found/i.test(String(r.error.message)), `an agent's shell (${kernelFacts ? "inside a model" : "unmeasured"}) never reaches the Vault: ${JSON.stringify(r).slice(0, 200)}`);
  }
  // 4. the owner's paired device passes only with a session that names the owner; another person's session and no session do not
  const owners = await reveal("device:abcdefghijklmnop", { person: { id: owner } });
  assert.ok(owners.error && !asked(owners), "the owner's device with the owner's session passes: " + JSON.stringify(owners).slice(0, 200));
  const other = await reveal("device:abcdefghijklmnop", { person: { id: "per_" + "z".repeat(26) } });
  assert.ok(other.error && !/no item|locked/i.test(String(other.error.message)), "another person's session does not pass: " + JSON.stringify(other).slice(0, 200));
  const none = await reveal("device:abcdefghijklmnop", {});
  assert.equal(String(none.error && none.error.code), "person_session_required");

  // 5. a device is enrolled (the server's records now say so): the proof is asked again, however the call is labelled
  const was = presence.keys;
  presence.keys = () => [{ id: "k1", kind: "device", name: "phone" }];
  t.after(() => { presence.keys = was; });
  const back = await reveal("cli", await meta({ presence: { method: "no-device", keyId: null } }));
  assert.ok(asked(back), "with a device enrolled the owner is asked again, and a claim in the call does not change that: " + JSON.stringify(back).slice(0, 240));
});
