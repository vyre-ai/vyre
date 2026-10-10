// @ts-check
// R031-95 2.2, review row 1: a lent computer gets its lease only when the key listed for it signs the home's challenge, and in production that key is in the app. This drives the PRODUCTION path end to end:
// a real vyred on the lender's computer (its remote kernel to the Space's home, its approvals queue), a real home (the sealing process checks the signature, the key, the listed device and the fields), and a stand-in for
// the app that does what the app does: read the card, sign exactly what it shows with the key, answer. Nothing signs for free (core/runner/testing/lent-rig.js does, which is how this was missed).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { createKernel } from "../../kernel/index.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { startSealer } from "../../kernel/seal/client.js";
import { joinBytes } from "../../kernel/seal/wire.js";
import { person as personChain, signer as presenceSigner, tmp } from "../../kernel/seal/testing.js";
import { makeGenesis, eidOf, b64u } from "../../kernel/identity/chain.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { createLentClient } from "./lent-client.js";
import { tempHome } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", DEVICE = "dev_mac", INVITE = "inv_" + "a".repeat(32);
const edKey = async () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32), eid = await eidOf(pub);
  return { eid, pub: b64u(pub), sign: (/** @type {any} */ m) => crypto.sign(null, Buffer.from(m), privateKey), entry: (/** @type {string} */ kind) => ({ eid, kind, pub: b64u(pub) }) };
};
const grantProof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const stubPresence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

/** The Space's home: a real sealing process that knows the person's key, listed for the Mac; signed hellos required; the person has accepted lending this Mac. The lender's vyred reaches it through the same kernel.call wire. */
async function home(/** @type {any} */ t) {
  const dir = tmp("lease-signing"), sealer = startSealer({ dir, timeoutMs: 8000, dev: true, unattested: true });
  t.after(async () => { await sealer.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const mac = await edKey(), recovery = await edKey(), t0 = Date.now() - 2 * 86_400_000;
  const ops = [await makeGenesis({ kind: "person", entry: mac.entry("device"), code: recovery.entry("code"), nonce: "nonce-" + crypto.randomBytes(4).toString("hex"), ts: t0, sign: mac.sign })];
  const bob = ops[0].id, key = presenceSigner(bob), chain = personChain(bob, "deck", SPACE);
  await sealer.join({ chain, person: bob, ops, bind: { eid: mac.eid, sig: b64u(mac.sign(joinBytes(INVITE, SPACE, bob, key.key_id, key.enrolment.spki))) }, invite: INVITE, key_id: key.key_id, spki: key.enrolment.spki, signer: key.enrolment.signer });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 8), sealer, presence: stubPresence, signedHello: true, resolveCredential: async () => ({ secret: "v" }) });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants, role = { person: bob, role: "member" };
  await g.setRole(owner, role, { presence: grantProof("grants.role", role, `vyre://${SPACE}/member/${bob}`) });
  const offer = (/** @type {any} */ c, /** @type {any} */ x) => g.offers.offer(c, x, { presence: grantProof("grants.offer", x, `vyre://${SPACE}/offer/new`) });
  await offer(owner, { side: "space_allows", member: bob });
  await offer(k.chains.fromFacts({ kind: "device", device_key_id: DEVICE, person: bob, path: "direct" }), { side: "member_accepts", member: bob, device: DEVICE, device_key: DEVICE });
  const server = createRemoteServer({ space: SPACE, kernel: k, services: {} });
  const peer = { device_key_id: DEVICE, person: bob, path: "wink" };
  const sessionFor = async () => ({ call: async (/** @type {string} */ _tool, /** @type {any} */ input) => JSON.parse(JSON.stringify(await server.serve(JSON.parse(JSON.stringify(input)), { ...peer }))) });
  return { k, mac, bob, key, chain, sessionFor };
}

/** The lender's vyred, with the Space's home as its server (a server-hosted row and the session to it). */
async function lender(/** @type {any} */ t, /** @type {any} */ h) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "mac", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  const d = await start({ root, kernel: true, sessionFor: h.sessionFor, log: () => {} });
  t.after(() => d.stop());
  d.registry.deps.db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`server-hosted/${SPACE}`, JSON.stringify({ device: "srv_home0000000001" }));
  const remote = d.kernel.spaces.for(SPACE);
  const client = createLentClient({ invoke: remote.call, device: DEVICE, deviceKey: DEVICE, eid: h.mac.eid, cap: () => "provider" });
  return { d, client };
}

