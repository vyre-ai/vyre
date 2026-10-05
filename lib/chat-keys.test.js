// Per-chat keys: rings, add with and without history, remove (rotate), file keys, share and unshare, names, and an agent holding keys in process only.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { newDeviceKey, fingerprint } from "./keywrap.js";
import { createRing, openRing, addHolders, removeHolders, sealFile, openFile, shareFile, openShared, unshareFile, rewrapFile, namer, bundleFor, openBundle, ProcessKeys } from "./chat-keys.js";

const person = () => { const d = newDeviceKey(); return { ...d, name: fingerprint(d.publicJwk) }; };
const pub = (...ps) => Object.fromEntries(ps.map(p => [p.name, p.publicJwk]));

test("ring: a holder opens it; a stranger does not; add with history reads the past, add without reads only from then; removal rotates and drops the removed holder", () => {
  const a = person(), b = person(), c = person(), d = person();
  const { doc: d1, keys: ka } = createRing("chat-1", pub(a, b));
  const msg1 = ka.current();
  assert.ok(openRing(d1, b.name, b.privateJwk));
  assert.throws(() => openRing(d1, c.name, c.privateJwk), /holds no wrap/);
  // add c with history: c reads epoch 1
  const d2 = addHolders(d1, ka, { add: pub(c) });
  assert.equal(d2.epoch, 1);
  assert.deepEqual(openRing(d2, c.name, c.privateJwk).at(1), msg1.key);
  // add d without history: the ring rotates, d holds epoch 2 only
  const d3 = addHolders(d2, ka, { add: pub(d), all: pub(a, b, c), history: false });
  assert.equal(d3.epoch, 2);
  const kd = openRing(d3, d.name, d.privateJwk);
  assert.deepEqual([...kd.keys.keys()], [2]);
  assert.throws(() => kd.at(1), /holds no key of that epoch/);
  assert.deepEqual(openRing(d3, a.name, a.privateJwk).at(1), msg1.key, "existing holders keep the past");
  // remove b: rotate, b's wraps gone from every epoch, the others read old and new
  const kA = openRing(d3, a.name, a.privateJwk);
  const d4 = removeHolders(d3, kA, { keep: pub(a, c, d), drop: [b.name] });
  assert.equal(d4.epoch, 3);
  assert.throws(() => openRing(d4, b.name, b.privateJwk), /holds no wrap/);
  assert.deepEqual(openRing(d4, c.name, c.privateJwk).at(1), msg1.key);
  assert.deepEqual(openRing(d4, a.name, a.privateJwk).current().epoch, 3);
  assert.notDeepEqual(openRing(d4, a.name, a.privateJwk).at(3), msg1.key);
});

test("files: a key of their own under the chat; share to a project is a wrap, not a copy; unshare rotates the file key and re-seals; names are stable ids and sealed", () => {
  const a = person(), p1 = person(), p2 = person();
  const chat = createRing("chat-1", pub(a)), proj = createRing("proj-1", pub(p1)), proj2 = createRing("proj-2", pub(p2));
  const { rec, content } = sealFile(chat.keys, "f1", "Dana Reyes owes 4,200");
  assert.equal(openFile(chat.keys, rec, content).toString(), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, rec, content), /not shared/);
  const shared = shareFile(chat.keys, shareFile(chat.keys, rec, proj.keys), proj2.keys);
  assert.equal(openShared(proj.keys, shared, content).toString(), "Dana Reyes owes 4,200", "the same ciphertext, opened through the project");
  assert.equal(JSON.stringify(shared).includes("Dana"), false);
  // unshare from proj-1: the file key rotates, the content is sealed again, proj-2 keeps its share
  const un = unshareFile(chat.keys, shared, content, "proj-1", [proj.keys, proj2.keys]);
  assert.notDeepEqual(un.content, content);
  assert.equal(openFile(chat.keys, un.rec, un.content).toString(), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, un.rec, un.content), /not shared/);
  assert.equal(openShared(proj2.keys, un.rec, un.content).toString(), "Dana Reyes owes 4,200");
  assert.throws(() => openShared(proj.keys, { ...un.rec, shares: shared.shares }, un.content), /cannot open/, "the old wrap does not open the new content");
  // names
  const n = namer(chat.keys), same = namer(openRing(chat.doc, a.name, a.privateJwk));
  assert.equal(n.id("Northwind/ledger.txt"), same.id("Northwind/ledger.txt"));
  assert.notEqual(n.id("Northwind/ledger.txt"), namer(proj.keys).id("Northwind/ledger.txt"), "another ring, another id");
  assert.equal(n.open(n.seal("Northwind/ledger.txt")), "Northwind/ledger.txt");
  assert.equal(JSON.stringify(n.seal("Northwind")).includes("Northwind"), false);
});

test("rotation: the name ids stay the same, file keys move to the newest epoch, and a removed holder cannot read a file sealed after", () => {
  const a = person(), b = person();
  const chat = createRing("c", pub(a, b));
  const ids = namer(chat.keys).id("x");
  const { rec, content } = sealFile(chat.keys, "f", "before");
  const doc2 = removeHolders(chat.doc, chat.keys, { keep: pub(a), drop: [b.name] });
  assert.equal(namer(openRing(doc2, a.name, a.privateJwk)).id("x"), ids, "the pool's index survives a rotation");
  const ka = openRing(doc2, a.name, a.privateJwk);
  const moved = rewrapFile(ka, rec);
  assert.equal(moved.epoch, 2);
  assert.equal(openFile(ka, moved, content).toString(), "before");
  const after = sealFile(ka, "g", "after");
  assert.throws(() => openRing(doc2, b.name, b.privateJwk), /holds no wrap/);
  assert.equal(after.rec.epoch, 2);
});

test("in process only: a bundle wrapped to a session key opens into memory; keys are used for an allowed agent, never serialised, and wiped on lock", async () => {
  const a = person(), session = newDeviceKey();
  const chat = createRing("c", pub(a));
  const bundle = bundleFor(chat.keys, session.publicJwk);
  assert.throws(() => openBundle(bundle, "c", newDeviceKey().privateJwk), /cannot open/);
  const k = openBundle(bundle, "c", session.privateJwk);
  const pk = new ProcessKeys((chat, agent) => agent === "kit");
  pk.hold(k);
  const { rec, content } = sealFile(chat.keys, "f", "hello");
  assert.equal(await pk.withKeys("c", "kit", kk => openFile(kk, rec, content).toString()), "hello");
  await assert.rejects(() => pk.withKeys("c", "mallory", () => 1), /may not work/);
  await assert.rejects(() => pk.withKeys("other", "kit", () => 1), /not unlocked/);
  assert.throws(() => JSON.stringify(k), /never serialised/);
  assert.throws(() => JSON.stringify(pk), /never serialised/);
  pk.lock();
  await assert.rejects(() => pk.withKeys("c", "kit", () => 1), /not unlocked/);
  assert.ok(k.keys.size === 0, "wiped");
});
