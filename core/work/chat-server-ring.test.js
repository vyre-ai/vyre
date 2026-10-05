// @ts-check
// A chat started on the server (CLI, a Flow) with a person in it is never in the clear on disk: with no ring from a device, work.chat.create makes it, wrapped to each participant device's public agree point
// (spaces.identity.devices), and keeps the key only as the session lease. A participant with no agree point stops the start, by name.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import mod from "./index.js";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { sealedDrive } from "../../kernel/storage/sealed-drive.js";
import { Pool } from "../../kernel/storage/pool.js";
import { Drive } from "../../kernel/storage/drive.js";
import { memoryBackend } from "../../kernel/storage/backends.js";
import { tmp } from "../../kernel/seal/testing.js";
import { ProcessKeys, openRing, bundleFor } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";
import { toB64u, fromB64u } from "../../lib/databox.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
/** The raw 65-byte agree point a device lists (04 || x || y), base64url. */
const agreeOf = d => toB64u(Uint8Array.from([4, ...fromB64u(d.publicJwk.x), ...fromB64u(d.publicJwk.y)]));

async function rig(t, agree) {
  const dir = tmp("chat-srv"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
  const tools = {};
  const kernel = { space: SPACE, chainFor: () => bob, chats: gs.chats, records: new Proxy({ query: async () => ({ rows: [] }) }, { get: (o, k) => (k in o ? o[k] : async () => ({ id: "rec_x", urn: `vyre://${SPACE}/x/rec_x`, data: {} })) }), events: { read: async () => [] }, serviceChain: () => bob };
  await mod.start({ tool: (name, def) => { tools[name] = def; }, store: {}, kernel, call: async (tool, input) => { if (tool !== "spaces.identity.devices") throw new Error(`unexpected ${tool}`); return { data: { devices: agree[input.person] || [] } }; } });
  return { k, gs, bob, dir, tools, kernel };
}
const disk = dir => { const all = []; const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) { all.push(n); walk(p); } else all.push(n, fs.readFileSync(p, "latin1")); } }; walk(dir); return all.join("\n"); };

test("a chat started on the server with a person in it: ring made from the agree points, key kept only as the lease, disk holds no plaintext", async t => {
  const bobDev = newDeviceKey(), carolDev = newDeviceKey();
  const { gs, bob, dir, tools, k } = await rig(t, { [BOB]: [{ device: "dev_b", agree: agreeOf(bobDev) }], [CAROL]: [{ device: "dev_c", agree: agreeOf(carolDev) }] });
  const made = await tools["work.chat.create"].run({ title: "Server started", people: [CAROL] }, { caller: "cli" }).catch(e => { throw e; });
  const id = made.chat;
  assert.equal(gs.chats.epoch(id), 1, "the chat has a key ring");
  // the ring opens for both participants' devices with their own private keys
  const ring = gs.chats.read(bob, id).ring;
  assert.ok((await openRing(ring, fingerprint(bobDev.publicJwk), bobDev.privateJwk)).epoch === 1);
  assert.ok((await openRing(ring, fingerprint(carolDev.publicJwk), carolDev.privateJwk)).epoch === 1);
  // the server holds the key as the lease: it writes, and the disk has no plaintext, names included
  await k.gateway.drive.put(bob, `Projects/p1/chat/${id}/Harlow settlement offer.txt`, new TextEncoder().encode("Dana Reyes accepts 250,000"));
  const d = disk(dir);
  for (const s of ["Harlow", "settlement", "offer", "Dana Reyes", "250,000"]) assert.ok(!d.includes(s), `${s} is not on the disk`);
  // a lock drops the key: nothing opens until a device lends it again
  gs.chats.keys.lock(bob, id);
  await assert.rejects(() => k.gateway.drive.get(bob, `Projects/p1/chat/${id}/Harlow settlement offer.txt`), { code: "not_found" });
  const ask = gs.chats.keys.begin(bob, id);
  await gs.chats.keys.finish(bob, ask.request, bundleFor(await openRing(ring, fingerprint(bobDev.publicJwk), bobDev.privateJwk), ask.session_pub));
  assert.equal(new TextDecoder().decode(await k.gateway.drive.get(bob, `Projects/p1/chat/${id}/Harlow settlement offer.txt`)), "Dana Reyes accepts 250,000");
});

test("a participant with no agree point stops the start, by name, and no chat is made", async t => {
  const bobDev = newDeviceKey();
  const { tools } = await rig(t, { [BOB]: [{ device: "dev_b", agree: agreeOf(bobDev) }], [CAROL]: [] });
  await assert.rejects(() => tools["work.chat.create"].run({ people: [CAROL] }, { caller: "cli" }), e => e.code === "no_agree_point" && e.message.includes(CAROL) && !e.message.includes(BOB));
});
