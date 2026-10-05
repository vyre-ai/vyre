// @ts-check
// The encrypted personal records store: it is the reference Store with its state in process memory only, ciphertext on the server, a per-member cap, locked means unreadable.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSealedStore, PERSONAL_TYPES } from "./sealed.js";
import { newKey } from "../../lib/keywrap.js";
import { conformance, CONTACT, ACCOUNT, LEAD, SUITE_REVISION } from "../conformance/suite.js";
import { FileBackend } from "../../core/memory/identity/home.js";

const tmp = (/** @type {any} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-prec-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const REMINDER = { name: "reminder", label: "Reminder", fields: [{ name: "text", kind: "text", label: "Text" }, { name: "due_at", kind: "number", label: "Due" }, { name: "done", kind: "boolean", label: "Done" }] };
const NOTE = { name: "note", label: "Note", fields: [{ name: "text", kind: "text", label: "Text" }] };
const everything = (/** @type {string} */ dir) => { const out = []; const walk = (/** @type {string} */ d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); out.push(n); fs.statSync(p).isDirectory() ? walk(p) : out.push(fs.readFileSync(p, "latin1")); } }; walk(dir); return out.join("\n"); };
const ids = ["0190c3f2-1111-4abc-8def-000000000001", "0190c3f2-1111-4abc-8def-000000000002", "0190c3f2-1111-4abc-8def-000000000003"];

async function seed(/** @type {any} */ t, /** @type {any} */ o = {}) {
  const dir = tmp(t), backend = new FileBackend(dir), imk = newKey();
  const s = createSealedStore({ backend, identity: "alex", imk, create: true, allow: PERSONAL_TYPES, ...o });
  await s.store.define({ add_types: [REMINDER, NOTE] });
  await s.store.create("reminder", ids[0], { text: "Call the dentist about Dana Reyes", due_at: 1000, done: false });
  await s.store.create("reminder", ids[1], { text: "Send the Northwind invoice", due_at: 5000, done: false });
  await s.store.create("note", ids[2], { text: "Prefers email, not calls" });
  return { dir, backend, imk, s };
}

test("sealed store: it works as a Store (get, due-between query, update, remove), and the server's disk holds ciphertext only", async t => {
  const { dir, s } = await seed(t);
  assert.equal((await s.store.get("reminder", ids[0])).data.text, "Call the dentist about Dana Reyes");
  const due = await s.store.query("reminder", { filter: { and: [{ field: "due_at", op: "gte", value: 500 }, { field: "due_at", op: "lt", value: 2000 }] }, sort: [{ field: "due_at", dir: "asc" }], page: { limit: 10 } });
  assert.deepEqual(due.rows.map(r => r.id), [ids[0]], "the due-between question runs over the decrypted table, in process");
  const r = await s.store.update("reminder", ids[1], { done: true }, 1);
  assert.equal(r.version, 2);
  await s.store.remove("note", ids[2], 1);
  assert.equal((await s.store.query("note", { page: { limit: 10 } })).rows.length, 0);
  const disk = everything(dir);
  for (const secret of ["dentist", "Dana Reyes", "Northwind", "invoice", "Prefers email", "due_at", "reminder", "note"]) assert.ok(!disk.includes(secret), `"${secret}" is not on the disk`);
  assert.ok(s.status().used_bytes > 0);
});

test("sealed store: opened again from the identity memory key it holds every record and the change log; another key opens nothing; locked is unreadable", async t => {
  const { backend, imk, s } = await seed(t);
  const before = (await s.store.changes(null, 100)).entries.length;
  s.lock();
  await assert.rejects(() => s.store.get("reminder", ids[0]), { code: "unavailable" });
  assert.equal(s.unlocked, false);
  assert.throws(() => createSealedStore({ backend, identity: "alex", imk: newKey() }), { code: "denied" }, "a wrong key opens nothing");
  assert.throws(() => createSealedStore({ backend, identity: "bob", imk }), { code: "not_found" }, "another identity has no store here");
  // the phone, with the laptop off: it holds the same IMK through its own wrap of the identity home, and opens the same server storage
  const phone = createSealedStore({ backend, identity: "alex", imk });
  assert.equal((await phone.store.get("reminder", ids[1])).data.text, "Send the Northwind invoice");
  assert.equal((await phone.store.changes(null, 100)).entries.length, before);
  assert.deepEqual((await phone.store.types()).map(x => x.name).sort(), ["note", "reminder"]);
});

test("sealed store: only the fixed personal types, and the owner's per-member cap stops writes when the stored bytes reach it", async t => {
  let cap = 0;
  const { s } = await seed(t, { cap: () => cap });
  await assert.rejects(() => s.store.define({ add_types: [{ name: "matter", label: "Matter", fields: [] }] }), { code: "unsupported" });
  assert.ok(PERSONAL_TYPES.includes("task"));
  cap = s.status().used_bytes;
  await assert.rejects(() => s.store.create("note", "0190c3f2-1111-4abc-8def-000000000009", { text: "one more" }), { code: "unavailable" }, "over the cap");
  assert.equal((await s.store.get("reminder", ids[0])).data.text.length > 0, true, "reads still work");
  cap = s.status().used_bytes + 10_000_000;
  await s.store.create("note", "0190c3f2-1111-4abc-8def-000000000009", { text: "now it fits" });
  assert.equal(s.status().cap_bytes, cap);
});

