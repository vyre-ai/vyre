// A project's files move between two Spaces on one home sealed: re-sealed from A's pool key to B's inside the kernel, never returned, never read by the mover; only for an open move under an owner or admin of both;
// resumable; and a chat's files in the target are still its participants' only.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { Pool } from "../storage/pool.js";
import { Drive } from "../storage/drive.js";
import { dirBackend } from "../storage/backends.js";

const A = "spc_aaaaaaaaaaaa", B = "spc_bbbbbbbbbbbb", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada", DAN = "per_dan";
const used = new Set();
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const enc = s => new TextEncoder().encode(s);
const MOVE = "11111111-1111-4111-8111-111111111111";

async function space(id, root) {
  const dir = path.join(root, id);
  const pool = new Pool({ dir, key: crypto.randomBytes(32) });   // each Space's own pool key
  pool.addNode({ id: "home", backend: dirBackend(path.join(dir, "node")), home: true });
  const drive = new Drive(pool);
  const k = await createKernel({ space: id, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, id === A ? 7 : 8), presence, drive });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const dev = (person, did) => k.chains.fromFacts({ kind: "device", device_key_id: did, person, path: "direct" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "member"], [CAROL, "member"], [ADA, "admin"], [DAN, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${id}/member/${p}`) }); }
  const bob = dev(BOB, "d-b"), carol = dev(CAROL, "d-c"), ada = dev(ADA, "d-a"), dan = dev(DAN, "d-d");
  const chat = await g.chats.create(bob, { people: [CAROL, ADA] });   // the mover (Ada) is in this chat
  const closed = await g.chats.create(bob, { people: [CAROL] });   // and not in this one
  return { id, k, dir, pool, D: k.gateway.drive, g, owner, bob, carol, ada, dan, chat, folder: `Projects/p1/chat/${chat.id}`, closed: `Projects/p1/chat/${closed.id}` };
}
async function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-carry-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = await space(A, root), b = await space(B, root);
  const reg = { for: id => ({ kernel: id === A ? a.k : b.k }) };
  a.k.bindSpaces(reg); b.k.bindSpaces(reg);
  const moves = a.k.kernelFor({ name: "work" }).moves;
  const started = (who, id) => a.k.log.append(who, { type: "project.move_started", sv: 1, subject: `vyre://${A}/project/p1`, data: { move_id: id, to: B, plan_hash: "h".repeat(43) } });
  return { a, b, moves, started };
}
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

test("a chat folder moves between two Spaces re-sealed: it arrives intact, the hash is of what is stored, the answer holds no bytes, the source is untouched, and in the target only the participants read it", async t => {
  const { a, b, moves, started } = await world(t);
  const text = "the chat's file: SECRET-CARRY-TEXT ".repeat(20);
  await a.D.put(a.bob, `${a.folder}/note.txt`, enc(text));
  const dest = `${b.folder}/note.txt`;
  const entries = [{ path: `${a.folder}/note.txt`, dest, sha256: sha(text), size: Buffer.byteLength(text) }];
  started(a.ada, MOVE);
  const out = await moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE });
  assert.deepEqual(out, [{ dest, sha256: sha(text) }]);
  assert.ok(!JSON.stringify(out).includes("SECRET-CARRY-TEXT"), "no byte in the answer");
  // the target's participants read it; the target's owner and a plain member, who are not in the chat, read nothing
  assert.equal(new TextDecoder().decode(await b.D.get(b.bob, dest)), text);
  assert.equal(new TextDecoder().decode(await b.D.get(b.carol, dest)), text);
  for (const [who, name] of [[b.owner, "owner"], [b.dan, "member"]]) await assert.rejects(() => b.D.get(who, dest), { code: "not_found" }, `${name} reads nothing in the target`);
  // the source still has it (removal is the gateway's, after the target is verified)
  assert.equal(new TextDecoder().decode(await a.D.get(a.bob, `${a.folder}/note.txt`)), text);
  // sealed under each Space's own pool key: no chunk of A's pool is in B's, and neither folder holds the text
  const files = d => { const o = []; const w = x => { for (const n of fs.existsSync(x) ? fs.readdirSync(x) : []) { const p = path.join(x, n); fs.statSync(p).isDirectory() ? w(p) : o.push(p); } }; w(d); return o; };
  const inA = files(path.join(a.dir, "node")), inB = files(path.join(b.dir, "node"));
  assert.ok(inA.length && inB.length);
  assert.deepEqual(inA.map(f => path.basename(f)).filter(n => inB.some(f => path.basename(f) === n)), [], "different keys, different chunks");
  for (const f of [...inA, ...inB]) assert.ok(!fs.readFileSync(f).includes(Buffer.from("SECRET-CARRY-TEXT")), "only ciphertext at rest");
});

