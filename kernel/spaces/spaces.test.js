import "../../scripts/mac-test-guard.mjs";
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
import { namespaced } from "./namespace.js";
import { createHmac } from "node:crypto";

const rand = n => Array.from({ length: n }, (_, i) => "abcdefghijklmnopqrstuvwxyz234567"[(i * 7 + n) % 32]).join("");
const ME = `per_${rand(26)}`, ALICE = "per_" + "a".repeat(26), BOB = "per_" + "b".repeat(26);
let T = 1_800_000_000_000;
const clock = () => ++T;

/** A presence verifier with the sealing process's contract, one per Space (its sealing namespace). */
const presenceFor = () => { const used = new Set(); return { check: async ({ chain, op, fields, proof, space }) => (chain && proof && proof.payload_hash === payloadHash(op, chain.space, fields) && !used.has(proof.nonce) && (used.add(proof.nonce), true) ? null : "bad_proof") }; };
const sign = (space, call, ...a) => ({ presence: { payload_hash: proofRequest(space, call, ...a).payload_hash, nonce: Math.random().toString(36) } });

async function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spaces-"));
  const db = new DatabaseSync(":memory:");
  const pid = `spc_${"p".repeat(12)}`.replace(/p/g, "c");
  const personal = await bootKernel({ db, space: pid, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence: presenceFor() });
  const spaces = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), clock, fileKey: true, bootOptions: { presence: presenceFor() } });
  return { root, spaces, personal, pid };
}
const ownerChain = async (k, who) => k.chains.fromFacts({ kind: "device", device_key_id: "d1", person: who, path: "direct" });

test("for(): one kernel per Space, each with its own store, log, grants and key; the first is the personal one", async () => {
  const { spaces, personal, pid, root } = await home();
  assert.deepEqual(spaces.list(), [pid]);
  assert.equal(spaces.for(pid).kernel, personal);
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  assert.notEqual(a.space, b.space);
  assert.deepEqual(spaces.list().slice(0, 1), [pid]);
  assert.equal(spaces.list().length, 3);
  for (const h of [a, b]) assert.equal(h.hosted, true);
  // separate logs: a grant in one is not an event in another
  const ca = await ownerChain(a.kernel, ME);
  await a.gateway.grants.setRole(ca, { person: ALICE, role: "member" }, sign(a.space, "setRole", { person: ALICE, role: "member" }));
  assert.equal(await a.gateway.grants.members.list(ca).then(m => m.length), 2);
  assert.equal(await b.gateway.grants.members.list(await ownerChain(b.kernel, ME)).then(m => m.length), 1);
  assert.notEqual(a.kernel.log.head(), b.kernel.log.head());
  // a chain minted in one Space is no chain in another
  await assert.rejects(() => b.gateway.grants.members.list(ca), e => ["bad_input", "not_found", "not_a_member"].includes(e.code));
  assert.throws(() => spaces.for("spc_zzzzzzzzzzzz"), { code: "not_found" });
  assert.throws(() => spaces.for(7), { code: "bad_input" });
  // a restart finds the Space again, with its history (same directory, a fresh registry)
  const again = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), fileKey: true, bootOptions: { presence: presenceFor() } });
  assert.equal(again.hosts(a.space), true);
  assert.equal((await again.open(a.space)).space, a.space);
  assert.equal(await again.open("spc_zzzzzzzzzzzz"), null);
});

