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
  const k = createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const g = k.gateway.grants, D = k.gateway.drive;
  const role = { person: BOB, role: "member" };
  await g.setRole(owner, role, { presence: proof("grants.role", role, `vyre://${SPACE}/member/${BOB}`) });
  // a member's role has no drive actions: the file is not there for them
  await D.put(owner, "proj/a.txt", new TextEncoder().encode("secret text"), {}).catch(() => {});
  await assert.rejects(() => D.put(bob, "proj/a.txt", new Uint8Array([1])), { code: "not_found" });
  assert.deepEqual(drive.calls, [], "refused before the drive was touched");
  // grant Bob read on one folder only
  const gi = { subject: { kind: "actor", actor: { kind: "person", id: BOB, space: SPACE } }, actions: ["drive.read", "drive.write"], resource: { prefix: `vyre://${SPACE}/file/proj/*` }, conditions: {}, source: "test" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  const r = await D.put(bob, "proj/a.txt", new TextEncoder().encode("hello"));
  assert.equal(r.version, 1);
  assert.deepEqual(drive.calls.at(-1), ["put", "proj/a.txt", `person:${BOB}`], "by is the chain's actor, not a caller's word");
  assert.equal(new TextDecoder().decode(await D.get(bob, "proj/a.txt")), "hello");
  await D.put(owner, "other/b.txt", new Uint8Array([2])).catch(() => {});
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
  assert.deepEqual(k.log.read({ type: "file.accessed" })[0].data.path, "proj/a.txt");
});