test("carry is resumable and checked: run again it writes nothing twice, a file that is not what the plan approved stops it, and nothing partial reads as done", async t => {
  const { a, b, moves, started } = await world(t);
  await a.D.put(a.bob, `${a.folder}/one.txt`, enc("one")); await a.D.put(a.bob, `${a.folder}/two.txt`, enc("two"));
  const e = n => ({ path: `${a.folder}/${n}.txt`, dest: `${b.folder}/${n}.txt`, sha256: sha(n), size: n.length });
  started(a.ada, MOVE);
  // the first run stops at the second file (its plan hash is wrong), the first is already carried
  await assert.rejects(() => moves.carryFiles(a.ada, b.ada, { entries: [e("one"), { ...e("two"), sha256: sha("tampered") }], move_id: MOVE }), { code: "conflict" });
  assert.equal(new TextDecoder().decode(await b.D.get(b.bob, `${b.folder}/one.txt`)), "one");
  await assert.rejects(() => b.D.get(b.bob, `${b.folder}/two.txt`), { code: "not_found" }, "the second never arrived");
  // run again with the right entries: the first is not written again (one version), the second arrives
  const out = await moves.carryFiles(a.ada, b.ada, { entries: [e("one"), e("two")], move_id: MOVE });
  assert.deepEqual(out.map(x => x.sha256), [sha("one"), sha("two")]);
  assert.equal((await b.D.history(b.bob, `${b.folder}/one.txt`)).length, 1, "carried once");
  assert.equal(new TextDecoder().decode(await b.D.get(b.bob, `${b.folder}/two.txt`)), "two");
});

test("carry runs only for an open move under an owner or admin of both Spaces, for one person, into a project folder, and only the moved project's files", async t => {
  const { a, b, moves, started } = await world(t);
  await a.D.put(a.bob, `${a.folder}/note.txt`, enc("x"));
  const entries = [{ path: `${a.folder}/note.txt`, dest: `${b.folder}/note.txt`, sha256: sha("x"), size: 1 }];
  await assert.rejects(() => moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE }), { code: "not_found" }, "no move event, no carry");
  started(a.ada, MOVE);
  await assert.rejects(() => moves.carryFiles(a.ada, b.carol, { entries, move_id: MOVE }), { code: "not_allowed" }, "two different people");
  const M2 = "22222222-2222-4222-8222-222222222222"; started(a.dan, M2);
  await assert.rejects(() => moves.carryFiles(a.dan, b.dan, { entries, move_id: M2 }), { code: "not_found" }, "a plain member with an event under their name is no mover");
  await assert.rejects(() => moves.carryFiles(a.ada, a.ada, { entries, move_id: MOVE }), { code: "bad_input" }, "another Space");
  for (const bad of [{ ...entries[0], path: "Projects/p2/chat/x/note.txt" }, { ...entries[0], dest: "Other/note.txt" }, { ...entries[0], dest: "Projects/p1/../x/note.txt" }, { ...entries[0], sha256: "zz" }]) {
    await assert.rejects(() => moves.carryFiles(a.ada, b.ada, { entries: [bad], move_id: MOVE }), { code: "bad_input" }, JSON.stringify(bad));
  }
  assert.deepEqual(await moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE }).then(r => r.length), 1, "and the real one goes");
  // a module that is not the work module is not given the carry at all
  assert.equal(a.k.kernelFor({ name: "records-tools" }).moves, undefined);
});

test("without a destination the files land under the target project, and a chat's folders under the chat the move made there; a chat that was not mapped is refused", async t => {
  const { a, b, moves, started } = await world(t);
  await a.D.put(a.bob, `${a.folder}/note.txt`, enc("chat note")); await a.D.put(a.ada, "Projects/p1/retainer.txt", enc("plain project file"));
  const oldChat = a.folder.split("/").pop(), newChat = b.folder.split("/").pop();
  const entries = [{ path: `${a.folder}/note.txt`, sha256: sha("chat note"), size: 9 }, { path: "Projects/p1/retainer.txt", sha256: sha("plain project file"), size: 18 }];
  started(a.ada, MOVE);
  await assert.rejects(() => moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE, project_to: "p9", chat_map: {} }), { code: "bad_input" }, "an unmapped chat is not carried");
  const out = await moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE, project_to: "p9", chat_map: { [oldChat]: newChat } });
  assert.deepEqual(out.map(x => x.dest), [`Projects/p9/chat/${newChat}/note.txt`, "Projects/p9/retainer.txt"]);
  assert.equal(new TextDecoder().decode(await b.D.get(b.bob, `Projects/p9/chat/${newChat}/note.txt`)), "chat note");
  await assert.rejects(() => b.D.get(b.ada, `Projects/p9/chat/${newChat}/note.txt`), { code: "not_found" }, "the mover still reads nothing in the chat");
  await assert.rejects(() => moves.carryFiles(a.ada, b.ada, { entries, move_id: MOVE, project_to: "../x", chat_map: { [oldChat]: newChat } }), { code: "bad_input" });
});

