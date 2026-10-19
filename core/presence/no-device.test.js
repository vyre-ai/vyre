// @ts-check
// The owner's ruling (19 Oct): a person with no presence device enrolled passes the presence floor on their signed-in session; with a device enrolled, the proof is asked as before. The decision is the server's, from
// its table of enrolled keys; an agent, a model and another person's session never pass. The real Presence is the gate and nothing here can prove presence.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
  // the owner's signed-in session, as the daemon hands it to the registry
  const meta = async (/** @type {any} */ more = {}) => ({ person: { id: owner }, token: (await K.surfaces.open(K.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: owner, path: "direct", session: "s" }), {})).token, ...more });
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
  // 3b. the plain surface labels never get the pass, however the daemon measured them: a terminal measured outside every model, one measured inside, and an unmeasured one (the ancestry measure can be dodged by a
  // process that detaches from its session, so only the owner's signed-in session counts, never a label)
  for (const who of ["cli", "local", "capsule"]) {
    for (const kernelFacts of [outside, { ...outside, inside_model_process: true }, undefined]) {
      const r = await reveal(who, kernelFacts ? { kernelFacts } : {});
      assert.ok(r.error && !/no item|locked|not found/i.test(String(r.error.message)), `${who} (${kernelFacts ? `inside_model_process ${kernelFacts.inside_model_process}` : "unmeasured"}) never reaches the Vault: ${JSON.stringify(r).slice(0, 200)}`);
    }
  }
  // 4. the owner's paired device passes only with a session that names the owner; another person's session and no session do not
  const owners = await reveal("device:abcdefghijklmnop", { person: { id: owner } });
  assert.ok(owners.error && !asked(owners), "the owner's device with the owner's session passes: " + JSON.stringify(owners).slice(0, 200));
  const other = await reveal("device:abcdefghijklmnop", { person: { id: "per_" + "z".repeat(26) } });
  assert.ok(other.error && !/no item|locked/i.test(String(other.error.message)), "another person's session does not pass: " + JSON.stringify(other).slice(0, 200));
  const none = await reveal("device:abcdefghijklmnop", {});
  assert.equal(String(none.error && none.error.code), "person_session_required");

  // 4b. the owner's paired device (the daemon vouched it as the owner's in kernelFacts) can make an invite with no passkey sign-in; a limited device, another person's, and an agent cannot
  const devFacts = { kind: "device", device_key_id: "abcdefghijklmnop", person: owner, path: "relay" };
  const invite = (/** @type {string} */ who, /** @type {any} */ m) => d.registry.call("spaces.invites.create", { role: "member" }, who, m);
  const made = await invite("device:abcdefghijklmnop", { kernelFacts: devFacts });
  assert.ok(!made.error || !["person_session_required", "presence_required", "denied"].includes(String(made.error.code)), "the owner's device makes an invite: " + JSON.stringify(made).slice(0, 240));
  for (const [who, m] of /** @type {[string, any][]} */ ([["device:abcdefghijklmnop", {}], ["device:abcdefghijklmnop", { kernelFacts: { ...devFacts, limited: true } }], ["device:abcdefghijklmnop", { kernelFacts: { ...devFacts, person: "per_" + "z".repeat(26) } }], ["mcp:agent:kit", { kernelFacts: devFacts }]])) {
    const r = await invite(who, m);
    assert.ok(r.error && ["person_session_required", "presence_required", "denied", "approval_refused", "held_for_approval", "held_unavailable"].includes(String(r.error.code)), `${who} ${JSON.stringify(m).slice(0, 60)} cannot make an invite: ${JSON.stringify(r).slice(0, 200)}`);
  }
  // 4c. making an owner and handing the Space over keep their presence step with no device enrolled, for the owner's own session too
  for (const [tool, input] of /** @type {[string, any][]} */ ([["spaces.owner.transfer", { space: K.id.space, to: "per_" + "y".repeat(26) }], ["spaces.members.transfer", { space: K.id.space, to: "per_" + "y".repeat(26) }], ["spaces.members.set-role", { space: K.id.space, person: "per_" + "y".repeat(26), role: "owner" }]])) {
    const r = await d.registry.call(tool, input, "cli", await meta());
    assert.ok(r.error && ["presence_required", "needs_presence", "held_for_approval", "person_session_required"].includes(String(r.error.code)), `${tool} still asks for presence: ${JSON.stringify(r).slice(0, 200)}`);
  }
  // 4d. the owner's web browser never pairs a device on the no-device pass; the app device does (the first phone is paired from the app). The decision itself, for every pairing tool.
  for (const tool of ["relay.pair.ticket", "link.pair.approve", "wink.approve", "presence.enroll", "relay.devices.trust", "relay.enable"]) {
    assert.equal(await d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: { ...devFacts, web: true } }, tool, {}), false, `${tool}: a web browser is asked`);
    assert.equal(await d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: devFacts }, tool, {}), true, `${tool}: the app device is not asked`);
  }
  assert.equal(await d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: { ...devFacts, web: true } }, "spaces.invites.create", {}), true, "a web browser still makes an invite");
  // 4e. exactly the walk's box: two device keys with no relay row (the first-run browser's identity key and the in-page host's) are not phones, so the owner passes; a software key on a relay row, a browser row and an
  // old 0.6.1 row are not phones either; a hardware phone's row (paired from the app) ends the window. A passkey always counts. The reason says why in counts and kinds.
  {
    const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const db = d.registry.deps.db;
    const ask = (/** @type {boolean} */ why = false) => d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: devFacts }, "spaces.invites.create", {}, why);
    const row = (/** @type {string} */ id, /** @type {string} */ keyId, /** @type {number} */ browser, /** @type {string} */ storage) =>
      db.prepare("INSERT OR REPLACE INTO relay_devices (id, name, pub, presence_key, paired_at, kind, trusted, removed_at, key_storage, from_browser) VALUES (?, 'x', 'p', ?, 1, 'app', 0, NULL, ?, ?)").run(id, keyId, storage, browser);
    const a = presence.enroll({ kind: "device", name: "first-run browser", public_key: key(), alg: -7 });
    const b = presence.enroll({ kind: "device", name: "in-page host", public_key: key(), alg: -7 });
    assert.equal(presence.keys().length, 2);
    assert.equal(await ask(), true, "two device keys with no relay rows: the owner passes");
    row("softdev000000000", a.id, 0, "software");
    row("browserdev0000000", b.id, 1, "hardware");
    assert.equal(await ask(), true, "a software key and a browser's key are not phones");
    const phone = presence.enroll({ kind: "device", name: "phone", public_key: key(), alg: -7 });
    row("phonedev000000000", phone.id, 0, "hardware");
    assert.equal(await ask(), false, "a hardware phone paired from the app ends the window");
    const why = await ask(true);
    assert.match(why, /keys enrolled: 3, keys ignored \(not a phone\): 2.*caller kind: app; label class: device; owner device: yes; facts: yes/, why);
    assert.doesNotMatch(why, /per_|abcdefghijklmnop/, "no ids in the reason");
    presence.remove(phone.id);
    db.prepare("UPDATE relay_devices SET removed_at = 5 WHERE id = 'phonedev000000000'").run();
    assert.equal(await ask(), true, "back to the walk's box");
    const pk = presence.enroll({ kind: "passkey", name: "pk", public_key: crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7, rp_id: "x.example", credential_id: "cred-abcdefgh" });
    assert.equal(await ask(), false, "a passkey always counts");
    presence.remove(pk.id); presence.remove(a.id); presence.remove(b.id);
  }
  // 4f. the real shape of a signed-in session: meta.person is the box's own session row ({ id: a random session id, kind: cookie }), never the owner's person id. The walk's log: owner device yes, facts yes, session
  // yes, every key ignored, and the floor still asked. It must pass; a member's device facts, a session with no kind, and an unnamed id must not.
  {
    const session = { id: "sess_" + "q".repeat(20), kind: "cookie" };
    const hooks = (/** @type {any} */ meta) => d.registry.noPresenceDevice("device:abcdefghijklmnop", meta, "hooks.open", { name: "nw" });
    assert.equal(await hooks({ kernelFacts: devFacts, person: session }), true, "the owner's device with a real session passes hooks.open");
    assert.equal(await hooks({ kernelFacts: devFacts, person: { ...session, kind: "bearer" } }), true);
    assert.equal(await hooks({ person: session }), true, "a session alone passes for the owner's device label");
    assert.equal(await hooks({ kernelFacts: devFacts, person: { id: "x" } }), false, "an id that names nobody and has no session kind does not");
    assert.equal(await hooks({ kernelFacts: { ...devFacts, person: "per_" + "z".repeat(26) }, person: session }), false, "a member's device facts never pass, session or not");
    assert.equal(await d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: devFacts, person: session }, "spaces.invites.create", {}), true, "and an invite");
    assert.equal(await d.registry.noPresenceDevice("device:abcdefghijklmnop", { kernelFacts: devFacts, person: session }, "spaces.owner.transfer", {}), false, "ownership still asks");
    // through Registry.call itself: the floor and the retrofit gate must not answer a presence step for these facts (any other refusal, say a bad input, is not what this checks)
    for (const [tool, input] of /** @type {[string, any][]} */ ([["hooks.open", { name: "nw", scheme: "hmac-sha256", header: "x-sig", secret: "s".repeat(24) }], ["spaces.invites.create", { space: K.id.space, role: "member" }]])) {
      const r = await d.registry.call(tool, input, "device:abcdefghijklmnop", { kernelFacts: devFacts, person: session, thread: "t1" });
      assert.ok(!(r.error && ["presence_required", "person_session_required", "held_for_approval", "needs_presence"].includes(String(r.error.code))), `${tool} through Registry.call: ${JSON.stringify(r).slice(0, 300)}`);
    }
  }
  // 5. a device is enrolled (the server's records now say so): the proof is asked again, however the call is labelled
  const was = presence.keys;
  presence.keys = () => [{ id: "k1", kind: "device", name: "phone" }];
  t.after(() => { presence.keys = was; });
  const back = await reveal("cli", await meta({ presence: { method: "no-device", keyId: null } }));
  assert.ok(asked(back), "with a device enrolled the owner is asked again, and a claim in the call does not change that: " + JSON.stringify(back).slice(0, 240));
});
