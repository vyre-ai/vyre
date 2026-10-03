import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bootKernel } from "../boot.js";
import { createSpaceKernels } from "./index.js";
import { createRemoteServer } from "../remote/server.js";
import { createRemoteKernel } from "../remote/client.js";
import { createMemoryTransport } from "../remote/memory-transport.js";
import { payloadHash } from "../seal/wire.js";
import { proofRequest } from "../remote/proof.js";

const rand = n => Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyz234567"[(i * 7 + n) % 32]).join("");
const ME = `per_${rand(26)}`, ALICE = "per_" + "a".repeat(26), BOB = "per_" + "b".repeat(26);
let T = 1_800_000_000_000;
const clock = () => ++T;

/** A presence verifier with the sealing process's contract, one per Space (its sealing namespace). */
const presenceFor = () => { const used = new Set(); return { check: async ({ chain, op, fields, proof, space }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") }; };
const sign = (space, call, ...a) => ({ presence: { payload_hash: proofRequest(space, call, ...a).payload_hash, nonce: Math.random().toString(36) } });

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spaces-"));
  const db = new DatabaseSync(":memory:");
  const pid = `spc_${"p".repeat(12)}`.replace(/p/g, "c");
  const personal = bootKernel({ db, space: pid, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence: presenceFor() });
  const spaces = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), clock, bootOptions: { presence: presenceFor() } });
  return { root, spaces, personal, pid };
}
const ownerChain = (k, who) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: who, path: "direct" });

test("for(): one kernel per Space, each with its own store, log, grants and key; the first is the personal one", async () => {
  const { spaces, personal, pid, root } = home();
  assert.deepEqual(spaces.list(), [pid]);
  assert.equal(spaces.for(pid).kernel, personal);
  const a = spaces.host({ owner: ME }), b = spaces.host({ owner: ME });
  assert.notEqual(a.space, b.space);
  assert.deepEqual(spaces.list().slice(0, 1), [pid]);
  assert.equal(spaces.list().length, 3);
  for (const h of [a, b]) assert.equal(h.hosted, true);
  // separate logs: a grant in one is not an event in another
  const ca = ownerChain(a.kernel, ME);
  await a.gateway.grants.setRole(ca, { person: ALICE, role: "member" }, sign(a.space, "setRole", { person: ALICE, role: "member" }));
  assert.equal(await a.gateway.grants.members.list(ca).then(m => m.length), 2);
  assert.equal(await b.gateway.grants.members.list(ownerChain(b.kernel, ME)).then(m => m.length), 1);
  assert.notEqual(a.kernel.log.head(), b.kernel.log.head());
  // a chain minted in one Space is no chain in another
  await assert.rejects(() => b.gateway.grants.members.list(ca), e => ["bad_input", "not_found", "not_a_member"].includes(e.code));
  assert.throws(() => spaces.for("spc_zzzzzzzzzzzz"), { code: "not_found" });
  assert.throws(() => spaces.for(7), { code: "bad_input" });
  // a restart finds the Space again, with its history (same directory, a fresh registry)
  const again = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), bootOptions: { presence: presenceFor() } });
  assert.equal(again.hosts(a.space), true);
  assert.equal(again.hosted(a.space).space, a.space);
  assert.equal(again.hosted("spc_zzzzzzzzzzzz"), null);
});

test("for(): a Space this home does not host is a remote client with the same gateway; the home mints the chain and verifies the proof", async () => {
  const hostHome = home();
  const h = hostHome.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock });
  // the device: its own (empty) registry, and a transport whose peer is the owner's verified device
  const deviceRoot = home();
  const transport = createMemoryTransport({ servers: { [h.space]: server }, peer: { device_key_id: "dev_owner1", person: ME, path: "wink" } });
  const dev = createSpaceKernels({ root: deviceRoot.root, personal: deviceRoot.personal && { space: deviceRoot.pid, kernel: deviceRoot.personal }, openDb: () => new DatabaseSync(":memory:"), remote: id => (id === h.space ? createRemoteKernel({ space: id, transport, clock }) : null) });
  const r = dev.for(h.space);
  assert.equal(r.hosted, false);
  const junk = { hops: [{ actor: { kind: "person", id: "per_forged", space: h.space } }] }; // a chain the device made up: carries nothing
  // read as the owner: the chain the home minted decided, not the one passed in
  const members = await r.gateway.grants.members.list(junk);
  assert.deepEqual(members.map(m => m.person), [ME]);
  // a grants act with the device's presence proof, verified at the home
  const m = { person: ALICE, role: "member" };
  await assert.rejects(() => r.gateway.grants.setRole(junk, m), { code: "needs_presence" });
  await r.gateway.grants.setRole(junk, m, sign(h.space, "setRole", m));
  assert.equal((await r.gateway.grants.members.get(junk, ALICE)).role, "member");
  // the owner-op event is there for the spaces module
  assert.ok(h.kernel.log.read({}).some(e => e.type === "member.set" && e.data.owner_change === undefined && e.data.membership.person === ALICE));
  // errors cross as code and message only
  await assert.rejects(() => r.gateway.grants.members.get(junk, "per_nobody"), { code: "not_found" });
  // the marked cache is for screens only
  const c = r.cached("grants.members.list");
  assert.equal(c.untrusted, true); assert.equal(c.source, "remote"); assert.equal(c.fresh, false); assert.equal(c.value.length, 1);
  assert.equal(r.cached("grants.create"), null, "writes are never cached");
});