test("for(): a Space this home does not host is a remote client with the same gateway; the home mints the chain and verifies the proof", async () => {
  const hostHome = await home();
  const h = await hostHome.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock });
  // the device: its own (empty) registry, and a transport whose peer is the owner's verified device
  const deviceRoot = await home();
  const transport = createMemoryTransport({ servers: { [h.space]: server }, peer: { device_key_id: "dev_owner1", person: ME, path: "wink" } });
  const dev = createSpaceKernels({ root: deviceRoot.root, fileKey: true, personal: deviceRoot.personal && { space: deviceRoot.pid, kernel: deviceRoot.personal }, openDb: () => new DatabaseSync(":memory:"), remote: id => (id === h.space ? createRemoteKernel({ space: id, transport, clock }) : null) });
  const r = dev.for(h.space);
  assert.equal(r.hosted, false);
  const junk = { hops: [{ actor: { kind: "person", id: "per_forged", space: h.space } }] }; // a chain the device made up: carries nothing
  // read as the owner: the chain the home minted decided, not the one passed in
  const members = await r.gateway.grants.members.list(junk);
  assert.deepEqual(members.map(m => m.person), [ME]);
  // a role below owner is the owner's authenticated act with no presence proof (grants.member); making an owner stays a presence act (kernel/remote/proof.test.js)
  const m = { person: ALICE, role: "member" };
  await r.gateway.grants.setRole(junk, m);
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
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
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
  assert.equal((await h.kernel.gateway.grants.invites.get(await ownerChain(h.kernel, ME), first.result.id)).role, "manager");
  const third = await server.serve(w, { device_key_id: "d_other", person: ME, path: "wink" });
  assert.equal(third.ok, false, "another device's repeat is run on its own and its proof is already spent");
});

test("remote: a link that is down is unreachable, and nothing stale passes for fresh", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
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

const peerOf = (device, person) => ({ device_key_id: device, person, path: "wink" });
const call = (space, id, call, args = []) => ({ v: 1, space, id, ts: clock(), call, args });

test("KS-1: one call id sent twice at once runs once and both get the same answer", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
  let runs = 0;
  const grants = { ...h.kernel.gateway.grants, members: { ...h.kernel.gateway.grants.members, list: async () => { runs++; await new Promise(r => setTimeout(r, 30)); return []; } } };
  const server = createRemoteServer({ space: h.space, kernel: { ...h.kernel, gateway: { ...h.kernel.gateway, grants } }, clock });
  const req = call(h.space, "rq_dup", "grants.members.list");
  const [a, b] = await Promise.all([server.serve(req, peerOf("d_o", ME)), server.serve(req, peerOf("d_o", ME))]);
  assert.equal(runs, 1);
  assert.deepEqual(a, b);
});

test("KS-2: remote surfaces.revoke ends the token; only its opener or an admin may; a stranger finds no such session", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock });
  const m = { person: BOB, role: "member" }, m2 = { person: ALICE, role: "member" };
  await h.kernel.gateway.grants.setRole(await ownerChain(h.kernel, ME), m, sign(h.space, "setRole", m));
  await h.kernel.gateway.grants.setRole(await ownerChain(h.kernel, ME), m2, sign(h.space, "setRole", m2));
  const opened = await server.serve(call(h.space, "rq_o", "surfaces.open"), peerOf("d_b", BOB));
  assert.equal(opened.ok, true);
  await h.kernel.surfaces.chainFor(opened.result.token);
  const other = await server.serve(call(h.space, "rq_r1", "surfaces.revoke", [opened.result.session]), peerOf("d_a", ALICE));
  assert.equal(other.error.code, "not_found");
  await h.kernel.surfaces.chainFor(opened.result.token);
  const mine = await server.serve(call(h.space, "rq_r2", "surfaces.revoke", [opened.result.session]), peerOf("d_b", BOB));
  assert.equal(mine.ok, true);
  await assert.rejects(() => h.kernel.surfaces.chainFor(opened.result.token), { code: "not_a_member" });
  // an owner (admin) ends someone else's
  const again = await server.serve(call(h.space, "rq_o2", "surfaces.open"), peerOf("d_b", BOB));
  assert.equal((await server.serve(call(h.space, "rq_r3", "surfaces.revoke", [again.result.session]), peerOf("d_o", ME))).ok, true);
  await assert.rejects(() => h.kernel.surfaces.chainFor(again.result.token), { code: "not_a_member" });
  // an assistant the Space does not have cannot be named
  assert.equal((await server.serve(call(h.space, "rq_o3", "surfaces.open", [{ agent: "ghost" }]), peerOf("d_b", BOB))).error.code, "not_found");
});

