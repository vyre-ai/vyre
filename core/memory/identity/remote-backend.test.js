// The sealed store over a remote member storage: each device keeps a cache and speaks to the server in async steps; the server sees names, ciphertext and shas; two devices never overwrite each other.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { RemoteBackend } from "./remote-backend.js";
import { openSealedStore, PERSONAL_TYPES } from "../../../kernel/store/sealed.js";
import { newKey } from "../../../lib/keywrap.js";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");
/** A server's member storage: objects by name, compare-and-set on the sha. Counts what crosses. */
function server() {
  const objects = new Map(), log = [];
  return { objects, log, transport: {
    async list(prefix) { return [...objects].filter(([n]) => n.startsWith(prefix)).map(([name, b]) => ({ name, sha: sha(b), size: b.length })); },
    async get(name) { log.push(["get", name]); return objects.get(name) || null; },
    async put(name, bytes, { ifMatch }) { const cur = objects.get(name); if ((cur ? sha(cur) : null) !== ifMatch) return { ok: false }; objects.set(name, Buffer.from(bytes)); log.push(["put", name]); return { ok: true }; },
    async delete(name, { ifMatch }) { const cur = objects.get(name); if (cur && sha(cur) !== ifMatch) return { ok: false }; objects.delete(name); return { ok: true }; },
  } };
}
const REMINDER = { name: "reminder", label: "Reminder", fields: [{ name: "text", kind: "text", label: "Text" }, { name: "due_at", kind: "number", label: "Due" }] };
const id = n => `0190c3f2-1111-4abc-8def-00000000000${n}`;
const open = (srv, imk, device, create = false) => openSealedStore({ backend: new RemoteBackend(srv.transport, { prefixes: ["personal/alex"] }), identity: "alex", imk, device, allow: PERSONAL_TYPES, create });

test("remote backend: the laptop creates and goes offline; the phone opens the server's objects alone, writes; the laptop sees it; the server holds ciphertext only", async () => {
  const srv = server(), imk = newKey();
  const laptop = await open(srv, imk, "laptop", true);
  await laptop.store.define({ add_types: [REMINDER] });
  await laptop.store.create("reminder", id(1), { text: "Call the dentist about Dana Reyes", due_at: 1000 });
  laptop.lock();
  const phone = await open(srv, imk, "phone");
  assert.equal((await phone.store.get("reminder", id(1))).data.text, "Call the dentist about Dana Reyes");
  await phone.store.create("reminder", id(2), { text: "Pick up the keys", due_at: 2000 });
  const due = await phone.store.query("reminder", { filter: { and: [{ field: "due_at", op: "gte", value: 1500 }] }, page: { limit: 10 } });
  assert.deepEqual(due.rows.map(r => r.id), [id(2)]);
  const laptop2 = await open(srv, imk, "laptop");
  assert.equal((await laptop2.store.query("reminder", { page: { limit: 10 } })).rows.length, 2);
  // both online: the laptop writes, the phone's next call sees it with no restart
  await laptop2.store.update("reminder", id(2), { text: "Pick up the keys and the car" }, 1);
  assert.equal((await phone.store.get("reminder", id(2))).data.text, "Pick up the keys and the car");
  // the server: names and ciphertext, nothing readable
  const all = [...srv.objects].map(([n, b]) => n + "\n" + b.toString("latin1")).join("\n");
  for (const s of ["dentist", "Dana Reyes", "keys", "reminder", "text"]) assert.ok(!all.includes(s), s);
});

test("remote backend: a write that lost the race is refused as version_conflict, nothing is overwritten, and the next call reads the winner", async () => {
  const srv = server(), imk = newKey();
  const a = await open(srv, imk, "laptop", true);
  await a.store.define({ add_types: [REMINDER] });
  await a.store.create("reminder", id(1), { text: "one", due_at: 1 });
  const b = await open(srv, imk, "phone");
  assert.equal((await b.store.get("reminder", id(1))).version, 1);
  // the phone is about to write on version 1; the laptop gets there first, between the phone's read and its send
  const realPut = srv.transport.put;
  let once = true;
  srv.transport.put = async (name, bytes, o) => { if (once && name.includes("/rec/")) { once = false; srv.transport.put = realPut; await a.store.update("reminder", id(1), { text: "laptop won" }, 1); } return realPut(name, bytes, o); };
  await assert.rejects(() => b.store.update("reminder", id(1), { text: "phone lost" }, 1), { code: "version_conflict" });
  assert.equal((await b.store.get("reminder", id(1))).data.text, "laptop won");
  assert.equal((await a.store.get("reminder", id(1))).data.text, "laptop won", "the winner's write is intact");
});