test("remote: a person who is not a member reaches only the join card and the accept; an unknown device and replays do nothing", async () => {
  const hh = home();
  const h = hh.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock });
  const mk = peer => createRemoteKernel({ space: h.space, transport: createMemoryTransport({ servers: { [h.space]: server }, peer }), clock });
  const owner = mk({ device_key_id: "d_o", person: ME, path: "wink" });
  const inv = { role: "member" };
  const card = await owner.gateway.grants.invites.create({}, inv, sign(h.space, "inviteCreate", inv));
  const bob = mk({ device_key_id: "d_b", person: BOB, path: "wink" });
  const shown = await bob.gateway.grants.invites.get({}, card.id);
  assert.equal(shown.role, "member"); assert.equal(shown.hash, undefined);
  await assert.rejects(() => bob.gateway.grants.members.list({}), { code: "not_a_member" });
  await assert.rejects(() => bob.gateway.records.query({}, "contact", {}), { code: "not_a_member" });
  await assert.rejects(() => mk({ device_key_id: "d_x", person: "", path: "wink" }).gateway.grants.invites.get({}, card.id), { code: "not_a_member" });
  // a call the table does not list, and a path walk, are refused
  const raw = { v: 1, space: h.space, id: "rq_1", ts: clock(), call: "grants.__proto__.constructor", args: [] };
  assert.equal((await server.serve(raw, { device_key_id: "d_o", person: ME })).error.code, "no_such_call");
  assert.equal((await server.serve({ ...raw, id: "rq_2", call: "grants.bootstrap" }, { device_key_id: "d_o", person: ME })).error.code, "no_such_call");
  // stale and wrong-space requests
  assert.equal((await server.serve({ ...raw, id: "rq_3", call: "grants.list", ts: 1 }, { device_key_id: "d_o", person: ME })).error.code, "stale");
  assert.equal((await server.serve({ ...raw, id: "rq_4", call: "grants.list", space: "spc_zzzzzzzzzzzz" }, { device_key_id: "d_o", person: ME })).error.code, "not_found");
  // a repeat from the same device is answered, not re-run; the proof inside a replayed write is not spent twice
  const p = sign(h.space, "inviteCreate", { role: "manager" });
  const w = { v: 1, space: h.space, id: "rq_5", ts: clock(), call: "grants.invites.create", args: [{ role: "manager" }, p] };
  const first = await server.serve(w, { device_key_id: "d_o", person: ME, path: "wink" });
  const second = await server.serve(w, { device_key_id: "d_o", person: ME, path: "wink" });
  assert.equal(first.ok, true); assert.deepEqual(second, first);
  assert.equal((await h.kernel.gateway.grants.invites.get(ownerChain(h.kernel, ME), first.result.id)).role, "manager");
  const third = await server.serve(w, { device_key_id: "d_other", person: ME, path: "wink" });
  assert.equal(third.ok, false, "another device's repeat is run on its own and its proof is already spent");
});

test("remote: a link that is down is unreachable, and nothing stale passes for fresh", async () => {
  const hh = home();
  const h = hh.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock });
  const t = createMemoryTransport({ servers: { [h.space]: server }, peer: { device_key_id: "d_o", person: ME } });
  const r = createRemoteKernel({ space: h.space, transport: t, clock });
  await r.gateway.grants.members.list({});
  const down = createRemoteKernel({ space: h.space, transport: createMemoryTransport({ servers: {}, peer: {}, drop: true }), clock });
  await assert.rejects(() => down.gateway.grants.members.list({}), { code: "unreachable" });
  assert.equal(down.cached("grants.members.list"), null);
  assert.equal(r.cached("grants.members.list").fresh, false);
  await assert.rejects(() => r.gateway.records.get({}, "contact", () => 1), { code: "bad_input" }, "a call takes plain data");
});