test("KS-3: a peer is rate-limited, a non-member far tighter", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
  const server = createRemoteServer({ space: h.space, kernel: h.kernel, clock, rate: { member: 3, invitee: 2 } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await server.serve(call(h.space, `rq_m${i}`, "grants.members.list"), peerOf("d_o", ME))).error?.code ?? "ok");
  assert.deepEqual(codes, ["ok", "ok", "ok", "rate_limited", "rate_limited"]);
  const guess = [];
  for (let i = 0; i < 4; i++) guess.push((await server.serve(call(h.space, `rq_g${i}`, "grants.invites.get", ["inv_" + "0".repeat(32)]), peerOf("d_s", "per_stranger"))).error.code);
  assert.deepEqual(guess, ["not_found", "not_found", "rate_limited", "rate_limited"]);
});

test("KS-4: nothing in a request supplies the session; only the transport's peer does", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
  const facts = [];
  const chains = { ...h.kernel.chains, fromFacts: f => (facts.push(f), h.kernel.chains.fromFacts(f)) };
  const server = createRemoteServer({ space: h.space, kernel: { ...h.kernel, chains }, clock });
  await server.serve({ ...call(h.space, "rq_s1", "grants.members.list"), session: "forged", peer: { session: "forged2" } }, peerOf("d_o", ME));
  await server.serve(call(h.space, "rq_s2", "grants.members.list"), { ...peerOf("d_o", ME), session: "pres_ok" });
  assert.equal(facts[0].session, undefined);
  assert.equal(facts[1].session, "pres_ok");
});

test("KS-5 and KS-7: the space-visible owner event carries only the owner change; invite ids are 128 random bits", async () => {
  const hh = await home();
  const h = await hh.spaces.host({ owner: ME });
  const g = h.kernel.gateway.grants, c = await ownerChain(h.kernel, ME);
  const t = { person: BOB, role: "temp", scope: [`vyre://${h.space}/contact/*`], expires: clock() + 1e6 };
  await g.setRole(c, t, sign(h.space, "setRole", t));
  const o = { person: ALICE, role: "owner" };
  await g.setRole(c, o, sign(h.space, "setRole", o));
  const visible = h.kernel.log.read({}).filter(e => e.vis === "space");
  assert.ok(visible.length >= 2 && visible.every(e => e.type === "owner.changed"));
  assert.ok(visible.every(e => Object.keys(e.data).filter(k => !["mac", "gseq", "gprev"].includes(k)).join() === "owner_change"));
  assert.ok(!JSON.stringify(visible).includes("contact/*"));
  const inv = { role: "member" };
  const card = await g.invites.create(c, inv, sign(h.space, "inviteCreate", inv));
  assert.match(card.id, /^inv_[0-9a-f]{32}$/);
});

test("KS-6: a hosted Space's key lives in the sealing process, namespaced per Space, and no key file is kept", async () => {
  const kernelKey = Buffer.alloc(32, 9);
  const mac = i => createHmac("sha256", kernelKey).update(`${i.purpose}\n${i.data}`).digest("base64url");
  const sealer = { kernel: { mac: async i => mac(i), verify: async i => mac(i) === i.mac }, presenceCheck: presenceFor().check };
  const a = namespaced(sealer, "spc_aaaaaaaaaaaa"), b = namespaced(sealer, "spc_bbbbbbbbbbbb");
  const m = await a.kernel.mac({ purpose: "grants-event-v1", data: "x" });
  assert.equal(await a.kernel.verify({ purpose: "grants-event-v1", data: "x", mac: m }), true);
  assert.equal(await b.kernel.verify({ purpose: "grants-event-v1", data: "x", mac: m }), false, "a MAC from one Space verifies in no other");
  const { root, personal, pid } = await home();
  const sealed = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), sealer, clock });
  const h = await sealed.host({ owner: ME });
  assert.equal(fs.existsSync(path.join(root, "kernel", "spaces", h.space, "kernel.key")), false);
  const bare = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => new DatabaseSync(":memory:"), clock });
  await assert.rejects(() => bare.host({ owner: ME }), { code: "key_custody" });
});

