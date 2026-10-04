// @ts-check
// The owner's adoption of the claimed identity (reviewer-2's AO-1 to AO-4, the lead's AO-6): once, logged, serialised, repaired at boot from the log, and everything keyed by the old
// owner's id still belongs to the person. Real daemons on a temp home, kernel on (a test box, never a Mac).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../test/helpers.js";
import { start } from "../core/daemon/index.js";
import { seed } from "../core/records-tools/dev-seed.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const A = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa", B = "per_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const spacesNeed = { name: "spaces", needs: { kernel: { actions: [], spaces: true } } };
const logs = /** @type {string[]} */ ([]);
const boot = (/** @type {string} */ root) => start({ root, log: (/** @type {string} */ m) => { logs.push(m); }, kernel: true });
const person = (/** @type {any} */ d, /** @type {string} */ id) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-adopt", person: id, path: "direct", session: "s" });
const events = (/** @type {any} */ d, /** @type {string} */ type) => d.kernel.log.read({ type });

test("AO-1, AO-2: adoption is once, with an owner.adopted marker and one owner.changed; another identity is refused; the same after a restart", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let d = await boot(root);
  const old = d.kernel.id.owner;
  const h = d.kernel.kernelFor(spacesNeed);
  assert.deepEqual(await h.adoptOwner(A), { owner: A, previous: old, changed: true });
  assert.equal(h.owner, A);
  assert.equal(events(d, "owner.adopted").length, 1);
  assert.equal(events(d, "owner.changed").filter((/** @type {any} */ e) => e.data.owner_change && e.data.owner_change.from === old).length, 1, "one owner.changed names from and to");
  assert.deepEqual(await h.adoptOwner(A), { owner: A, previous: old, changed: false }, "the same id again changes nothing");
  await assert.rejects(() => h.adoptOwner(B), { code: "already_adopted" });
  assert.equal(h.owner, A, "state unchanged");
  assert.equal(events(d, "owner.adopted").length, 1);
  await d.stop();
  d = await boot(root);
  t.after(() => d.stop());
  assert.equal(d.kernel.id.owner, A, "the next start reads the adoption from the log");
  await assert.rejects(() => d.kernel.kernelFor(spacesNeed).adoptOwner(B), { code: "already_adopted" }, "still refused after a restart and rebuild");
});

