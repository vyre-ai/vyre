// A chat's folders are its participants' only (kernel/core/folders.js, CONTRACT-one-chat.md section 6). One refusal test per way in at the Drive gateway: a non-participant who holds the exact path
// (an owner, an admin, a member of the project) is refused on get, history, put, listing, move, remove and delete, and a share is a grant that reads one file and nothing else.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
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
    async restore() { return { version: 1 }; }, async prune() { return { pruned: 0 }; }, async backup() { return { id: "b1" }; }, backups() { return []; }, async restoreBackup() { return {}; }, async pruneBackups() { return {}; },
  };
}

async function rig() {
  const drive = fakeDrive();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (person, id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const bob = dev(BOB, "d-b"), carol = dev(CAROL, "d-c"), ada = dev(ADA, "d-a"), dan = dev(DAN, "d-d");
  const asst = (person, session) => k.chains.fromFacts({ kind: "agent_session", vouched: true, person, agent: "kit", session });
  const chat = await g.chats.create(bob, { people: [CAROL], assistants: ["kit"] });
  const dir = `Projects/p1/chat/${chat.id}`, made = `Projects/p1/made/${chat.id}`;
  return { k, drive, D: k.gateway.drive, g, owner, bob, carol, ada, dan, asst, chat, dir, made };
}
const enc = s => new TextEncoder().encode(s);

test("a participant reads and writes the chat's folders, an assistant of a participant too, and nobody else does: not the owner, an admin, a project member or whoever holds the exact path", async () => {
  const { D, drive, owner, bob, carol, ada, dan, asst, dir, made } = await rig();
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  await D.put(carol, `${made}/out.txt`, enc("made"));
  assert.equal(new TextDecoder().decode(await D.get(carol, `${dir}/note.txt`)), "hello", "the other participant");
  assert.equal(new TextDecoder().decode(await D.get(asst(BOB, "s1"), `${dir}/note.txt`)), "hello", "the assistant the chat lists, for a participant");
  await assert.rejects(() => D.get(asst(OWNER, "s2"), `${dir}/note.txt`), { code: "not_found" }, "the same assistant acting for someone outside");
  drive.calls.length = 0;
  for (const [who, name] of [[owner, "owner"], [ada, "admin"], [dan, "member"]]) {
    await assert.rejects(() => D.get(who, `${dir}/note.txt`), { code: "not_found" }, `get by ${name}`);
    await assert.rejects(() => D.get(who, `${made}/out.txt`), { code: "not_found" }, `get (made) by ${name}`);
    await assert.rejects(() => D.history(who, `${dir}/note.txt`), { code: "not_found" }, `history by ${name}`);
    await assert.rejects(() => D.put(who, `${dir}/note.txt`, enc("x")), { code: "not_found" }, `put by ${name}`);
    await assert.rejects(() => D.put(who, `${dir}/new.txt`, enc("x")), { code: "not_found" }, `put of a new file by ${name}`);
    await assert.rejects(() => D.delete(who, `${dir}/note.txt`), { code: "not_found" }, `delete by ${name}`);
    await assert.rejects(() => D.moveFolder(who, dir, `Projects/p1/chat/other`), { code: "not_found" }, `moveFolder by ${name}`);
    await assert.rejects(() => D.list(who, `${dir}`).then(r => { if (r.length) throw Object.assign(new Error("listed"), { code: "listed" }); throw Object.assign(new Error("empty"), { code: "not_found" }); }), { code: "not_found" }, `a listing of the chat folder by ${name} shows nothing`);
  }
  assert.deepEqual(drive.calls, [], "refused before the Drive was touched");
  assert.equal(new TextDecoder().decode(await D.get(bob, `${dir}/note.txt`)), "hello", "nothing was lost");
  // a listing of a parent shows a non-participant none of the chat's files
  for (const who of [owner, ada, dan]) {
    const rows = await D.list(who, "Projects/p1").catch(() => []);
    assert.deepEqual(rows.filter(r => r.path.includes("/chat/") || r.path.includes("/made/")), [], "the chat's files are absent from a project listing");
  }
});

test("a participant who leaves loses the folder at once, and a person added later reads it", async () => {
  const { g, D, bob, carol, dir, ada } = await rig();
  const chats = g.chats;
  const c = (await (async () => { const all = dir.split("/").pop(); return all; })());
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  await chats.change(bob, c, { add_people: [ADA] });
  assert.equal(new TextDecoder().decode(await D.get(ada, `${dir}/note.txt`)), "hello", "added: reads");
  await chats.change(bob, c, { remove_people: [CAROL] });
  await assert.rejects(() => D.get(carol, `${dir}/note.txt`), { code: "not_found" }, "removed: refused on the next call");
});

test("Share to project is a kernel grant of drive.read on that one file: a member reads it, never the folder, another file of the chat, or writes", async () => {
  const { k, g, D, owner, bob, dan, dir } = await rig();
  await D.put(bob, `${dir}/shared.txt`, enc("for the project"));
  await D.put(bob, `${dir}/private.txt`, enc("not shared"));
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" }, "before the share");
  // the share: the participant's own act, a grant to the project's readers on exactly this file
  const gi = { subject: { kind: "role", name: "member" }, actions: ["drive.read"], resource: { prefix: `vyre://${SPACE}/file/${dir}/shared.txt` }, conditions: {}, source: "chat:share" };
  await g.create(owner, gi, { presence: proof("grants.create", gi, `vyre://${SPACE}/grant/new`) });
  assert.equal(new TextDecoder().decode(await D.get(dan, `${dir}/shared.txt`)), "for the project", "a member reads the shared file");
  await assert.rejects(() => D.get(dan, `${dir}/private.txt`), { code: "not_found" }, "not the next file");
  await assert.rejects(() => D.put(dan, `${dir}/shared.txt`, enc("x")), { code: "not_found" }, "not write");
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt/../private.txt`), e => ["not_found", "bad_input"].includes(e.code), "not by a path trick");
  assert.ok(k);
});
