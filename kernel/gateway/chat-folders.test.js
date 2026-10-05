// A chat's folders are its participants' only (kernel/core/folders.js, CONTRACT-one-chat.md section 6). One refusal test per way in at the Drive gateway: a non-participant who holds the exact path
// (an owner, an admin, a member of the project) is refused on get, history, put, listing, move, remove and delete, and a share is a grant that reads one file and nothing else.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { FILE_SHARE } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada", DAN = "per_dan";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };

function fakeDrive() {
  const files = new Map(), calls = [];
  return { calls, files,
    async put(p, bytes, { by }) { const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); calls.push(["put", p]); return { version: f.length }; },
    async get(p, { version } = {}) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return f[(version ?? f.length) - 1].bytes; },
    stat(p) { const f = files.get(p); if (!f) throw Object.assign(new Error("nf"), { code: "not_found" }); return { version: f.length, size: f.at(-1).bytes.length, sha256: null }; },
    async *stream(p) { yield Buffer.from(files.get(p).at(-1).bytes); },
    async putStream(p, source, { by }) { const chunks = []; for await (const c of source) chunks.push(c); const bytes = Buffer.concat(chunks); const f = files.get(p) || []; f.push({ ver: f.length + 1, bytes, by }); files.set(p, f); return { version: f.length, size: bytes.length, sha256: null }; },
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
  // the work module's `file-share` type, and its service chain that the kernel reads shares with
  k.kernelFor({ name: "work", needs: { kernel: { actions: ["records.read"] } } });
  await k.gateway.records.define(owner, { add_types: [FILE_SHARE] });
  const share = (/** @type {any} */ who, /** @type {string} */ path) => k.gateway.records.create(who, "file-share", { path });
  const chat = await g.chats.create(bob, { people: [CAROL], assistants: ["kit"] });
  const dir = `Projects/p1/chat/${chat.id}`, made = `Projects/p1/made/${chat.id}`;
  return { k, drive, D: k.gateway.drive, g, owner, bob, carol, ada, dan, asst, chat, dir, made, share };
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

test("Share to project is a `file-share` record a participant makes: a member reads that one file, never the folder, another file of the chat, or writes; a share by someone outside the chat counts for nothing", async () => {
  const { D, owner, bob, dan, dir, share } = await rig();
  await D.put(bob, `${dir}/shared.txt`, enc("for the project"));
  await D.put(bob, `${dir}/private.txt`, enc("not shared"));
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" }, "before the share");
  await share(dan, `${dir}/shared.txt`);
  await share(owner, `${dir}/shared.txt`);
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" }, "a share by someone who is not in the chat opens nothing");
  await share(bob, `${dir}/shared.txt`);
  assert.equal(new TextDecoder().decode(await D.get(dan, `${dir}/shared.txt`)), "for the project", "a member reads the shared file");
  await assert.rejects(() => D.get(dan, `${dir}/private.txt`), { code: "not_found" }, "not the next file");
  await assert.rejects(() => D.put(dan, `${dir}/shared.txt`, enc("x")), { code: "not_found" }, "not write");
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt/../private.txt`), e => ["not_found", "bad_input"].includes(e.code), "not by a path trick");
});

test("a module's own service chain may write a chat's files and never reads them: a tool cannot read for a non-participant through it", async () => {
  const { k, D, bob, dir, dan } = await rig();
  const svc = k.gateway.serviceChain("work");
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  await assert.rejects(() => D.get(svc, `${dir}/note.txt`), { code: "not_found" });
  await assert.rejects(() => D.get(dan, `${dir}/note.txt`), { code: "not_found" });
});

test("unsharing takes the file back at once: the share record is removed (by whoever Records lets remove it: its author, or an admin)", async () => {
  const { k, D, bob, dan, ada, dir, share } = await rig();
  await D.put(bob, `${dir}/shared.txt`, enc("for the project"));
  const sh = await share(bob, `${dir}/shared.txt`);
  assert.ok(await D.get(dan, `${dir}/shared.txt`));
  await k.gateway.records.remove(bob, "file-share", sh.id);
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" }, "refused again");
  const again = await share(bob, `${dir}/shared.txt`);
  await k.gateway.records.remove(ada, "file-share", again.id);
  await assert.rejects(() => D.get(dan, `${dir}/shared.txt`), { code: "not_found" }, "an admin may take a share back");
});

test("the file seam a device sync or a lent request reads through meets the same check, and an agent that is not in the chat is refused even for a participant", async () => {
  const { k, g, D, owner, bob, dan, ada, asst, dir } = await rig();
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  const read = async (/** @type {any} */ who, /** @type {string} */ p) => { const st = await D.files(who).read(p); const out = []; for await (const c of st.stream()) out.push(c); return Buffer.concat(out).toString(); };
  assert.equal(await read(bob, `${dir}/note.txt`), "hello", "a participant's seam reads it");
  for (const who of [owner, ada, dan]) await assert.rejects(() => read(who, `${dir}/note.txt`), { code: "not_found" }, "a non-participant's seam");
  async function* src() { yield Buffer.from("x"); }
  await assert.rejects(() => D.files(dan).write(`${dir}/new.txt`, src(), { maxBytes: 10 }), { code: "not_found" }, "and cannot write through it");
  // an agent the chat does not list, acting for a participant
  const scout = { kind: "agent", id: "scout", space: SPACE };
  await g.addActor(owner, scout, { presence: proof("grants.role", { actor: scout }, `vyre://${SPACE}/member/scout`) });
  const asScout = k.chains.fromFacts({ kind: "agent_session", vouched: true, person: BOB, agent: "scout", session: "s9" });
  await assert.rejects(() => D.get(asScout, `${dir}/note.txt`), { code: "not_found" });
  assert.equal(new TextDecoder().decode(await D.get(asst(BOB, "s10"), `${dir}/note.txt`)), "hello", "the listed assistant still reads");
});

