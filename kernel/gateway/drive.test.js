import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

/** A drive with the same shape as vault's Drive over an in-memory map: versions, a conflict flag, history. */
function fakeDrive() {
  const files = new Map(), calls = [];
  return { calls, files,
    async put(p, bytes, { by, base }) { const f = files.get(p) || []; const conflict = base !== null && base !== f.length; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); calls.push(["put", p, by]); return { version: f.length, conflict }; },
    async get(p, { version }) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
    list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)).map(path => ({ path })); },
    history(p) { return (files.get(p) || []).map(v => ({ ver: v.ver, by: v.by })); },
    async delete(p) { files.delete(p); calls.push(["delete", p]); return { deleted: true }; },
    async restore(p, version, { by }) { const f = files.get(p); f.push({ ver: f.length + 1, bytes: f[version - 1].bytes, by }); return { version: f.length }; },
    async prune() { return { pruned: 0 }; }, async backup(n, b) { return { id: "b1" }; }, backups() { return []; }, async restoreBackup() { return {}; }, async pruneBackups() { return {}; },
  };
}

test("drive: every call asks authorize first, the version's author is the chain's actor, listings show only what is readable, and nothing but the path is logged", async () => {
  const drive = fakeDrive();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const g = k.gateway.grants, D = k.gateway.drive;
  const role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  // a member's role has no drive actions: the file is not there for them, and the drive is never touched
  await assert.rejects(() => D.put(bob, "proj/a.txt", new Uint8Array([1])), { code: "not_found" });
  await assert.rejects(() => D.get(bob, "proj/a.txt"), { code: "not_found" });
  assert.deepEqual(drive.calls, [], "refused before the drive was touched");
  // the owner (the admin bundle) reads and writes the space's whole Drive with no grant of their own; what they wrote is gone again so the rest of this test starts clean
  assert.equal((await D.put(owner, "owner/own.txt", new TextEncoder().encode("mine"))).version, 1);
  assert.equal(new TextDecoder().decode(await D.get(owner, "owner/own.txt")), "mine");
  assert.deepEqual(drive.calls.at(-1), ["put", "owner/own.txt", `person:${OWNER}`]);
  drive.files.delete("owner/own.txt"); drive.calls.length = 0;
  // grant Bob read on one folder only
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["drive.read", "drive.write"], resource: { prefix: `vyre://${SPACE}/file/proj/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const r = await D.put(bob, "proj/a.txt", new TextEncoder().encode("hello"));
  assert.equal(r.version, 1);
  assert.deepEqual(drive.calls.at(-1), ["put", "proj/a.txt", `person:${BOB}`], "by is the chain's actor, not a caller's word");
  assert.equal(new TextDecoder().decode(await D.get(bob, "proj/a.txt")), "hello");
  drive.files.set("other/b.txt", [{ ver: 1, bytes: new Uint8Array([2]), by: "x" }]);
  assert.deepEqual((await D.list(bob, "proj/")).map(e => e.path), ["proj/a.txt"]);
  await assert.rejects(() => D.get(bob, "other/b.txt"), { code: "not_found" }, "outside the grant is absence");
  // paths: no dot segments, encodings or absolute paths ever become a resource
  for (const bad of ["../x", "proj/../other/b.txt", "proj/%2e%2e/x", "/etc/passwd", "proj\\x", "proj//x"]) await assert.rejects(() => D.get(bob, bad), { code: "bad_input" }, bad);
  // delete asks (an outward act); two writers give a conflict, not a merge
  await assert.rejects(() => D.delete(bob, "proj/a.txt"), { code: "not_found" }, "no drive.delete at all");
  const c = await D.put(bob, "proj/a.txt", new Uint8Array([9]), { base: 0 });
  assert.equal(c.conflict, true);
  // the log names the path and the version and carries no bytes
  const ev = k.log.read({ type: "file.written" });
  assert.ok(ev.length >= 2 && ev.every(e => !JSON.stringify(e.data).includes("hello")));
  assert.ok(k.log.read({ type: "file.accessed" }).some(e => e.data.path === "proj/a.txt"), "the read of proj/a.txt is logged by path");
});

test("F-2: restore and restoreBackup are their own admin act: a drive.write grant (a member's or an assistant's) does not reach them, and a version must be a positive integer", async () => {
  const drive = fakeDrive();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const g = k.gateway.grants, D = k.gateway.drive;
  const role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["drive.read", "drive.write"], resource: { prefix: `vyre://${SPACE}/file/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  await D.put(bob, "proj/a.txt", new Uint8Array([1]));
  await D.put(bob, "proj/a.txt", new Uint8Array([2]));
  const before = drive.calls.length;
  await assert.rejects(() => D.restore(bob, "proj/a.txt", 1), { code: "not_found" }, "write is not restore");
  await assert.rejects(() => D.restoreBackup(bob, "nightly"), { code: "not_found" });
  assert.equal(drive.calls.length, before, "the drive was never touched");
  // the owner needs to be present: a chain with no session asks, one with a live session restores
  const away = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct" });
  await assert.rejects(() => D.restore(away, "proj/a.txt", 1), e => e.code === "needs_presence");
  assert.equal(drive.calls.length, before);
  assert.deepEqual(await D.restore(owner, "proj/a.txt", 1), { version: 3 });
  for (const bad of [0, -1, 1.5, "1", NaN]) await assert.rejects(() => D.restore(owner, "proj/a.txt", bad), { code: "bad_input" }, String(bad));
  await assert.rejects(() => D.get(bob, "proj/a.txt", { version: 1.5 }), { code: "bad_input" });
  await assert.rejects(() => D.put(bob, "proj/a.txt", "text"), { code: "bad_input" });
});

test("DR-1: a read with maxBytes is refused from the Drive's metadata before any byte is read, 10 in parallel the same", async () => {
  const drive = fakeDrive(); let reads = 0;
  drive.stat = (/** @type {string} */ p) => ({ version: 1, size: p.startsWith("big/") ? 100 * 1048576 : 5, sha256: null });
  const get = drive.get; drive.get = async (/** @type {any[]} */ ...a) => { reads++; return get.apply(drive, /** @type {any} */ (a)); };
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  drive.files.set("big/a.bin", [{ ver: 1, bytes: new Uint8Array(1), by: "x" }]); drive.files.set("small.txt", [{ ver: 1, bytes: new Uint8Array(5), by: "x" }]);
  const D = k.gateway.drive;
  const codes = await Promise.all(Array.from({ length: 10 }, () => D.get(owner, "big/a.bin", { maxBytes: 8 * 1048576 }).then(() => "read", (/** @type {any} */ e) => e.code)));
  assert.deepEqual(codes, Array(10).fill("too_large"));
  assert.equal(reads, 0, "no byte of the large file was read");
  assert.equal((await D.get(owner, "small.txt", { maxBytes: 8 * 1048576 })).length, 5);
  assert.equal(reads, 1);
});

test("DR-2: a listing is one authorization of the folder and a bounded page with a cursor; 5,000 files page through without losing or repeating one", async () => {
  const drive = fakeDrive();
  for (let n = 0; n < 5000; n++) drive.files.set(`many/f${String(n).padStart(5, "0")}.txt`, [{ ver: 1, bytes: new Uint8Array(1), by: "x" }]);
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const D = k.gateway.drive;
  const first = await D.listPage(owner, "many/");
  assert.equal(first.entries.length, 500, "the default page");
  assert.equal(first.next, first.entries[499].path);
  assert.equal((await D.listPage(owner, "many/", { limit: 100000 })).entries.length, 1000, "a page is never more than 1,000");
  const seen = []; let after = null;
  for (let guard = 0; guard < 20; guard++) { const r = await D.listPage(owner, "many/", { limit: 1000, after }); seen.push(...r.entries.map((/** @type {any} */ e) => e.path)); if (!r.next) break; after = r.next; }
  assert.equal(seen.length, 5000);
  assert.equal(new Set(seen).size, 5000);
  assert.equal((await D.list(owner, "many/")).length, 5000, "list still returns everything, a page at a time inside");
});
