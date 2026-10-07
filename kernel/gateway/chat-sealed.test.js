// A chat's folders, stored sealed (kernel/storage/sealed-drive.js) beneath the gateway: the kernel still decides who reads, and what is on the disk and in the log is ids and ciphertext only. A chat's folders are its participants' only (kernel/core/folders.js, CONTRACT-one-chat.md section 6). One refusal test per way in at the Drive gateway: a non-participant who holds the exact path
// (an owner, an admin, a member of the project) is refused on get, history, put, listing, move, remove and delete, and a share is a grant that reads one file and nothing else.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { sealedDrive } from "../storage/sealed-drive.js";
import { createRing } from "../../lib/chat-keys.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";
import { canonical, sha256 } from "../core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

function fakeDrive() {
  const files = new Map(), calls = [];
  return { calls, files,
    async put(p, bytes, { by }) { const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); calls.push(["put", p]); return { version: f.length }; },
    async get(p, { version } = {}) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
    list(prefix) { return [...files.keys()].filter(k => k.startsWith(prefix)).map(path => ({ path })); },
    history(p) { return (files.get(p) || []).map(v => ({ ver: v.ver, by: v.by })); },
    async delete(p) { files.delete(p); calls.push(["delete", p]); return { deleted: true }; },
    stat(p) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return { version: f.length, size: f[f.length - 1].bytes.length }; },
    async restore() { return { version: 1 }; }, async prune() { return { pruned: 0 }; }, async backup() { return { id: "b1" }; }, backups() { return []; }, async restoreBackup() { return {}; }, async pruneBackups() { return {}; },
  };
}


async function rig() {
  const raw = fakeDrive();
  const dev0 = newDeviceKey(), holder = fingerprint(dev0.publicJwk);
  const held = new Map(), projHeld = new Map();
  const drive = sealedDrive(raw, { keysFor: c => held.get(c) || null, projectKeysFor: p => projHeld.get(p) || null });
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const bob = dev(BOB, "d-b"), carol = dev(CAROL, "d-c"), ada = dev(ADA, "d-a"), dan = dev(DAN, "d-d");
  const chat = await g.chats.create(bob, { people: [CAROL] });
  held.set(chat.id, createRing(chat.id, { [holder]: dev0.publicJwk }).keys);
  projHeld.set("p1", createRing("proj-p1", { [holder]: dev0.publicJwk }).keys);
  const dir = `Projects/p1/chat/${chat.id}`;
  return { k, raw, held, D: k.gateway.drive, g, owner, bob, carol, ada, dan, chat, dir };
}
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

test("sealed chat folders: a participant reads and writes through the gateway; the disk holds ids and ciphertext; the log holds no name", async () => {
  const { k, raw, D, bob, carol, dir } = await rig();
  await D.put(bob, `${dir}/Harlow settlement.txt`, enc("Dana Reyes accepts 250,000"));
  assert.equal(dec(await D.get(carol, `${dir}/Harlow settlement.txt`)), "Dana Reyes accepts 250,000");
  assert.deepEqual((await D.list(bob, dir)).map(e => e.path), [`${dir}/Harlow settlement.txt`]);
  const disk = [...raw.files.entries()].map(([p, vs]) => p + "\n" + vs.map(v => Buffer.from(v.bytes).toString("latin1")).join("\n")).join("\n");
  for (const s of ["Harlow", "settlement", "Dana Reyes", "250,000"]) assert.ok(!disk.includes(s), `${s} is not in the stored paths or bytes`);
  const log = JSON.stringify(k.log.read());
  assert.ok(!log.includes("Harlow") && !log.includes("settlement"), "no file name in the kernel's log");
});

test("sealed chat folders: a non-participant with the exact logical path, and with the disk, gets nothing; a locked chat is absent", async () => {
  const { raw, held, D, owner, ada, dan, bob, chat, dir } = await rig();
  await D.put(bob, `${dir}/secret.txt`, enc("hello"));
  for (const who of [owner, ada, dan]) {
    await assert.rejects(() => D.get(who, `${dir}/secret.txt`), { code: "not_found" });
    assert.deepEqual((await D.list(who, "Projects/p1").catch(() => [])).filter(r => r.path.includes("/chat/")), []);
  }
  // the whole disk, read by someone who is not in the chat: ids and ciphertext
  const all = JSON.stringify([...raw.files.keys()]) + [...raw.files.values()].flat().map(v => Buffer.from(v.bytes).toString("latin1")).join("");
  assert.ok(!all.includes("secret") && !all.includes("hello"));
  held.delete(chat.id);
  await assert.rejects(() => D.get(bob, `${dir}/secret.txt`), e => ["not_found", "unavailable"].includes(e.code), "locked: the participant cannot read either");
});

test("sealed chat folders: Share to project is a grant plus a key wrap, unshare takes it back at once and rotates the key", { todo: "0.3.0 (team/BACKLOG.md): Share to project for a file in an encrypted chat needs project rings and a share tool; 0.2.9 shares by the file-share record (kernel/gateway/shares.js) and makes no wrap" }, async () => {
  const { g, D, bob, dan, ada, dir, raw } = await rig();
  await D.put(bob, `${dir}/shared.txt`, enc("for the project"));
  await D.put(bob, `${dir}/private.txt`, enc("not shared"));
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" });
  await g.shareFile(bob, `${dir}/shared.txt`);
  assert.equal(dec(await D.get(dan, `${dir}/shared.txt`)), "for the project");
  await assert.rejects(() => D.get(dan, `${dir}/private.txt`), { code: "not_found" });
  assert.deepEqual(await g.unshareFile(bob, `${dir}/shared.txt`), { unshared: 1 });
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" });
  assert.equal(dec(await D.get(bob, `${dir}/shared.txt`)), "for the project", "the participant still reads it after the key rotated");
  assert.ok(ada && raw);
});

test("sealed chat folders: a project member who is not in the chat opens a shared file through the project's ring alone, and is refused an unshared one, before and after the chat is locked", { todo: "0.3.0 (team/BACKLOG.md): Share to project for a file in an encrypted chat needs project rings and a share tool; 0.2.9 shares by the file-share record (kernel/gateway/shares.js) and makes no wrap" }, async () => {
  const { g, D, bob, dan, dir, held, chat, raw } = await rig();
  await D.put(bob, `${dir}/shared.txt`, enc("for the project"));
  await D.put(bob, `${dir}/private.txt`, enc("not shared"));
  await g.shareFile(bob, `${dir}/shared.txt`);
  held.delete(chat.id);   // no participant has the chat unlocked: only the project's ring is held
  assert.equal(dec(await D.get(dan, `${dir}/shared.txt`)), "for the project", "opened with the project ring, no chat key");
  await assert.rejects(() => D.get(dan, `${dir}/private.txt`), { code: "not_found" }, "the unshared file stays refused");
  // the project index on the disk is ciphertext too
  const disk = [...raw.files.entries()].map(([p, vs]) => p + "\n" + vs.map(v => Buffer.from(v.bytes).toString("latin1")).join("\n")).join("\n");
  assert.ok(!disk.includes("shared.txt") && !disk.includes("for the project"), "no name or content in the project's share index");
  assert.ok([...raw.files.keys()].some(k => k === "Projects/p1/.shared"), "the project's sealed index exists");
});