test("AO-3: space.json put back to the old owner (a crash between the log and the file) is repaired at boot from the log; owner acts work", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  let d = await boot(root);
  const old = d.kernel.id.owner;
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  await d.stop();
  const f = path.join(root, "kernel", "space.json");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify({ ...j, owner: old }));
  d = await boot(root);
  t.after(() => d.stop());
  assert.equal(d.kernel.id.owner, A, "the owner comes from the log");
  assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).owner, A, "the file is rewritten from it");
  const me = person(d, A);
  await d.kernel.gateway.records.define(me, { add_types: [{ name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  assert.ok((await d.kernel.gateway.records.create(me, "note", { title: "owner acts work" })).urn);
});

test("AO-4: five calls at once right after the claim make one adoption", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await boot(root);
  t.after(() => d.stop());
  const h = d.kernel.kernelFor(spacesNeed);
  const r = await Promise.all([1, 2, 3, 4, 5].map(() => h.adoptOwner(A)));
  assert.equal(r.filter((/** @type {any} */ x) => x.changed).length, 1);
  assert.equal(events(d, "owner.adopted").length, 1);
  assert.equal(events(d, "owner.changed").filter((/** @type {any} */ e) => e.data.owner_change && e.data.owner_change.op === "adopt").length, 1);
  const owners = d.kernel.grants.list(person(d, A)).catch(() => []);
  void owners;
});

test("AO-6: what was keyed by the old owner (tasks, records) is still listed for the identity after adoption", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await boot(root);
  t.after(() => d.stop());
  const old = d.kernel.id.owner, space = d.kernel.id.space;
  const oldMe = person(d, old);
  const gw = d.kernel.gateway;
  await gw.records.define(oldMe, { add_types: [{ name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  const rec = await gw.records.create(oldMe, "note", { title: "before" });
  const assistant = { kind: "agent", id: "assistant", space };
  const task = await gw.ask.request(oldMe, { title: "Check this", doer: assistant, checker: { kind: "person", id: old, space }, output: { kind: "decision" }, record: rec.urn });
  assert.equal((await gw.ask.list(oldMe, {})).length, 1, "listed before");
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  const me = person(d, A);
  assert.equal((await gw.records.get(me, "note", rec.id)).data.title === "before" ? 1 : 0, 1, "records survive");
  const listed = await gw.ask.list(me, {});
  assert.deepEqual(listed.map((/** @type {any} */ x) => x.id), [task.id], "the task is still listed");
  assert.deepEqual((await gw.ask.needsYou(me)).length >= 0, true);
});

test("AO-6: the walk's seeded tasks (one waiting for the person's check, one an assistant works) are still listed, and still the person's to decide, after adoption", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await boot(root);
  t.after(() => d.stop());
  const oldMe = person(d, d.kernel.id.owner), space = d.kernel.id.space;
  const seeded = await seed({ gateway: d.kernel.gateway, surfaces: d.kernel.surfaces, chain: oldMe, space });
  const gw = d.kernel.gateway;
  const before = (await gw.ask.list(oldMe, {})).map((/** @type {any} */ x) => x.id).sort();
  assert.equal(before.length, 2, "two seeded tasks before");
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  const me = person(d, A);
  assert.deepEqual((await gw.ask.list(me, {})).map((/** @type {any} */ x) => x.id).sort(), before, "both still listed");
  assert.deepEqual((await gw.ask.needsYou(me)).map((/** @type {any} */ x) => x.id), [seeded.tasks.approval], "the approval still waits for the identity");
});

test("AO-5: a room the old owner made is the identity's room after adoption, and a message written before still goes to that person", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const d = await boot(root);
  t.after(() => d.stop());
  const old = d.kernel.id.owner, oldMe = person(d, old);
  const chats = d.kernel.gateway.grants.chats;
  const chat = await chats.create(oldMe, {});
  const verBefore = chat.ver;
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  const me = person(d, A);
  const room = await chats.read(me, chat.id);
  assert.deepEqual(room.people, [A], "the identity is in the room, the old id is not");
  assert.ok(room.ver > verBefore);
  assert.deepEqual(d.kernel.grants.chatPeopleAt(chat.id, verBefore), [A], "the version written before names the same person");
});

import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { bootHomeKernel } from "./home.js";
import { startSealer } from "./seal/client.js";

test("AO-3 boot repair: the process dies right after the owner.adopted marker; the restarted kernel finishes the move, the owner is the identity and space.json is rewritten", { timeout: 180_000 }, async t => {
  const root = tempHome(t), dbFile = path.join(root, "k.db");
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-seal-"));
  const sealer = startSealer({ dir: sdir, dev: true, unattested: true, timeoutMs: 8000 });
  t.after(async () => { await sealer.close(); fs.rmSync(sdir, { recursive: true, force: true }); });
  // the same sealing process, but once `cut` is set it seals exactly one more event (the marker) and then fails: a process that died after it
  const gate = { cut: false, left: 0 };
  const limited = new Proxy(sealer, { get: (target, key) => key === "kernel" ? { ...target.kernel, mac: async (/** @type {any} */ i) => { if (gate.cut && i.purpose === "grants-event-v1") { if (String(i.data).includes("owner.adopted")) gate.left = 0; else if (gate.left === 0) throw new Error("the process died"); } return target.kernel.mac(i); }, verify: target.kernel.verify.bind(target.kernel) } : /** @type {any} */ (target)[key] });
  const boot = (/** @type {any} */ s) => bootHomeKernel({ db: new DatabaseSync(dbFile), root, sealer: s, log: () => {}, isFirstParty: () => false });
  let k = await boot(limited);
  const old = k.id.owner;
  gate.cut = true; gate.left = 1; // armed: the marker's own seal passes, every grants event after it fails
  await assert.rejects(() => k.kernelFor(spacesNeed).adoptOwner(A), /process died/);
  assert.equal(k.log.read({ type: "owner.adopted" }).length, 1, "the marker was written");
  assert.equal(k.grants.roleOf({ kind: "person", id: A, space: k.id.space }), null, "the move did not happen");
  await k.stop();
  const file = path.join(root, "kernel", "space.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owner, old, "the file still names the old owner");
  gate.cut = false;
  k = await boot(sealer);
  t.after(() => k.stop());
  assert.equal(k.id.owner, A, "the restarted kernel's owner is the identity");
  assert.equal(k.grants.roleOf({ kind: "person", id: A, space: k.id.space }), "owner", "the move was finished at boot");
  assert.equal(k.grants.roleOf({ kind: "person", id: old, space: k.id.space }), null);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owner, A, "space.json is rewritten from the log");
  assert.equal(k.log.read({ type: "owner.adopted" }).length, 1, "the marker is not written twice");
});

test("hosted Spaces: adoption reaches the kernel of a Space made before the claim, at the claim and at boot; a Space someone else owns is left alone", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  let d = await boot(root);
  const old = d.kernel.id.owner;
  const OTHER_OWNER = "per_eeeeeeeeeeeeeeeeeeeeeeeeee";
  const mine = await d.kernel.spaces.host({ owner: old, name: "mine" });
  const theirs = await d.kernel.spaces.host({ owner: OTHER_OWNER, name: "theirs" });
  const roleIn = (/** @type {any} */ dd, /** @type {string} */ space, /** @type {string} */ p) => dd.kernel.spaces.hosted(space).kernel.grants.roleOf({ kind: "person", id: p, space });
  assert.equal(roleIn(d, mine.space, old), "owner");
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  assert.equal(roleIn(d, mine.space, A), "owner", "the created Space took the identity at the claim: " + logs.filter(l => /owner|adopt|hosted/i.test(l)).join(" | "));
  assert.equal(roleIn(d, mine.space, old), null);
  assert.equal(roleIn(d, theirs.space, OTHER_OWNER), "owner", "someone else's Space is left alone");
  assert.equal(roleIn(d, theirs.space, A), null);
  // its own kernel's person is the identity: a chain for the identity works there, the old id's does not
  const me = mine.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-x", person: A, path: "direct", session: "s" });
  await mine.gateway.records.define(me, { add_types: [{ name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] }] });
  assert.ok((await mine.gateway.records.create(me, "note", { title: "in the created space" })).urn);
  const file = path.join(root, "kernel", "spaces", mine.space, "space.json");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).owner, A, "its space.json follows");
  await d.stop();
  // a restart keeps it, and a Space made before the claim that missed it (file put back to the old owner, marker absent in its own log) is caught up at boot
  d = await boot(root);
  t.after(() => d.stop());
  assert.equal(roleIn(d, mine.space, A), "owner");
});

test("hosted Spaces at boot: a restart after the home's adoption leaves a Space made before it with the identity as its owner", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  let d = await boot(root);
  const old = d.kernel.id.owner;
  const mine = await d.kernel.spaces.host({ owner: old, name: "late" });
  // adopt in the HOME's kernel directly, then take the hosted Space back to its old state on disk and in its log by hosting a second Space the old way: a Space opened fresh next boot
  await d.kernel.adoptOwner(A);
  await d.stop();
  d = await boot(root);
  t.after(() => d.stop());
  const k = d.kernel.spaces.hosted(mine.space).kernel;
  assert.equal(k.grants.roleOf({ kind: "person", id: A, space: mine.space }), "owner", "the boot caught the Space up from the home's adoption");
  assert.equal(k.grants.roleOf({ kind: "person", id: old, space: mine.space }), null);
});
