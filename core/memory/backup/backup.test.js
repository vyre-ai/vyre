// The Personal backup: ciphertext only on the server, incremental, resumable, restorable from the recovery code, and the status the app reads.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup, noBackup, CHUNK, FRESH_MS } from "./index.js";
import { FileBackend } from "../identity/home.js";
import { newKey } from "../../../lib/keywrap.js";
import { IdentityHome } from "../identity/home.js";
import { newDeviceKey } from "../../../lib/keywrap.js";

const HOUR = 60 * 60 * 1000;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bk-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const file = (name, data, mtime = 1000) => ({ kind: "file", name, size: Buffer.byteLength(data), mtime, read: async () => Buffer.from(data) });
const rows = (name, data, mtime = 1000) => ({ ...file(name, data, mtime), kind: "rows" });
const everything = dir => { const out = []; const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(fs.readFileSync(p)); } }; walk(dir); return Buffer.concat(out); };

test("backup: the server holds ciphertext only; a second run uploads only what changed; the newest manifest restores everything", async t => {
  const server = new FileBackend(tmp(t));
  const imk = newKey();
  let now = 10 * HOUR;
  const b = await Backup.create({ backend: server, identity: "me", imk, clock: () => now });
  const big = Buffer.alloc(CHUNK + 100, 7).toString("latin1");
  const items = [rows("rows/projects.jsonl", '{"name":"Northwind Bakery books"}\n'), file("northwind/ledger.txt", "Dana Reyes owes 4,200"), file("northwind/big.bin", big)];
  const r1 = await b.run(items);
  assert.equal(r1.rev, 1);
  assert.equal(r1.uploaded, 4, "two small items and the two chunks of the big one");
  const blob = everything(server.dir).toString("latin1");
  assert.ok(!blob.includes("Northwind") && !blob.includes("Dana Reyes") && !blob.includes("ledger"), "no name or content in the clear on the server");
  // second run: one file changed
  now += HOUR;
  const r2 = await b.run([items[0], file("northwind/ledger.txt", "Dana Reyes owes 0", 2000), items[2]]);
  assert.equal(r2.rev, 2);
  assert.equal(r2.reused, 2);
  assert.equal(r2.uploaded, 1, "only the changed file's chunk goes up");
  // restore: whoever holds the identity memory key (a device's key or the recovery code open the home that gives it)
  const fresh = await Backup.open({ backend: server, identity: "me", imk });
  const got = new Map();
  const res = await fresh.restore((e, bytes) => got.set(e.name, bytes.toString("latin1")));
  assert.equal(res.rev, 2);
  assert.deepEqual(res.missing, []);
  assert.equal(got.get("northwind/ledger.txt"), "Dana Reyes owes 0");
  assert.equal(got.get("northwind/big.bin"), big);
  assert.equal(got.get("rows/projects.jsonl"), '{"name":"Northwind Bakery books"}\n');
  await assert.rejects(() => Backup.open({ backend: server, identity: "me", imk: newKey() }), /does not open/);
});

test("backup: every device in the identity's list opens it, a device added later opens it at once, and the recovery code restores it onto a new device", async t => {
  const server = new FileBackend(tmp(t));
  const phone = newDeviceKey(), laptop = newDeviceKey(), fresh = newDeviceKey();
  const home = new IdentityHome({ id: "me", backend: server });
  const lease = home.create({ devices: [{ label: "phone", publicJwk: phone.publicJwk }], recoveryCode: "correct horse battery" });
  const imkOf = l => Buffer.from(l.key());
  const onPhone = await Backup.create({ backend: server, identity: "me", imk: imkOf(await home.unlockWithDevice(phone)) });
  await onPhone.run([file("a.txt", "from the phone")]);
  // a second device is added to the identity home: it opens the backup and backs up too, with no second ring to keep in step
  home.addDevice(lease, { label: "laptop", publicJwk: laptop.publicJwk });
  const onLaptop = await Backup.open({ backend: server, identity: "me", imk: imkOf(await home.unlockWithDevice(laptop)) });
  assert.equal((await onLaptop.run([file("a.txt", "from the phone"), file("b.txt", "from the laptop")])).rev, 2);
  // a device that was never added is refused by the home itself
  await assert.rejects(() => home.unlockWithDevice(fresh), { code: "unknown_key" });
  // everything is lost but the code: a new device restores from it
  const got = new Map();
  const restored = await (await Backup.open({ backend: server, identity: "me", imk: imkOf(home.unlockWithCode("correct horse battery")) })).restore((e, bytes) => got.set(e.name, bytes.toString()));
  assert.deepEqual([...got.keys()].sort(), ["a.txt", "b.txt"]);
  assert.equal(restored.missing.length, 0);
  assert.throws(() => home.unlockWithCode("wrong words"), /cannot open/);
});