// The suite is what "a store" is: this one passes it like any other. It allows the suite's own types (the fixed-type policy is a layer above the store's rules).
conformance(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-conf-"));
  process.on("exit", () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  return createSealedStore({ backend: new FileBackend(dir), identity: "alex", imk: newKey(), create: true, }).store;
}, { test, assert }, "sealed personal records");

test("sealed store: it reports the suite revision it passes", async t => {
  const { s } = await seed(t);
  const v = await s.store.version();
  assert.equal(v.store, "sealed-personal");
  assert.equal(v.conformance, SUITE_REVISION);
});

test("two devices: the phone opens the same sealed objects on the server by itself, with the laptop off; each sees what the other wrote; a write that lost is refused and the next call reads the winner", async t => {
  const dir = tmp(t), backend = new FileBackend(dir), imk = newKey();
  const laptop = createSealedStore({ backend, identity: "alex", imk, create: true, allow: PERSONAL_TYPES, device: "laptop" });
  await laptop.store.define({ add_types: [REMINDER, NOTE] });
  await laptop.store.create("reminder", ids[0], { text: "Call the dentist", due_at: 1000, done: false });
  laptop.lock();                                                   // the laptop is off
  // the phone: its own process, the same code, the same key from the identity home, the same server objects
  const phone = createSealedStore({ backend, identity: "alex", imk, device: "phone" });
  assert.equal((await phone.store.get("reminder", ids[0])).data.text, "Call the dentist");
  await phone.store.create("reminder", ids[1], { text: "Pick up the keys", due_at: 2000, done: false });
  await phone.store.update("reminder", ids[0], { done: true }, 1);
  // the laptop wakes and sees the phone's work
  const laptop2 = createSealedStore({ backend, identity: "alex", imk, device: "laptop" });
  assert.equal((await laptop2.store.get("reminder", ids[0])).data.done, true);
  assert.equal((await laptop2.store.query("reminder", { page: { limit: 10 } })).rows.length, 2);
  // both online: a write by one is visible to the other on its next call, with no restart
  await laptop2.store.create("note", ids[2], { text: "from the laptop" });
  assert.equal((await phone.store.get("note", ids[2])).data.text, "from the laptop");
  // a race: both read version 2, the laptop writes, then the phone's write on the stale copy is refused
  const gate = backend.putIf.bind(backend);
  let fired = false;
  backend.putIf = (name, bytes, expected) => { if (!fired && name.includes("/rec/")) { fired = true; laptop2.store.update("reminder", ids[1], { text: "the laptop won" }, 1).catch(() => {}); } return gate(name, bytes, expected); };
  await assert.rejects(() => phone.store.update("reminder", ids[1], { text: "the phone lost" }, 1), { code: "version_conflict" });
  backend.putIf = gate;
  assert.equal((await phone.store.get("reminder", ids[1])).data.text, "the laptop won", "the next call reads what the winner wrote");
  // the disk is still ciphertext only
  const disk = everything(dir);
  for (const secret of ["dentist", "keys", "laptop won", "phone lost"]) assert.ok(!disk.includes(secret), secret);
});

import { NODE_PRIMS } from "./sealed.js";
test("sealed store: the cryptographic primitives are injectable (a phone or a browser supplies its own synchronous ones) and the store uses only them", async t => {
  const calls = { seal: 0, open: 0, hkdf: 0, hmac: 0, sha: 0, key: 0 };
  const prims = { newKey: () => { calls.key++; return NODE_PRIMS.newKey(); }, seal: (...a) => { calls.seal++; return NODE_PRIMS.seal(...a); }, open: (...a) => { calls.open++; return NODE_PRIMS.open(...a); },
    hkdf: (...a) => { calls.hkdf++; return NODE_PRIMS.hkdf(...a); }, hmacHex: (...a) => { calls.hmac++; return NODE_PRIMS.hmacHex(...a); }, sha256Hex: (...a) => { calls.sha++; return NODE_PRIMS.sha256Hex(...a); } };
  const { dir, imk } = (() => { const d = tmp(t); return { dir: d, imk: newKey() }; })();
  const s = createSealedStore({ backend: new FileBackend(dir), identity: "alex", imk, create: true, allow: PERSONAL_TYPES, prims });
  await s.store.define({ add_types: [REMINDER] });
  await s.store.create("reminder", ids[0], { text: "x", due_at: 1 });
  assert.equal((await s.store.get("reminder", ids[0])).data.text, "x");
  for (const k of Object.keys(calls)) assert.ok(calls[k] > 0, `${k} went through the injected primitives`);
});
