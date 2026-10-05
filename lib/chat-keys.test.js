// Per-chat keys: rings, add with and without history, remove (rotate), file keys, share and unshare, names, and an agent holding keys in process only. WebCrypto, so every call is awaited.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newDeviceKey, fingerprint } from "./keywrap.js";
import { createRing, openRing, addHolders, removeHolders, sealFile, openFile, shareFile, openShared, unshareFile, rewrapFile, namer, bundleFor, openBundle, ProcessKeys } from "./chat-keys.js";

const text = (b) => new TextDecoder().decode(b);
const hex = (b) => Buffer.from(b).toString("hex");
const person = async () => { const d = await newDeviceKey(); return { ...d, name: await fingerprint(d.publicJwk) }; };
const pub = (...ps) => Object.fromEntries(ps.map(p => [p.name, p.publicJwk]));

test("ring: a holder opens it; a stranger does not; add with history reads the past, add without reads only from then; removal rotates and drops the removed holder", async () => {
  const a = await person(), b = await person(), c = await person(), d = await person();
  const { doc: d1, keys: ka } = await createRing("chat-1", pub(a, b));
  const msg1 = ka.current();
  assert.ok(await openRing(d1, b.name, b.privateJwk));
  await assert.rejects(() => openRing(d1, c.name, c.privateJwk), /holds no wrap/);
  // add c with history: c reads epoch 1
  const d2 = await addHolders(d1, ka, { add: pub(c) });
  assert.equal(d2.epoch, 1);
  assert.equal(hex((await openRing(d2, c.name, c.privateJwk)).at(1)), hex(msg1.key));
  // add d without history: the ring rotates, d holds epoch 2 only
  const d3 = await addHolders(d2, ka, { add: pub(d), all: pub(a, b, c), history: false });
  assert.equal(d3.epoch, 2);
  const kd = await openRing(d3, d.name, d.privateJwk);
  assert.deepEqual([...kd.keys.keys()], [2]);
  assert.throws(() => kd.at(1), /holds no key of that epoch/);
  assert.equal(hex((await openRing(d3, a.name, a.privateJwk)).at(1)), hex(msg1.key), "existing holders keep the past");
  // remove b: rotate, b's wraps gone from every epoch, the others read old and new
  const kA = await openRing(d3, a.name, a.privateJwk);
  const d4 = await removeHolders(d3, kA, { keep: pub(a, c, d), drop: [b.name] });
  assert.equal(d4.epoch, 3);
  await assert.rejects(() => openRing(d4, b.name, b.privateJwk), /holds no wrap/);
  assert.equal(hex((await openRing(d4, c.name, c.privateJwk)).at(1)), hex(msg1.key));
  assert.equal((await openRing(d4, a.name, a.privateJwk)).current().epoch, 3);
  assert.notEqual(hex((await openRing(d4, a.name, a.privateJwk)).at(3)), hex(msg1.key));
});

test("files: a key of their own under the chat; share to a project is a wrap, not a copy; unshare rotates the file key and re-seals; names are stable ids and sealed", async () => {
  const a = await person(), p1 = await person(), p2 = await person();
  const chat = await createRing("chat-1", pub(a)), proj = await createRing("proj-1", pub(p1)), proj2 = await createRing("proj-2", pub(p2));
  const { rec, content } = await sealFile(chat.keys, "f1", "Dana Reyes owes 4,200");
  assert.equal(text(await openFile(chat.keys, rec, content)), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, rec, content), /not shared/);
  const shared = await shareFile(chat.keys, await shareFile(chat.keys, rec, proj.keys), proj2.keys);
  assert.equal(text(await openShared(proj.keys, shared, content)), "Dana Reyes owes 4,200", "the same ciphertext, opened through the project");
  assert.equal(JSON.stringify(shared).includes("Dana"), false);
  // unshare from proj-1: the file key rotates, the content is sealed again, proj-2 keeps its share
  const un = await unshareFile(chat.keys, shared, content, "proj-1", [proj.keys, proj2.keys]);
  assert.notDeepEqual(un.content, content);
  assert.equal(text(await openFile(chat.keys, un.rec, un.content)), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, un.rec, un.content), /not shared/);
  assert.equal(text(await openShared(proj2.keys, un.rec, un.content)), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, { ...un.rec, shares: shared.shares }, un.content), /cannot open/, "the old wrap does not open the new content");
  // names
  const n = namer(chat.keys), same = namer(await openRing(chat.doc, a.name, a.privateJwk));
  assert.equal(await n.id("Northwind/ledger.txt"), await same.id("Northwind/ledger.txt"));
  assert.notEqual(await n.id("Northwind/ledger.txt"), await namer(proj.keys).id("Northwind/ledger.txt"), "another ring, another id");
  assert.equal(await n.open(await n.seal("Northwind/ledger.txt")), "Northwind/ledger.txt");
  assert.equal(JSON.stringify(await n.seal("Northwind")).includes("Northwind"), false);
});

test("rotation: the name ids stay the same, file keys move to the newest epoch, and a removed holder cannot read a file sealed after", async () => {
  const a = await person(), b = await person();
  const chat = await createRing("c", pub(a, b));
  const ids = await namer(chat.keys).id("x");
  const { rec, content } = await sealFile(chat.keys, "f", "before");
  const doc2 = await removeHolders(chat.doc, chat.keys, { keep: pub(a), drop: [b.name] });
  assert.equal(await namer(await openRing(doc2, a.name, a.privateJwk)).id("x"), ids, "the pool's index survives a rotation");
  const ka = await openRing(doc2, a.name, a.privateJwk);
  const moved = await rewrapFile(ka, rec);
  assert.equal(moved.epoch, 2);
  assert.equal(text(await openFile(ka, moved, content)), "before");
  const after = await sealFile(ka, "g", "after");
  await assert.rejects(() => openRing(doc2, b.name, b.privateJwk), /holds no wrap/);
  assert.equal(after.rec.epoch, 2);
});

test("in process only: a bundle wrapped to a session key opens into memory; keys are used for an allowed agent, never serialised, and wiped on lock", async () => {
  const a = await person(), session = await newDeviceKey();
  const chat = await createRing("c", pub(a));
  const bundle = await bundleFor(chat.keys, session.publicJwk);
  const stranger = await newDeviceKey();
  await assert.rejects(() => openBundle(bundle, "c", stranger.privateJwk), /cannot open/);
  const k = await openBundle(bundle, "c", session.privateJwk);
  const pk = new ProcessKeys((chat, agent) => agent === "kit");
  pk.hold(k);
  const { rec, content } = await sealFile(chat.keys, "f", "hello");
  assert.equal(await pk.withKeys("c", "kit", async kk => text(await openFile(kk, rec, content))), "hello");
  await assert.rejects(() => pk.withKeys("c", "mallory", () => 1), /may not work/);
  await assert.rejects(() => pk.withKeys("other", "kit", () => 1), /not unlocked/);
  assert.throws(() => JSON.stringify(k), /never serialised/);
  assert.throws(() => JSON.stringify(pk), /never serialised/);
  pk.lock();
  await assert.rejects(() => pk.withKeys("c", "kit", () => 1), /not unlocked/);
  assert.ok(k.keys.size === 0, "wiped");
});
