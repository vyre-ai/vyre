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