/** The app on the lender's computer: it lists the cards, shows what one says, signs exactly that with the key (naming the home and the challenge a card carries) and answers. */
function app(/** @type {any} */ d, /** @type {any} */ h, /** @type {{ sign?: (card: any) => any }} */ o = {}) {
  const seen = /** @type {any[]} */ ([]);
  const run = (async () => {
    for (let i = 0; i < 200; i++) {
      const pending = await d.registry.call("approvals.pending", {}, "deck");
      const card = ((pending.data && pending.data.approvals) || []).find((/** @type {any} */ c) => c.op === "lease.issue");
      if (card) {
        seen.push(card);
        const proof = o.sign ? o.sign(card) : h.key.proof(h.chain, card.op, card.fields, { extra: card.home && card.challenge ? { home: card.home, challenge: card.challenge } : {} });
        return d.registry.call("approvals.answer", { id: card.id, approve: true }, "deck", { kernel_proof: proof });
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error("no card came");
  })();
  return { seen, answered: run };
}

test("a lent computer's lease is signed in production: the runner puts a card on this computer's queue, the app signs what it shows, the home checks the key, and the lease is issued", { timeout: 180_000 }, async t => {
  const h = await home(t), { d, client } = await lender(t, h);
  const a = app(d, h);
  const [leased, answer] = await Promise.all([client.vault.lease(), a.answered]);
  assert.equal(answer.data && answer.data.answered, "approved", JSON.stringify(answer));
  assert.equal(Buffer.from(leased.key, "base64").length, 32, "the home issued a key");
  assert.ok((await client.vault.renew({ id: leased.id })).ttlMs > 0, "and the home knows the lease");
  // what the card said, in words a person reads: this computer is lent to a Space, for exactly the request the home named
  const card = a.seen[0];
  assert.equal(card.title, "Lend this computer to a Space");
  assert.equal(card.fields.device, DEVICE);
  assert.equal(card.fields.eid, h.mac.eid);
  assert.equal(card.fields.cap, "provider");
  assert.match(card.home, /\S/); assert.match(card.challenge, /\S/);
  assert.ok(card.expires_in_s <= 110, "the card ends with the home's challenge");
  // asking again gets a fresh card and a fresh challenge: a signed request is single use
  const b = app(d, h);
  const [again] = await Promise.all([client.vault.lease(), b.answered]);
  assert.ok(again.id && b.seen[0].challenge !== card.challenge);
});

test("nothing but the key listed for this computer, signing this card, gets a lease: a proof for another challenge, another request or another person's key is refused, and the card is not the app's to make", { timeout: 180_000 }, async t => {
  const h = await home(t), { d, client } = await lender(t, h);
  // an app that signs without naming the home and the challenge: this computer's queue refuses to take the answer, the card stays waiting, and the right answer then gets the lease
  const lease = client.vault.lease();
  const loose = app(d, h, { sign: card => h.key.proof(h.chain, card.op, card.fields) });
  const refused = await loose.answered;
  assert.equal(refused.error && refused.error.code, "needs_presence", "a proof that does not name the card's challenge is not taken");
  await app(d, h).answered;
  assert.ok((await lease).id, "the card was still waiting for the right answer");
  // another person's key, even a well-formed proof naming the right home and challenge, is no lease
  const stranger = presenceSigner("per_stranger");
  const other = app(d, h, { sign: card => stranger.proof(h.chain, card.op, card.fields, { extra: { home: card.home, challenge: card.challenge } }) });
  const [r2] = await Promise.allSettled([client.vault.lease(), other.answered]);
  assert.equal(r2.status, "rejected", "the home does not know that key");
  // the card is the runner's alone to ask for, and a surface cannot read its proof
  const cli = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  assert.ok((await cli("approvals.lease-ask", { space: SPACE, fields: { device: DEVICE }, home: "h", challenge: "c" })).error, "a surface cannot put a lease card on the queue");
  assert.ok((await cli("approvals.ask", { op: "lease.issue", space: SPACE, fields: { device: DEVICE } })).error, "nor through the phone's ask");
  assert.ok((await cli("approvals.lease-status", { id: "ap_x" })).error);
});
