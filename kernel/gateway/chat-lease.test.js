// @ts-check
// A chat's ring rides in the kernel's chat events and a participant's device lends the key to the process: begin, the device opens the ring and answers, finish; then the chat's files open, a rotation drops
// the old key, and a person outside the chat can neither begin nor finish.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { sealedDrive } from "../storage/sealed-drive.js";
import { createRing, openRing, addHolders, removeHolders, bundleFor, ProcessKeys } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const files = () => { const m = new Map(); return { m, async put(p, b) { const f = m.get(p) || []; f.push(Buffer.from(b)); m.set(p, f); return { version: f.length }; }, async get(p, { version } = {}) { const f = m.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1]; },
  stat(p) { const f = m.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return { version: f.length }; }, list(prefix) { return [...m.keys()].filter(k => k.startsWith(prefix)).map(path => ({ path })); }, history() { return []; }, async delete(p) { m.delete(p); return {}; }, async restore() { return {}; } }; };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

async function rig() {
  const raw = files(), keys = new ProcessKeys(() => true);
  /** @type {any} */ let gs = null;
  const drive = sealedDrive(raw, { keysFor: c => { const k = keys.get(c); return k && gs && k.epoch >= gs.chats.epoch(c) ? k : null; }, sealed: c => Boolean(gs && gs.chats.epoch(c) > 0) });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive, chatKeys: keys });
  gs = k.gateway.grants;
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  for (const p of [BOB, CAROL, DAN]) { const r = { person: p, role: "member" }; await gs.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const bob = dev(BOB, "d-b"), carol = dev(CAROL, "d-c"), dan = dev(DAN, "d-d");
  const lease = gs.chats.keys;
  const bobDev = newDeviceKey(), carolDev = newDeviceKey(), danDev = newDeviceKey();
  const hold = d => fingerprint(d.publicJwk);
  return { k, gs, raw, keys, lease, D: k.gateway.drive, bob, carol, dan, bobDev, carolDev, danDev, hold };
}

test("a chat's ring rides in chat.created and chat.changed; adding or removing someone needs the ring that change made, and a removal rotates the epoch", async () => {
  const { gs, bob, dan, bobDev, carolDev, danDev, hold } = await rig();
  const id = "chat_ring01";
  const { doc, keys } = createRing(id, { [hold(bobDev)]: bobDev.publicJwk });
  await assert.rejects(() => gs.chats.create(bob, { id, people: [], ring: { ...doc, id: "chat_other1" } }), { code: "bad_input" }, "the ring is for this chat id");
  const chat = await gs.chats.create(bob, { id, people: [CAROL], ring: doc });
  assert.equal(chat.ring.epoch, 1);
  assert.equal(gs.chats.epoch(id), 1);
  assert.equal(gs.chats.epoch("chat_nothing"), 0);
  await assert.rejects(() => gs.chats.change(bob, id, { add_people: [DAN] }), { code: "bad_input" }, "an add with no ring is refused");
  const added = addHolders(doc, keys, { add: { [hold(carolDev)]: carolDev.publicJwk, [hold(danDev)]: danDev.publicJwk } });
  const n1 = await gs.chats.change(bob, id, { add_people: [DAN], ring: added });
  assert.ok(n1.ring.epochs[1].wraps[hold(danDev)], "the ring in the chat state has the new wrap");
  await assert.rejects(() => gs.chats.change(bob, id, { remove_people: [DAN], ring: added }), { code: "bad_input" }, "a removal that does not rotate is refused");
  const rotated = removeHolders(added, keys, { keep: { [hold(bobDev)]: bobDev.publicJwk, [hold(carolDev)]: carolDev.publicJwk }, drop: [hold(danDev)] });
  const n2 = await gs.chats.change(bob, id, { remove_people: [DAN], ring: rotated });
  assert.equal(n2.ring.epoch, 2);
  assert.equal(gs.chats.epoch(id), 2);
  assert.throws(() => gs.chats.read(dan, id), { code: "not_found" }, "the removed person cannot read the chat or its ring");
});