test("a path guess does not get around the folder: dot segments, doubled slashes, encoded slashes, other case and trailing dots are refused or are another file that is not there", async () => {
  const { D, dan, ada, owner, bob, dir } = await rig();
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  const id = dir.split("/").pop();
  const guesses = [
    `Projects/p1/chat/${id}/../${id}/note.txt`, `Projects/p1/chat/./${id}/note.txt`, `Projects/p1//chat/${id}/note.txt`, `Projects/p1/chat/${id}//note.txt`,
    `Projects/p1/chat/${id}%2Fnote.txt`, `Projects/p1/chat/${id}/note.txt/`, `Projects/p1/chat/${id}/note.txt.`, `Projects/p1/CHAT/${id}/note.txt`, `Projects/p1/chat/${id.toUpperCase()}/note.txt`,
    `Projects/p1/chat/${id}/%2e%2e/${id}/note.txt`, `/Projects/p1/chat/${id}/note.txt`,
  ];
  for (const who of [dan, ada, owner]) for (const p of guesses) {
    let got = null;
    try { got = new TextDecoder().decode(await D.get(who, p)); } catch (e) { assert.ok(["not_found", "bad_input"].includes(e.code), `${p}: ${e.code}`); }
    assert.equal(got, null, `a guess read the file: ${p}`);
  }
});

test("a move's inventory lists a project's folder with the chat folders and no bytes, and removes them after, for an owner or admin with the move's own event, and for nobody else", async () => {
  const { k, D, drive, bob, ada, dan, dir, made } = await rig();
  await D.put(bob, `${dir}/note.txt`, enc("hello"));
  await D.put(bob, `${made}/out.txt`, enc("made"));
  drive.files.set("Projects/p1/retainer.txt", [{ ver: 1, bytes: enc("signed"), by: "x" }]);
  drive.files.set("Projects/p2/other.txt", [{ ver: 1, bytes: enc("not this project"), by: "x" }]);
  const started = (/** @type {any} */ who, /** @type {string} */ id) => k.log.append(who, { type: "project.move_started", sv: 1, subject: `vyre://${SPACE}/project/p1`, data: { move_id: id, to: "spc_bbbbbbbbbbbb", plan_hash: "h".repeat(43) } });
  const MOVE = "11111111-1111-4111-8111-111111111111";
  await assert.rejects(() => D.inventory(ada, "Projects/p1", { move_id: MOVE }), { code: "not_found" }, "no event, no inventory");
  started(ada, MOVE);
  const inv = await D.inventory(ada, "Projects/p1", { move_id: MOVE });
  assert.deepEqual(inv.map(e => [e.path.slice("Projects/p1/".length), e.chat]).sort(), [[`chat/${dir.split("/").pop()}/note.txt`, true], [`made/${made.split("/").pop()}/out.txt`, true], ["retainer.txt", false]].sort());
  assert.ok(inv.every(e => !("bytes" in e)), "never a byte");
  await assert.rejects(() => D.inventory(ada, "Projects/p2", { move_id: MOVE }), { code: "bad_input" }, "only the moved project's folder");
  // a member who is not an admin: even with an event under their name
  const M2 = "22222222-2222-4222-8222-222222222222";
  started(dan, M2);
  await assert.rejects(() => D.inventory(dan, "Projects/p1", { move_id: M2 }), { code: "not_found" });
  await assert.rejects(() => D.removeMoved(dan, [`${dir}/note.txt`], { move_id: M2 }), { code: "not_found" });
  await assert.rejects(() => D.removeMoved(ada, ["Projects/p2/other.txt"], { move_id: MOVE }), { code: "bad_input" }, "another project's file");
  assert.equal((await D.removeMoved(ada, inv.map(e => e.path), { move_id: MOVE })).removed, 3);
  assert.equal(drive.files.has(`${dir}/note.txt`), false);
  assert.equal(drive.files.has("Projects/p2/other.txt"), true, "the other project is untouched");
});