test("retire (PA-1): a Space that was only started is taken back, folder and all, and can be hosted again under the same id; one with another member is refused and stays; the personal Space is never retired", async () => {
  const { spaces, pid, root } = await home();
  const a = await spaces.host({ owner: ME });
  const folder = path.join(root, "kernel", "spaces", a.space);
  assert.ok(fs.existsSync(folder));
  assert.deepEqual(await spaces.retire(a.space), { retired: true });
  assert.ok(!fs.existsSync(folder) && !spaces.list().includes(a.space) && spaces.hosted(a.space) === null);
  assert.deepEqual(await spaces.retire(a.space), { retired: false }, "nothing there is not an error");
  const again = await spaces.host({ owner: ME, id: a.space });
  assert.equal(again.space, a.space, "resume hosts the same id");
  await assert.rejects(() => spaces.host({ owner: ME, id: a.space }), { code: "bad_input" }, "an id in use cannot be hosted twice");
  await assert.rejects(() => spaces.host({ owner: ME, id: "spc_../../etc" }), { code: "bad_input" });
  const ca = await ownerChain(again.kernel, ME);
  await again.gateway.grants.setRole(ca, { person: ALICE, role: "member" }, sign(again.space, "setRole", { person: ALICE, role: "member" }));
  await assert.rejects(() => spaces.retire(again.space), { code: "not_allowed" });
  assert.ok(spaces.list().includes(again.space) && fs.existsSync(path.join(root, "kernel", "spaces", again.space)), "a Space with content stays");
  await assert.rejects(() => spaces.retire(pid), { code: "not_allowed" });
});