test("the lease: a participant's device opens the ring and lends the key; the chat's files then open; a rotation drops it; a stranger cannot begin or finish", async () => {
  const { gs, D, bob, carol, dan, bobDev, carolDev, hold, lease, keys } = await rig();
  const id = "chat_lease1";
  const made = createRing(id, { [hold(bobDev)]: bobDev.publicJwk });
  await gs.chats.create(bob, { id, people: [CAROL], ring: addHolders(made.doc, made.keys, { add: { [hold(carolDev)]: carolDev.publicJwk } }) });
  const dir = `Projects/p1/chat/${id}`;
  // locked: nothing opens, and Bob's own write is refused as not unlocked
  await assert.rejects(() => D.put(bob, `${dir}/note.txt`, enc("hello")), e => ["unavailable", "not_found"].includes(e.code));
  // a stranger cannot begin
  assert.throws(() => lease.begin(dan, id), { code: "not_found" });
  // Bob's device: begin, open the ring with its device key, answer with a bundle for the request
  const ask = lease.begin(bob, id);
  const ring = gs.chats.read(bob, id).ring;
  const mine = await openRing(ring, hold(bobDev), bobDev.privateJwk);
  await assert.rejects(() => lease.finish(carol, ask.request, bundleFor(mine, ask.session_pub)), { code: "not_found" }, "another person cannot finish Bob's request");
  assert.deepEqual(await lease.finish(bob, ask.request, bundleFor(mine, ask.session_pub)), { chat: id, epoch: 1 });
  assert.equal(lease.unlocked(id), true);
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  assert.equal(dec(await D.get(carol, `${dir}/note.txt`)), "hello", "the other participant reads through the server while it is unlocked");
  await assert.rejects(() => D.get(dan, `${dir}/note.txt`), { code: "not_found" });
  await assert.rejects(() => lease.finish(bob, ask.request, bundleFor(mine, ask.session_pub)), { code: "not_found" }, "a request is one use");
  // Carol is removed: the ring rotates, the lent key is stale and drops out of use
  const stale = await openRing(ring, hold(bobDev), bobDev.privateJwk);
  const keep = { [hold(bobDev)]: bobDev.publicJwk };
  await gs.chats.change(bob, id, { remove_people: [CAROL], ring: removeHolders(ring, mine, { keep, drop: [hold(carolDev)] }) });
  assert.equal(lease.unlocked(id), false, "a key of the old epoch is not current");
  await assert.rejects(() => D.get(bob, `${dir}/note.txt`), e => ["unavailable", "not_found"].includes(e.code));
  // a bundle of the old epoch is refused; the current one is accepted
  const ask2 = lease.begin(bob, id);
  await assert.rejects(() => lease.finish(bob, ask2.request, bundleFor(stale, ask2.session_pub)), { code: "bad_input" }, "the old epoch");
  const ask3 = lease.begin(bob, id);
  const now = await openRing(gs.chats.read(bob, id).ring, hold(bobDev), bobDev.privateJwk);
  assert.equal((await lease.finish(bob, ask3.request, bundleFor(now, ask3.session_pub))).epoch, 2);
  assert.equal(dec(await D.get(bob, `${dir}/note.txt`)), "hello", "the file sealed under epoch 1 still opens for the participant who stays");
  lease.lock(bob, id);
  assert.equal(lease.unlocked(id), false);
  assert.ok(keys);
});

// ---- end to end on a real Drive and its disk: a chat made with a ring from a device, a participant's device lends the key, the files are ciphertext on the disk and open for the participant
import fs from "node:fs";
import path from "node:path";
import { Pool } from "../storage/pool.js";
import { Drive } from "../storage/drive.js";
import { memoryBackend } from "../storage/backends.js";
import { tmp } from "../seal/testing.js";

test("end to end: a new chat's files are ciphertext on the disk, names included, and a participant's device opens them; a non-participant with the disk gets nothing", async t => {
  const dir = tmp("chat-e2e"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const MB = 1 << 20;
  const pool = new Pool({ dir, key: Buffer.alloc(32, 5), now: () => 1_000_000, chunk: MB });
  pool.addNode({ id: "home", backend: memoryBackend(), home: true, offered: 50 * MB });
  const keys = new ProcessKeys(() => true);
  /** @type {any} */ let gs = null;
  const drive = sealedDrive(new Drive(pool, { now: () => 1_000_000 }), { keysFor: c => { const k = keys.get(c); return k && gs && k.epoch >= gs.chats.epoch(c) ? k : null; }, sealed: c => Boolean(gs && gs.chats.epoch(c) > 0) });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive, chatKeys: keys });
  gs = k.gateway.grants;
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const p of [BOB, CAROL]) { const r = { person: p, role: "member" }; await gs.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const carol = k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  const bobDev = newDeviceKey(), carolDev = newDeviceKey();
  const hold = d => fingerprint(d.publicJwk);
  // Bob's device makes the chat's ring for both participants' devices and the chat is created with it
  const id = "chat_e2e001";
  const made = createRing(id, { [hold(bobDev)]: bobDev.publicJwk, [hold(carolDev)]: carolDev.publicJwk });
  const chat = await gs.chats.create(bob, { id, people: [CAROL], ring: made.doc });
  assert.equal(gs.chats.epoch(chat.id), 1);
  // Bob's device lends the key; he writes files in the chat's folder
  const ask = gs.chats.keys.begin(bob, id);
  await gs.chats.keys.finish(bob, ask.request, bundleFor(await openRing(gs.chats.read(bob, id).ring, hold(bobDev), bobDev.privateJwk), ask.session_pub));
  const dirP = `Projects/p1/chat/${id}`;
  await k.gateway.drive.put(bob, `${dirP}/Harlow settlement offer.txt`, new TextEncoder().encode("Dana Reyes accepts 250,000"));
  // the disk: every byte the pool holds and the drive's index
  const all = []; const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) { all.push(n); walk(p); } else { all.push(n, fs.readFileSync(p, "latin1")); } } }; walk(dir);
  const disk = all.join("\n");
  for (const s of ["Harlow", "settlement", "offer", "Dana Reyes", "250,000"]) assert.ok(!disk.includes(s), `${s} is not on the disk`);
  // Carol's device lends its own request later; she reads what Bob wrote, through the server, while it is unlocked
  assert.equal(new TextDecoder().decode(await k.gateway.drive.get(carol, `${dirP}/Harlow settlement offer.txt`)), "Dana Reyes accepts 250,000");
  // locked: the same disk, the same people, nothing opens
  gs.chats.keys.lock(bob, id);
  await assert.rejects(() => k.gateway.drive.get(carol, `${dirP}/Harlow settlement offer.txt`), { code: "not_found" });
  // and the person outside the chat, with the exact path, gets nothing either way
  const dan = k.chains.fromFacts({ kind: "device", device_key_id: "d-d", person: OWNER, path: "direct" });
  await assert.rejects(() => k.gateway.drive.get(dan, `${dirP}/Harlow settlement offer.txt`), { code: "not_found" });
});
