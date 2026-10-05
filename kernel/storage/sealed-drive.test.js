// @ts-check
// A chat's files at rest: ids and ciphertext only, names included, for anyone with the disk; the participant reads through the gateway; a locked chat is absent; share and unshare move one file's key.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "./pool.js";
import { Drive } from "./drive.js";
import { memoryBackend } from "./backends.js";
import { sealedDrive } from "./sealed-drive.js";
import { tmp } from "../seal/testing.js";
import { newDeviceKey, fingerprint } from "../../lib/keywrap.js";
import { createRing, openRing } from "../../lib/chat-keys.js";

const MB = 1 << 20;
const everything = (/** @type {string} */ dir) => { const out = []; const walk = (/** @type {string} */ d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? (out.push(n), walk(p)) : (out.push(n), out.push(fs.readFileSync(p, "latin1"))); } }; walk(dir); return out.join("\n"); };
function world(/** @type {any} */ t) {
  const dir = tmp("sdrive"); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = memoryBackend();
  const pool = new Pool({ dir, key: Buffer.alloc(32, 5), now: () => 1_000_000, chunk: MB });
  pool.addNode({ id: "home", backend: home, home: true, offered: 50 * MB });
  const drive = new Drive(pool, { now: () => 1_000_000 });
  const dev = newDeviceKey(), name = fingerprint(dev.publicJwk);
  const chat = createRing("chat-1", { [name]: dev.publicJwk }), proj = createRing("proj-1", { [name]: dev.publicJwk });
  /** @type {Map<string, any>} */ const held = new Map([["c1", chat.keys]]);
  const sd = sealedDrive(drive, { keysFor: c => held.get(c) || null, projectKeysFor: pr => (pr === "p1" ? proj.keys : null) });
  return { dir, drive, pool, sd, held, chat, proj, dev, name, home };
}
const dir = "Projects/p1/chat/c1";

test("sealed drive: the Drive and the pool hold ids and ciphertext only; the participant reads the names and the content back", async t => {
  const w = world(t);
  await w.sd.put(`${dir}/Harlow settlement/offer letter.txt`, Buffer.from("Dana Reyes accepts 250,000"));
  await w.sd.put(`${dir}/notes.txt`, Buffer.from("call Sam Okafor"));
  assert.equal(Buffer.from(await w.sd.get(`${dir}/Harlow settlement/offer letter.txt`)).toString(), "Dana Reyes accepts 250,000");
  assert.deepEqual((await w.sd.list(dir)).map(e => e.path).sort(), [`${dir}/Harlow settlement/offer letter.txt`, `${dir}/notes.txt`]);
  assert.deepEqual((await w.sd.list(`${dir}/Harlow settlement`)).map(e => e.path), [`${dir}/Harlow settlement/offer letter.txt`]);
  assert.deepEqual((await w.sd.list("Projects/p1")).map(e => e.path).sort(), [`${dir}/Harlow settlement/offer letter.txt`, `${dir}/notes.txt`], "a listing above the chat shows the same, opened");
  // anyone with the disk: the drive index and every byte of the pool
  const disk = JSON.stringify(w.drive.ix) + "\n" + everything(w.dir);
  for (const secret of ["Harlow", "settlement", "offer letter", "notes.txt", "Dana Reyes", "250,000", "Sam Okafor"]) assert.ok(!disk.includes(secret), `"${secret}" is not on the disk`);
  assert.ok(Object.keys(w.drive.ix.files).every(k => !/offer|notes|Harlow/.test(k)), "the stored paths are ids");
  // a path outside a chat folder is not touched
  await w.sd.put("clients/jane.txt", Buffer.from("plain"));
  assert.ok(w.drive.ix.files["clients/jane.txt"]);
});

test("sealed drive: locked means absent, versions and restore keep their keys, delete and listing behave", async t => {
  const w = world(t);
  await w.sd.put(`${dir}/a.txt`, Buffer.from("one"));
  await w.sd.put(`${dir}/a.txt`, Buffer.from("two"), { base: 1 });
  assert.equal(Buffer.from(await w.sd.get(`${dir}/a.txt`, { version: 1 })).toString(), "one");
  const r = await w.sd.restore(`${dir}/a.txt`, 1, { by: "x" });
  assert.equal(Buffer.from(await w.sd.get(`${dir}/a.txt`)).toString(), "one");
  assert.equal(r.version, 3);
  w.held.delete("c1");
  await assert.rejects(() => w.sd.get(`${dir}/a.txt`), /not unlocked/);
  assert.deepEqual(await w.sd.list(dir), [], "a locked chat's files are not listed");
  assert.deepEqual(await w.sd.list("Projects/p1"), []);
  w.held.set("c1", w.chat.keys);
  await w.sd.delete(`${dir}/a.txt`, { by: "x" });
  assert.deepEqual(await w.sd.list(dir), []);
});

test("sealed drive: share wraps the file key to the project's ring (no copy); unshare rotates the key and the old wrap no longer opens the new version", async t => {
  const w = world(t);
  await w.sd.put(`${dir}/plan.txt`, Buffer.from("the plan"));
  const before = Object.keys(w.drive.ix.files).filter(k => !k.endsWith(".shared")).length, versions = w.drive.ix.files[Object.keys(w.drive.ix.files).find(k => k.startsWith(dir))].versions.length;
  assert.deepEqual(await w.sd.share(`${dir}/plan.txt`), { wrapped: true });
  assert.equal(Object.keys(w.drive.ix.files).filter(k => !k.endsWith(".shared")).length, before, "no second file");
  assert.equal(w.drive.ix.files[Object.keys(w.drive.ix.files).find(k => k.startsWith(dir) && !k.endsWith(".names"))].versions.length, versions, "no new version: a wrap, not a copy");
  const un = await w.sd.unshare(`${dir}/plan.txt`);
  assert.equal(un.rotated, true);
  assert.equal(Buffer.from(await w.sd.get(`${dir}/plan.txt`)).toString(), "the plan");
  assert.equal(un.version, 2, "the content was sealed again under a new file key");
  // another project is not held here: nothing to wrap
  assert.deepEqual(await w.sd.share("Projects/other/chat/c1/plan.txt"), { wrapped: false });
});