test("retire fails closed (RT-1): a message or drive event, a file in the folder, an unreadable database, or old content behind thousands of later boot events all refuse and leave the Space and its folder", async () => {
  const { spaces, root } = await home();
  const folderOf = a => path.join(root, "kernel", "spaces", a.space);
  // a record event the deny list used to miss: any event type that making a Space does not write refuses
  const a = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME);
  await a.kernel.log.append(ca, { type: "message.created", sv: 1, subject: `vyre://${a.space}/message/m1`, data: { text: "hello" }, vis: "owner", red: "internal" });
  await assert.rejects(() => spaces.retire(a.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(folderOf(a)) && spaces.list().includes(a.space), "a Space with a message stays, folder and all");
  // a file the Space's folder should not hold (a drive or pool file)
  const b = await spaces.host({ owner: ME });
  fs.writeFileSync(path.join(folderOf(b), "drive-file.bin"), "x");
  await assert.rejects(() => spaces.retire(b.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(path.join(folderOf(b), "drive-file.bin")));
  // a record behind thousands of later boot-type events: the whole table is read, not a window
  const c = await spaces.host({ owner: ME });
  const cc = await ownerChain(c.kernel, ME);
  await c.kernel.log.append(cc, { type: "record.created", sv: 1, subject: `vyre://${c.space}/contact/c1`, data: { name: "Jane" }, vis: "owner", red: "internal" });
  for (let i = 0; i < 300; i++) await c.kernel.log.append(cc, { type: "kernel.modules-list", sv: 1, subject: `vyre://${c.space}/kernel/m${i}`, data: { n: i }, vis: "owner", red: "internal" });
  await assert.rejects(() => spaces.retire(c.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(folderOf(c)));
  // an empty Space is still taken back, and the unreadable case: a Space whose folder lost its space.json is refused, never deleted
  const e = await spaces.host({ owner: ME });
  fs.rmSync(path.join(folderOf(e), "space.json"));
  await assert.rejects(() => spaces.retire(e.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(folderOf(e)));
  const f = await spaces.host({ owner: ME });
  assert.deepEqual(await spaces.retire(f.space), { retired: true });
});

test("retire (RT-1, more): a database that cannot be read refuses with the folder intact, and a record behind 3,000 later boot-type events still refuses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spaces-"));
  const pid = `spc_${"c".repeat(12)}`;
  const personal = await bootKernel({ db: new DatabaseSync(":memory:"), space: pid, owner: ME, owner_uid: 501, key: Buffer.alloc(32, 1), clock, presence: presenceFor() });
  /** @type {DatabaseSync[]} */ const opened = [];
  const spaces = createSpaceKernels({ root, personal: { space: pid, kernel: personal }, openDb: () => { const db = new DatabaseSync(":memory:"); opened.push(db); return db; }, clock, fileKey: true, bootOptions: { presence: presenceFor() } });
  const folder = h => path.join(root, "kernel", "spaces", h.space);
  const a = await spaces.host({ owner: ME });
  opened[opened.length - 1].close(); // the Space's database can no longer be read
  await assert.rejects(() => spaces.retire(a.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(folder(a)) && spaces.list().includes(a.space), "an unreadable Space is never deleted");
  const b = await spaces.host({ owner: ME });
  const cb = await ownerChain(b.kernel, ME);
  await b.kernel.log.append(cb, { type: "record.created", sv: 1, subject: `vyre://${b.space}/contact/c1`, data: { name: "Jane" }, vis: "owner", red: "internal" });
  for (let i = 0; i < 3000; i++) await b.kernel.log.append(cb, { type: "kernel.modules-list", sv: 1, subject: `vyre://${b.space}/kernel/m${i}`, data: { n: i }, vis: "owner", red: "internal" });
  await assert.rejects(() => spaces.retire(b.space), { code: "not_allowed" });
  assert.ok(fs.existsSync(folder(b)));
  // member.removed and grant.revoked are allowed only because any record they could hide stays in the table, where it is found
});

test("every hosted Space has its own Drive: its own pool folder and pool key, and one Space's files are not there in another and are not readable with the other's key", async () => {
  const { spaces, root } = await home();
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME), cb = await ownerChain(b.kernel, ME);
  assert.ok(a.gateway.drive && b.gateway.drive, "each hosted Space has a Drive at creation");
  const text = Buffer.from("Projects/Harlow: the retainer, in the clear ".repeat(30));
  await a.gateway.drive.put(ca, "Projects/Harlow/retainer.txt", new Uint8Array(text));
  assert.deepEqual(Buffer.from(await a.gateway.drive.get(ca, "Projects/Harlow/retainer.txt")), text, "the file reads back in its own Space");
  // the other Space's Drive does not have it: not by path, not by listing
  await assert.rejects(() => b.gateway.drive.get(cb, "Projects/Harlow/retainer.txt"), e => e.code === "not_found" || e.code === "unavailable");
  const listed = await b.gateway.drive.list(cb, "");
  assert.equal(JSON.stringify(listed).includes("retainer"), false, "and it is not in B's listing");
  // separate pools on disk, each under its own Space's folder, and only ciphertext in them
  const dirOf = id => path.join(root, "kernel", "spaces", id, "drive");
  const files = d => { const out = []; const walk = x => { for (const n of fs.existsSync(x) ? fs.readdirSync(x) : []) { const p = path.join(x, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(p); } }; walk(d); return out; };
  const inA = files(path.join(dirOf(a.space), "node")), inB = files(path.join(dirOf(b.space), "node"));
  assert.ok(inA.length > 0 && inB.length === 0, "the chunks are in A's pool folder only");
  for (const f of inA) assert.ok(!fs.readFileSync(f).includes(Buffer.from("retainer, in the clear")), "chunks are ciphertext");
  // the two pools' keys differ: A's chunk is not openable by B's pool
  const { Pool } = await import("../storage/pool.js");
  const idxA = JSON.parse(fs.readFileSync(path.join(dirOf(a.space), "index.json"), "utf8"));
  const cid = Object.keys(idxA.chunks)[0];
  const blob = fs.readFileSync(path.join(dirOf(a.space), "node", "c", cid));
  const keyB = Buffer.from((await import("node:crypto")).hkdfSync("sha256", fs.readFileSync(path.join(root, "kernel", "spaces", b.space, "kernel.key"), "utf8").trim().length ? Buffer.from(fs.readFileSync(path.join(root, "kernel", "spaces", b.space, "kernel.key"), "utf8").trim(), "hex") : Buffer.alloc(32), b.space, "vyre pool key v1", 32));
  const poolB = new Pool({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "vyre-poolb-")), key: keyB });
  assert.equal(poolB.open(cid, blob), null, "B's key does not open A's chunk");
});

test("a new Space has the person's default assistant as an actor from its start, the personal Space and a hosted one alike, so a task there can go to it", async () => {
  const { spaces, personal, pid } = await home();
  const a = await spaces.host({ owner: ME });
  for (const h of [spaces.for(pid), a]) assert.equal(h.kernel.grants.hasDefaultAssistant(), true, `${h.space}`);
  void personal;
});

