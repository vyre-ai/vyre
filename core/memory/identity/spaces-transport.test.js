// The sealed store end to end over a REAL daemon's per-member storage (spaces.storage.*): atomic put-if, two devices through the real tools, ciphertext only in the server's folder.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../daemon/index.js";
import { tempHome } from "../../../test/helpers.js";
import { as } from "./test-facts.js";
import { spacesTransport } from "./spaces-transport.js";
import { RemoteBackend } from "./remote-backend.js";
import { openSealedStore, sealedPrefixes, PERSONAL_TYPES } from "../../../kernel/store/sealed.js";
import { newKey } from "../../../lib/keywrap.js";

const REMINDER = { name: "reminder", label: "Reminder", fields: [{ name: "text", kind: "text", label: "Text" }, { name: "due_at", kind: "number", label: "Due" }] };
const id = n => `0190c3f2-1111-4abc-8def-00000000000${n}`;

test("a real put-if against a live space: atomic compare-and-set, then the sealed store from two devices through the real tools; the server's folder holds ciphertext only", async t => {
  const root = fs.realpathSync(tempHome(t));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ recall: { every: 0, vectors: false }, vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const space = d.kernel.id.space;
  const call = (tool, input) => as(d, tool, input, "cli");
  const b64 = s => Buffer.from(s).toString("base64");
  // the raw tool: create (must not exist), refuse a second create, replace only on the sha seen
  const first = await call("spaces.storage.put-if", { space, name: "personal/probe/a", data: b64("one"), expected: null });
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(first.data.ok, true);
  const again = await call("spaces.storage.put-if", { space, name: "personal/probe/a", data: b64("two"), expected: null });
  assert.equal(again.data.ok, false, "must not exist: it does");
  const swap = await call("spaces.storage.put-if", { space, name: "personal/probe/a", data: b64("three"), expected: first.data.sha256 });
  assert.equal(swap.data.ok, true);
  const stale = await call("spaces.storage.put-if", { space, name: "personal/probe/a", data: b64("four"), expected: first.data.sha256 });
  assert.equal(stale.data.ok, false, "a stale sha loses");
  assert.equal(Buffer.from((await call("spaces.storage.get", { space, name: "personal/probe/a" })).data.data, "base64").toString(), "three");
  const del = await call("spaces.storage.delete", { space, name: "personal/probe/a" });
  assert.equal(del.error, undefined, "a delete is never asked or refused here");
  // the sealed store over the real tools: two devices of one person
  const imk = newKey();
  const open = (device, create = false) => openSealedStore({ backend: new RemoteBackend(spacesTransport(call, space), { prefixes: sealedPrefixes("alex") }), identity: "alex", imk, device, allow: PERSONAL_TYPES, create });
  const laptop = await open("laptop", true);
  await laptop.store.define({ add_types: [REMINDER] });
  await laptop.store.create("reminder", id(1), { text: "Call the dentist about Dana Reyes", due_at: 1000 });
  laptop.lock();
  const phone = await open("phone");
  assert.equal((await phone.store.get("reminder", id(1))).data.text, "Call the dentist about Dana Reyes");
  await phone.store.create("reminder", id(2), { text: "Pick up the keys", due_at: 2000 });
  const laptop2 = await open("laptop");
  assert.equal((await laptop2.store.query("reminder", { page: { limit: 10 } })).rows.length, 2);
  // the server's own folder for this person: names and ciphertext, nothing readable
  const all = []; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) { all.push(e.name); walk(f); } else { all.push(e.name); try { all.push(fs.readFileSync(f, "latin1")); } catch { /* a socket */ } } } };
  walk(root);
  const disk = all.join("\n");
  for (const secret of ["Dana Reyes", "dentist", "Pick up the keys"]) assert.ok(!disk.includes(secret), `${secret} is not on the server's disk`);
});