test("backup: two runs at once do not lose data (one run at a time, here and across devices), and the manifest is written only when every chunk is on the server", async t => {
  const server = new FileBackend(tmp(t));
  const imk = newKey();
  const a = await Backup.create({ backend: server, identity: "me", imk });
  const b = await Backup.open({ backend: server, identity: "me", imk });
  const items = [file("one.txt", "1"), file("two.txt", "22"), file("three.txt", "333")];
  // the same instance: a second call while one runs gets the same run
  const first = a.run(items), second = a.run(items);
  assert.equal(first, second, "the same run");
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.rev, r2.rev);
  // another device holds the lease: this one is refused as busy and trims nothing under it
  server.put("backup/me/lock.json", JSON.stringify({ by: "another-device", until: Date.now() + 60_000 }));
  await assert.rejects(() => a.run([...items, file("four.txt", "4444")]), /already running/);
  server.delete("backup/me/lock.json");
  const r3 = await a.run([...items, file("four.txt", "4444")]);
  assert.equal(r3.rev, 2);
  const res = await (await Backup.open({ backend: server, identity: "me", imk })).restore(() => {});
  assert.deepEqual(res.missing, []);
  assert.equal(res.restored, 4);
  // the lease is released: the other device may run now
  assert.equal((await b.run(items)).rev, 3);
  // a chunk lost from the server before the manifest is written fails the run instead of writing a manifest that names it
  const realPut = server.put.bind(server);
  server.put = (name, bytes) => { realPut(name, bytes); if (name.includes("/chunks/")) server.delete(name); };
  await assert.rejects(() => a.run([file("new.txt", "x", 9999)]), /not on the server/);
  server.put = realPut;
  assert.equal((await a.latest()).rev, 3, "no manifest was written");
  assert.equal((await a.run([file("new.txt", "x", 9999)])).rev, 4, "the next run uploads it again");
});

test("backup: an interrupted run leaves the last manifest newest and the next run skips what is already up; retention keeps three; a damaged chunk is named", async t => {
  const server = new FileBackend(tmp(t));
  const imk = newKey();
  const b = await Backup.create({ backend: server, identity: "me", imk });
  await b.run([file("a.txt", "one")]);
  // the second run dies after uploading the first of two new items, before the manifest
  let died = false;
  const flaky = server;
  const realPut = flaky.put.bind(flaky);
  flaky.put = (name, bytes) => { if (name.includes("/manifests/")) { died = true; throw new Error("network went away"); } return realPut(name, bytes); };
  await assert.rejects(() => b.run([file("a.txt", "one"), file("b.txt", "two"), file("c.txt", "three")]), /network went away/);
  assert.ok(died);
  assert.equal((await b.latest()).rev, 1, "the previous manifest is still the newest");
  assert.equal((await b.status([file("a.txt", "one")], "Team")).state, "behind", "the last attempt failed");
  flaky.put = realPut;
  const r = await b.run([file("a.txt", "one"), file("b.txt", "two"), file("c.txt", "three")]);
  assert.equal(r.uploaded, 0, "b and c were already up");
  assert.equal(r.rev, 2);
  for (let i = 0; i < 4; i++) await b.run([file("a.txt", `v${i}`, 5000 + i)]);
  assert.equal(server.list("backup/me/manifests").length, 3, "the last three manifests stay");
  // damage a chunk the newest manifest names
  const m = await b.latest();
  fs.writeFileSync(server.path(`backup/me/chunks/${m.items[0].chunks[0]}`), "{}");
  const res = await (await Backup.open({ backend: server, identity: "me", imk })).restore(() => {});
  assert.equal(res.missing.length, 1);
  assert.match(res.missing[0].why, /damaged/);
});

test("backup status: ok while nothing older than an hour is missing, behind when it is, none with no team", async t => {
  const server = new FileBackend(tmp(t));
  let now = 100 * HOUR;
  const b = await Backup.create({ backend: server, identity: "me", imk: newKey(), clock: () => now });
  const a = file("a.txt", "one", now - 3 * HOUR);
  assert.equal((await b.status([a], "Acme")).state, "behind", "an old file never backed up");
  await b.run([a]);
  const s1 = await b.status([a], "Acme");
  assert.deepEqual(s1, { to: "Acme", last: now, state: "ok" });
  const fresh = file("new.txt", "x", now - 10 * 60 * 1000);
  assert.equal((await b.status([a, fresh], "Acme")).state, "ok", "a change from ten minutes ago may wait");
  now += FRESH_MS + 1;
  assert.equal((await b.status([a, fresh], "Acme")).state, "behind", "now it is over an hour old and still missing");
  await b.run([a, fresh]);
  assert.equal((await b.status([a, fresh], "Acme")).state, "ok");
  assert.deepEqual(noBackup(), { to: null, last: null, state: "none" });
});