test("moving a project between two Spaces of one home: approved once where it starts, received under the role in the other, single use, same person, this target and plan only", async () => {
  const { spaces } = await home();
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME), cb = await ownerChain(b.kernel, ME);
  const pid = "0190c3f2-1111-4abc-8def-000000000001";
  const project = `vyre://${a.space}/project/${pid}`;
  const plan_hash = "p".repeat(43);
  const req = { project, to: b.space, plan_hash };
  // no proof: the source asks for the person's approval
  await assert.rejects(() => a.gateway.moves.out(ca, req), { code: "needs_presence" });
  // a proof for another plan is no proof for this one
  await assert.rejects(() => a.gateway.moves.out(ca, req, sign(a.space, "moveOut", { ...req, plan_hash: "q".repeat(43) })), { code: /needs_presence|bad_proof|wrong/ });
  const out = await a.gateway.moves.out(ca, req, sign(a.space, "moveOut", req));
  assert.match(out.move_id, /^[0-9a-f-]{36}$/);
  assert.equal(a.kernel.log.read({ type: "project.move_started" }).length, 1);
  const receive = { from: a.space, project, plan_hash, move_id: out.move_id };
  // another plan, another project, another person, another target: none of these is that move
  await assert.rejects(() => b.gateway.moves.in(cb, { ...receive, plan_hash: "q".repeat(43) }), { code: "not_found" });
  await assert.rejects(() => b.gateway.moves.in(cb, { ...receive, project: `vyre://${a.space}/project/0190c3f2-1111-4abc-8def-000000000002` }), { code: "not_found" });
  await assert.rejects(() => b.gateway.moves.in(cb, { ...receive, move_id: "0190c3f2-1111-4abc-8def-0000000000ff" }), { code: "not_found" });
  const bobCb = b.kernel.chains.fromFacts({ kind: "device", device_key_id: "d9", person: ME, path: "direct" });
  void bobCb;
  const got = await b.gateway.moves.in(cb, receive);
  assert.deepEqual(got, { received: true, move_id: out.move_id });
  assert.equal(b.kernel.log.read({ type: "project.move_in" }).length, 1);
  // single use
  await assert.rejects(() => b.gateway.moves.in(cb, receive), { code: "invalid" });
  // the source cannot be named as the target, and a move to oneself is refused
  await assert.rejects(() => a.gateway.moves.out(ca, { ...req, to: a.space }, sign(a.space, "moveOut", { ...req, to: a.space })), { code: "bad_input" });
  await assert.rejects(() => b.gateway.moves.in(cb, { ...receive, from: b.space }), { code: "bad_input" });
});

test("moving several projects at once: one approval covers the target, the plan and the exact list; each project is then received on its own, single use", async () => {
  const { spaces } = await home();
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME), cb = await ownerChain(b.kernel, ME);
  const ids = ["0190c3f2-1111-4abc-8def-000000000011", "0190c3f2-1111-4abc-8def-000000000012", "0190c3f2-1111-4abc-8def-000000000013"];
  const projects = ids.map(x => `vyre://${a.space}/project/${x}`);
  const plan_hash = "p".repeat(43);
  const req = { projects, to: b.space, plan_hash };
  await assert.rejects(() => a.gateway.moves.outMany(ca, req), { code: "needs_presence" });
  // a proof for fewer projects, another plan or another target is no proof for this batch
  await assert.rejects(() => a.gateway.moves.outMany(ca, req, sign(a.space, "moveOutMany", { ...req, projects: projects.slice(0, 2) })), { code: /needs_presence|bad_proof|wrong/ });
  await assert.rejects(() => a.gateway.moves.outMany(ca, req, sign(a.space, "moveOutMany", { ...req, plan_hash: "q".repeat(43) })), { code: /needs_presence|bad_proof|wrong/ });
  assert.equal(a.kernel.log.read({ type: "project.move_started" }).length, 0, "nothing was started by a refused call");
  // every project is checked before the proof is spent; a duplicate or a foreign one is refused
  await assert.rejects(() => a.gateway.moves.outMany(ca, { ...req, projects: [projects[0], projects[0]] }), { code: "bad_input" });
  await assert.rejects(() => a.gateway.moves.outMany(ca, { ...req, projects: [`vyre://${b.space}/project/${ids[0]}`] }), { code: "bad_input" });
  const proof = sign(a.space, "moveOutMany", req);
  const out = await a.gateway.moves.outMany(ca, req, proof);
  assert.equal(out.moves.length, 3);
  assert.equal(a.kernel.log.read({ type: "project.move_started" }).length, 3, "one event per project");
  // the same proof cannot start the batch again
  await assert.rejects(() => a.gateway.moves.outMany(ca, req, proof), { code: /needs_presence|bad_proof|replay|used|wrong/ });
  for (const m of out.moves) {
    const got = await b.gateway.moves.in(cb, { from: a.space, project: m.project, plan_hash, move_id: m.move_id });
    assert.deepEqual(got, { received: true, move_id: m.move_id });
  }
  assert.equal(b.kernel.log.read({ type: "project.move_in" }).length, 3);
  await assert.rejects(() => b.gateway.moves.in(cb, { from: a.space, project: out.moves[0].project, plan_hash, move_id: out.moves[0].move_id }), { code: "invalid" });
});

