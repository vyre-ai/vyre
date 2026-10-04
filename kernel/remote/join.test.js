// @ts-check
// RC1, the remote door's half of the invitee's first key: `grants.invites.accept` may carry `bind` beside `seen` and `proof`. The door reads the identity's list from the directory (never from the caller), needs the
// device the transport verified to be on it and not young, and only then asks the sealing process to enrol the key; every refusal answers one reason code and enrols nothing, and the kernel never sees `bind`.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteServer } from "./server.js";

const SPACE = "spc_aaaaaaaaaaaa", KIT = "per_" + "k".repeat(26), INVITE = "inv_" + "a".repeat(32), ENTRY = "e".repeat(26);
const bind = { key_id: "dk_1", spki: "c3BraQ", signer: "secure_enclave", sig: "c2ln" };
/** @param {{ evidence?: any, invite?: any, join?: (i: any) => any, joinKey?: boolean, noEvidence?: boolean }} [o] */
function rig(o = {}) {
  const seen = { accepted: /** @type {any[]} */ ([]), joined: /** @type {any[]} */ ([]), evidence: /** @type {any[]} */ ([]) };
  const chain = { fake: "invitee chain" };
  const k = {
    chains: { fromFacts: () => chain },
    gateway: { members: { roleOf: () => null }, grants: { invites: {
      get: async () => (o.invite === undefined ? { status: "pending" } : o.invite),
      accept: async (/** @type {any} */ c, /** @type {string} */ id, /** @type {any} */ a) => { seen.accepted.push({ c, id, a }); return { membership: { person: KIT, role: "member" } }; },
    } } },
    surfaces: {},
    ...(o.joinKey === false ? {} : { joinKey: async (/** @type {any} */ i) => { seen.joined.push(i); if (o.join) return o.join(i); return { joined: true }; } }),
  };
  const evidence = o.evidence === undefined ? { ops: [{ id: KIT }], entries: [{ eid: ENTRY, kind: "device", pub: "cHVi", young: false }] } : o.evidence;
  const server = createRemoteServer({ space: SPACE, kernel: k, ...(o.noEvidence ? {} : { identityEvidence: async (/** @type {any} */ w) => { seen.evidence.push(w); return evidence; } }) });
  const ask = (/** @type {any} */ b, peer = {}) => server.serve({ v: 1, space: SPACE, id: "rq_" + Math.random().toString(36).slice(2), ts: Date.now(), call: "grants.invites.accept", args: [INVITE, { seen: { role: "member" }, proof: { key_id: "dk_1" }, ...(b === undefined ? {} : { bind: b }) }] }, { device_key_id: "inv_chan", person: KIT, path: "relay", entry: ENTRY, name: "kit.vyre.run", ...peer });
  return { ask, seen, chain };
}

test("a good bind: the identity list is read from the directory by the verified name, the sealing process is asked once with the chain's ops and the entry the transport verified, then the kernel accepts without the bind", async () => {
  const { ask, seen, chain } = rig();
  const r = await ask(bind);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen.evidence, [{ person: KIT, name: "kit.vyre.run" }]);
  assert.equal(seen.joined.length, 1);
  assert.deepEqual(seen.joined[0], { chain, person: KIT, ops: [{ id: KIT }], bind: { eid: ENTRY, sig: "c2ln" }, invite: INVITE, key_id: "dk_1", spki: "c3BraQ", signer: "secure_enclave" });
  assert.deepEqual(seen.accepted[0].a, { seen: { role: "member" }, proof: { key_id: "dk_1" } }, "the kernel never sees the bind");
});

test("the device is the one the transport verified, never one the caller names: a bind that tries to name its own entry or ops is ignored", async () => {
  const { ask, seen } = rig();
  await ask({ ...bind, eid: "x".repeat(26), ops: [{ id: "per_forged" }], person: "per_other" });
  assert.equal(seen.joined[0].bind.eid, ENTRY);
  assert.deepEqual(seen.joined[0].ops, [{ id: KIT }]);
  assert.equal(seen.joined[0].person, KIT);
});

test("each refusal answers one code, enrols nothing and accepts nothing", async () => {
  const cases = /** @type {[string, any, string, any?][]} */ ([
    ["the entry is not on the list", { evidence: { ops: [], entries: [{ eid: "z".repeat(26), kind: "device", pub: "cHVi" }] } }, "not_listed"],
    ["the entry is a newcomer", { evidence: { ops: [], entries: [{ eid: ENTRY, kind: "device", pub: "cHVi", young: true }] } }, "young_device"],
    ["the directory cannot be read", { evidence: null }, "unavailable"],
    ["the invite is spent", { invite: { status: "used" } }, "bad_invite"],
    ["this build has no sealing process", { joinKey: false }, "unavailable"],
    ["no directory port", { noEvidence: true }, "unavailable"],
    ["the sealing process says the binding is wrong", { join: () => { throw Object.assign(new Error("bad_binding"), { code: "bad_binding" }); } }, "bad_binding"],
    ["the sealing process knows this person", { join: () => { throw Object.assign(new Error("known_person"), { code: "known_person" }); } }, "known_person"],
    ["the sealing process answers something odd", { join: () => { throw new Error("boom: secret details"); } }, "unavailable"],
  ]);
  for (const [why, o, code] of cases) {
    const { ask, seen } = rig(o);
    const r = await ask(bind);
    assert.equal(r.ok, false, why);
    assert.equal(r.error.code, code, `${why}: ${JSON.stringify(r.error)}`);
    assert.doesNotMatch(r.error.message, /secret|boom|dk_1/, `${why}: the message is our own words`);
    assert.equal(seen.accepted.length, 0, `${why}: the invite was not accepted`);
  }
  // a device with no verified entry (a hello that did not name one) cannot join
  const { ask, seen } = rig();
  const r = await ask(bind, { entry: undefined });
  assert.equal(r.error.code, "unavailable");
  assert.equal(seen.joined.length, 0);
});

test("a malformed bind is refused before anything is read, and an accept with no bind runs the kernel's own accept as before", async () => {
  for (const bad of [null, [], "x", {}, { ...bind, key_id: "" }, { ...bind, spki: "a".repeat(401) }, { ...bind, sig: 7 }, { ...bind, attestation: "x" }]) {
    const { ask, seen } = rig();
    const r = await ask(/** @type {any} */ (bad));
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.error.code, "bad_binding", JSON.stringify(bad));
    assert.equal(seen.evidence.length + seen.joined.length + seen.accepted.length, 0);
  }
  const { ask, seen } = rig();
  const r = await ask(undefined);
  assert.equal(r.ok, true);
  assert.equal(seen.joined.length + seen.evidence.length, 0, "no bind, no enrolment");
  assert.equal(seen.accepted.length, 1);
});