test("a Personal to My Cloud upgrade carries files too: space.upgrade_started for this target by the same person, within a day; nothing else is accepted", async t => {
  const { a, b, moves } = await world(t);
  const text = "upgrade file ".repeat(10); const UP = "22222222-2222-4222-8222-222222222222";
  await a.D.put(a.bob, `${a.folder}/n.txt`, enc(text));
  const dest = `${b.folder}/n.txt`;
  const entries = [{ path: `${a.folder}/n.txt`, dest, sha256: sha(text), size: Buffer.byteLength(text) }];
  const up = (who, id, to = B, subject = `vyre://${A}/space/upgrade`) => a.k.log.append(who, { type: "space.upgrade_started", sv: 1, subject, data: { upgrade_id: id, to, plan_hash: "h".repeat(43) } });
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: UP }), e => e.code === "not_found", "no event, no carry");
  up(a.ada, UP, "spc_cccccccccccc"); await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: UP }), e => e.code === "not_found", "an upgrade into another Space is not this target's");
  up(a.ada, "33333333-3333-4333-8333-333333333333", B, `vyre://${A}/project/p1`);
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: "33333333-3333-4333-8333-333333333333" }), e => e.code === "not_found", "the subject must be the space's upgrade");
  up(a.dan, UP);
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: UP }), e => e.code === "not_found", "another person's upgrade is not mine to carry");
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: UP, move_id: MOVE }), e => e.code === "bad_input", "an upgrade and a move are not mixed");
  const UP2 = "44444444-4444-4444-8444-444444444444"; up(a.ada, UP2);
  const out = await moves.carryFiles(a.ada, b.ada, { entries, upgrade_id: UP2 });
  assert.deepEqual(out, [{ dest, sha256: sha(text) }]);
  assert.equal(new TextDecoder().decode(await b.D.get(b.bob, dest)), text);
  // a changed file is still refused, and a path outside Projects is not a project's
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries: [{ ...entries[0], sha256: sha("other") }], upgrade_id: UP2 }), e => e.code === "conflict" || e.code === "not_found");
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries: [{ path: "General/x.txt", dest, sha256: sha(text), size: 1 }], upgrade_id: UP2 }), e => e.code === "bad_input");
});

test("a file of a chat the mover is not in is refused by name, in a move and in an upgrade: the project folder grant does not reach it", async t => {
  const { a, b, moves, started } = await world(t);
  const text = "closed chat ".repeat(8), UP = "55555555-5555-4555-8555-555555555555";
  await a.D.put(a.bob, `${a.closed}/secret.txt`, enc(text)); await a.D.put(a.bob, `Projects/p1/plain.txt`, enc("plain"));
  const closedE = { path: `${a.closed}/secret.txt`, dest: `${b.closed}/secret.txt`, sha256: sha(text), size: Buffer.byteLength(text) };
  const plainE = { path: "Projects/p1/plain.txt", dest: "Projects/p1/plain.txt", sha256: sha("plain"), size: 5 };
  started(a.ada, MOVE);
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries: [closedE], move_id: MOVE }), e => e.code === "not_found");
  assert.deepEqual((await moves.carryFiles(a.ada, b.ada, { entries: [plainE], move_id: MOVE })).length, 1, "a project's own file still goes");
  a.k.log.append(a.ada, { type: "space.upgrade_started", sv: 1, subject: `vyre://${A}/space/upgrade`, data: { upgrade_id: UP, to: B, plan_hash: "h".repeat(43) } });
  await assert.rejects(moves.carryFiles(a.ada, b.ada, { entries: [closedE], upgrade_id: UP }), e => e.code === "not_found");
  await assert.rejects(() => b.D.get(b.bob, closedE.dest), { code: "not_found" }, "nothing arrived");
});