test("a move to a Space on another home: signed evidence from the source, checked against the source's published key; a receipt back; the source clears only after it", async () => {
  const { generateKeyPairSync, sign: edSign, verify: edVerify } = await import("node:crypto");
  const { canonical } = await import("../core/canonical.js");
  const { spaces } = await home();
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME), cb = await ownerChain(b.kernel, ME);
  // each Space has its own published key: the "directory" below is what the target and the source trust, never a key the courier hands over
  const keys = { [a.space]: generateKeyPairSync("ed25519"), [b.space]: generateKeyPairSync("ed25519") };
  const published = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.publicKey]));
  const signAs = (space, tag, obj) => ({ pub: space, sig: edSign(null, Buffer.from(`${tag}\n${canonical(obj)}`), keys[space].privateKey).toString("base64url") });
  const check = (tag, obj, bundle, expectSpace) => bundle && published[expectSpace] && bundle.pub === expectSpace && edVerify(null, Buffer.from(`${tag}\n${canonical(obj)}`), published[expectSpace], Buffer.from(bundle.sig, "base64url"));
  const hooks = {
    remoteEvidence: async (bundle, c) => (bundle && bundle.evidence && bundle.evidence.from === c.from && bundle.evidence.to === c.to && check("vyre-move-evidence-v1", bundle.evidence, bundle, c.from) ? bundle.evidence : null),
    verifyReceipt: async (receipt, c) => (receipt && receipt.body && receipt.body.from === c.from && receipt.body.to === c.to && check("vyre-move-receipt-v1", receipt.body, receipt, c.to) ? receipt.body : null),
  };
  spaces.setMoveHooks(hooks);
  const project = `vyre://${a.space}/project/0190c3f2-1111-4abc-8def-0000000000a1`;
  const plan_hash = "p".repeat(43);
  const req = { project, to: b.space, plan_hash };
  const out = await a.gateway.moves.out(ca, req, sign(a.space, "moveOut", req));
  // the evidence is the source's own log's, for the person who started it, with the fixed fields
  const evidence = a.gateway.moves.evidenceOf(ca, { move_id: out.move_id });
  assert.deepEqual(Object.keys(evidence), ["v", "from", "to", "project", "plan_hash", "move_id", "person", "at"]);
  assert.deepEqual([evidence.v, evidence.from, evidence.to, evidence.project, evidence.person], [1, a.space, b.space, project, ME]);
  assert.throws(() => a.gateway.moves.evidenceOf(ca, { move_id: "0190c3f2-1111-4abc-8def-0000000000ff" }), { code: "not_found" }, "a move that was not started here has no evidence");
  const bundle = { evidence, ...signAs(a.space, "vyre-move-evidence-v1", evidence) };
  const recv = { from: a.space, project, plan_hash, move_id: out.move_id, bundle };
  // tampered evidence, another target, another person, a signature from the wrong Space: none of them is that move
  await assert.rejects(() => b.gateway.moves.in(cb, { ...recv, bundle: { ...bundle, evidence: { ...evidence, plan_hash: "q".repeat(43) } } }), { code: "not_found" });
  await assert.rejects(() => b.gateway.moves.in(cb, { ...recv, bundle: { ...signAs(b.space, "vyre-move-evidence-v1", evidence), evidence } }), { code: "not_found" });
  await assert.rejects(() => b.gateway.moves.in(cb, { ...recv, bundle: { ...bundle, evidence: { ...evidence, extra: 1 } } }), { code: "not_found" }, "unknown fields are refused");
  await assert.rejects(() => b.gateway.moves.in(cb, { ...recv, plan_hash: "q".repeat(43) }), { code: "not_found" });
  const got = await b.gateway.moves.in(cb, recv);
  assert.deepEqual(got, { received: true, move_id: out.move_id });
  await assert.rejects(() => b.gateway.moves.in(cb, recv), { code: "invalid" }, "single use");
  // the target finishes after the copy: counts and the root of the per-file hashes, and a receipt body to sign
  await assert.rejects(() => b.gateway.moves.finishTarget(cb, { move_id: "0190c3f2-1111-4abc-8def-0000000000fe", counts: {}, files_root: "a".repeat(64) }), { code: "not_found" });
  const body = await b.gateway.moves.finishTarget(cb, { move_id: out.move_id, counts: { records: { contact: 2 }, files: 3 }, files_root: "a".repeat(64) });
  assert.deepEqual([body.v, body.move_id, body.from, body.to], [1, out.move_id, a.space, b.space]);
  assert.deepEqual(await b.gateway.moves.finishTarget(cb, { move_id: out.move_id, counts: {}, files_root: "b".repeat(64) }), body, "a second finish answers the same receipt");
  assert.equal(b.kernel.log.read({ type: "project.move_done" }).length, 1);
  // the source clears nothing until a receipt signed by the TARGET's key arrives
  const receipt = { body, ...signAs(b.space, "vyre-move-receipt-v1", body) };
  await assert.rejects(() => a.gateway.moves.finishSource(ca, { move_id: out.move_id, receipt: { body, ...signAs(a.space, "vyre-move-receipt-v1", body) } }), { code: "not_found" }, "a receipt signed by the source itself proves nothing");
  await assert.rejects(() => a.gateway.moves.finishSource(ca, { move_id: out.move_id, receipt: { ...receipt, body: { ...body, counts: { files: 0 } } } }), { code: "not_found" }, "a changed receipt is refused");
  assert.equal(a.kernel.log.read({ type: "project.moved" }).length, 0, "nothing was marked moved by a refused receipt");
  const fin = await a.gateway.moves.finishSource(ca, { move_id: out.move_id, receipt });
  assert.deepEqual([fin.moved, fin.to, fin.files_root], [true, b.space, "a".repeat(64)]);
  assert.equal(a.kernel.log.read({ type: "project.moved" }).length, 1);
  await a.gateway.moves.finishSource(ca, { move_id: out.move_id, receipt });
  assert.equal(a.kernel.log.read({ type: "project.moved" }).length, 1, "finishing twice marks it once");
});

test("a module tool's cross-space action: the hosted Space's own authorize allows a member's chain and refuses a stranger and another Space's chain", async () => {
  const { spaces } = await home();
  const a = await spaces.host({ owner: ME }), b = await spaces.host({ owner: ME });
  const ca = await ownerChain(a.kernel, ME);
  await a.gateway.grants.setRole(ca, { person: ALICE, role: "member" }, sign(a.space, "setRole", { person: ALICE, role: "member" }));
  const res = `vyre://${a.space}/tool/notes.there`;
  const mine = await a.gateway.authorize({ chain: ca, action: "records.read", resource: res });
  assert.equal(mine.effect, "allow", "the owner may");
  const alice = await ownerChain(a.kernel, ALICE);
  assert.equal((await a.gateway.authorize({ chain: alice, action: "records.read", resource: res })).effect, "allow", "a member may read");
  const stranger = await ownerChain(a.kernel, BOB);
  assert.notEqual((await a.gateway.authorize({ chain: stranger, action: "records.read", resource: res })).effect, "allow", "a stranger may not");
  const other = await ownerChain(b.kernel, ME);
  assert.notEqual((await a.gateway.authorize({ chain: other, action: "records.read", resource: res })).effect, "allow", "a chain from another Space may not");
});
