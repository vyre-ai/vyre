// @ts-check
// The owner's ruling (19 Oct), one rule for every layer: which presence keys turn approvals on (Presence.notPhoneKeyIds / hasPresenceDevice), and the kernel's remote path (kernel/core/authorize.js
// presenceNotNeeded) asking the same Presence. Six cases for the sources, then the kernel's own invite refusal (the walk's log: grants.invites.create refused as needs_presence) with the walk's box.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { createKernel } from "../../kernel/index.js";
import { noPresenceForChain } from "./index.js";
import { tempHome } from "../../test/helpers.js";

const key = () => crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");

test("which keys turn approvals on: native biometric and a relay hardware phone count; relay software, from_browser, setup, first-key and an old key with no source and no row do not; an unreadable table counts all", { timeout: 120_000 }, async t => {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true });
  t.after(() => d.stop());
  const p = /** @type {any} */ (d.registry.deps.presence), db = d.registry.deps.db;
  const row = (/** @type {string} */ id, /** @type {string} */ keyId, /** @type {number} */ browser, /** @type {string} */ storage, removed = null) =>
    db.prepare("INSERT OR REPLACE INTO relay_devices (id, name, pub, presence_key, paired_at, kind, trusted, removed_at, key_storage, from_browser) VALUES (?, 'x', 'p', ?, 1, 'app', 0, ?, ?, ?)").run(id, keyId, removed, storage, browser);
  /** @param {string | null} source */ const enrol = source => p.enroll({ kind: "device", name: "k", public_key: key(), alg: -7, ...(source ? { source } : {}) });
  const only = async (/** @type {any} */ k, /** @type {() => void} */ then) => { try { assert.equal(p.hasPresenceDevice(), false, "ignored"); then(); } finally { p.remove(k.id); } };
  const counts = (/** @type {any} */ k) => { assert.equal(p.hasPresenceDevice(), true, "counts"); p.remove(k.id); };

  assert.equal(p.hasPresenceDevice(), false, "no keys");
  counts(enrol("native"));                                                                   // the app's biometric key
  { const k = enrol("relay"); row("relayhard0000000", k.id, 0, "hardware"); counts(k); }     // a phone paired through the relay, key outside software
  { const k = enrol("relay"); row("relaysoft0000000", k.id, 0, "software"); await only(k, () => {}); }
  { const k = enrol("relay"); row("relaybrow0000000", k.id, 1, "hardware"); await only(k, () => {}); }
  { const k = enrol("relay"); row("relayremoved0000", k.id, 0, "hardware", 5); await only(k, () => {}); }
  await only(enrol("setup"), () => {});
  await only(enrol("first-key"), () => {});
  await only(enrol(null), () => {});                                                          // an old key, no source, no relay row
  { const k = enrol(null); row("oldhard0000000000", k.id, 0, "hardware"); counts(k); }       // an old key with a hardware relay row counts
  // a passkey always counts
  { const k = p.enroll({ kind: "passkey", name: "pk", public_key: key(), alg: -7, rp_id: "x.example", credential_id: "cred-abcdefgh" }); counts(k); }
  // an unreadable table counts every key
  { const k = enrol("setup"); db.exec("ALTER TABLE relay_devices RENAME TO relay_devices_x"); try { assert.equal(p.hasPresenceDevice(), true, "errors count"); } finally { db.exec("ALTER TABLE relay_devices_x RENAME TO relay_devices"); p.remove(k.id); } }
  // no request can say where a key came from: the tool derives the source from the caller (module:relay only)
  const viaTool = await d.registry.call("presence.enroll", { kind: "device", name: "x", public_key: key(), alg: -7, source: "native" }, "module:relay", {});
  if (viaTool.data) assert.equal(db.prepare("SELECT source FROM presence_keys WHERE id = ?").get(viaTool.data.id).source, "relay", "module:relay's own source, never the input's");
});

test("the kernel's remote path: the owner as one person passes an invite with no counted device, and not once a phone counts; an agent, another person and the ownership acts never pass", { timeout: 120_000 }, async () => {
  const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", ADA = "per_ada";
  let device = false;
  const fake = { hasPresenceDevice: () => device };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence: { check: async () => "wrong_proof" }, presenceNotNeeded: (/** @type {any} */ q) => noPresenceForChain({ presence: fake, owner: () => OWNER }, q) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct", session: `s-${id}` });
  const g = k.gateway.grants;
  const owner = dev(OWNER, "d-o");
  const card = await g.invites.create(owner, { role: "member" });
  assert.ok(card && card.id, "the owner makes an invite with no counted device: " + JSON.stringify(card));
  // the people and agents that never pass
  await g.setRole(owner, { person: BOB, role: "admin" }).catch(() => {});
  await assert.rejects(() => g.invites.create(dev(BOB, "d-b"), { role: "member" }), /./, "another person is refused");
  const asst = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: OWNER, agent: "kit", session: "s-k" });
  await assert.rejects(() => g.invites.create(asst, { role: "member" }), /./, "an assistant is refused");
  // owner-making routes keep asking: an invite whose role is owner; a member's, an admin's and a custom role's pass
  await assert.rejects(() => g.invites.create(owner, { role: "owner" }), e => e.code === "needs_presence" || /presence/i.test(e.message), "an owner invite asks");
  assert.ok((await g.invites.create(owner, { role: "admin" })).id, "an admin invite passes");
  await g.setRole(owner, { person: ADA, role: "member" });   // grants.member: giving a role below owner passes
  await g.setRole(owner, { person: ADA, role: "manager" });
  // the ownership acts keep asking
  await assert.rejects(() => g.setRole(owner, { person: ADA, role: "owner" }), e => e.code === "needs_presence" || /presence/i.test(e.message));
  await assert.rejects(() => g.transferOwner(owner, { to: ADA }), e => e.code === "needs_presence" || /presence/i.test(e.message));
  // a phone counts: the proof is asked again
  device = true;
  await assert.rejects(() => g.invites.create(owner, { role: "member" }), e => e.code === "needs_presence" || /presence/i.test(e.message), "with a counted phone the proof is asked");
});

test("the hook's exact names: grants.role asks; an invite confirm asks unless the STORED role is a member's or admin's; a confirm with no role asks; requests.setting passes", () => {
  const OWNER = "per_owner";
  const chain = { viewer: false, hops: [{ actor: { kind: "person", id: OWNER } }] };
  const ask = (/** @type {string} */ action, /** @type {any} */ payload) => noPresenceForChain({ presence: { hasPresenceDevice: () => false }, owner: () => OWNER }, { chain, action, payload });
  assert.equal(ask("grants.role", { transfer: { to: "per_x" } }), false, "transfer asks");
  assert.equal(ask("grants.role", {}), false, "making an owner asks");
  assert.equal(ask("grants.member", { person: "per_x", role: "admin" }), true, "a member's role change passes");
  assert.equal(ask("grants.invite", { role: "member" }), true, "a member invite passes");
  assert.equal(ask("grants.invite", { role: "owner" }), false, "an owner invite asks");
  assert.equal(ask("grants.invite", { confirm: "inv", words: "w", role: "admin" }), true, "confirming an admin invite passes");
  assert.equal(ask("grants.invite", { confirm: "inv", words: "w", role: "owner" }), false, "confirming an owner invite asks");
  assert.equal(ask("grants.invite", { confirm: "inv", words: "w" }), false, "a confirm with no stored role asks");
  assert.equal(ask("requests.setting", { accepting: true }), true, "requests.setting passes");
});
