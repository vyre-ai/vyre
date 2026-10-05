// The Basic backup: ciphertext only on the server, incremental, resumable, restorable from the recovery code, and the status the app reads.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Backup, noBackup, CHUNK, FRESH_MS } from "./index.js";
import { FileBackend } from "../identity/home.js";
import { newDeviceKey } from "../../../lib/keywrap.js";

const HOUR = 60 * 60 * 1000;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-bk-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const file = (name, data, mtime = 1000) => ({ kind: "file", name, size: Buffer.byteLength(data), mtime, read: async () => Buffer.from(data) });
const rows = (name, data, mtime = 1000) => ({ ...file(name, data, mtime), kind: "rows" });
const everything = dir => { const out = []; const walk = d => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : out.push(fs.readFileSync(p)); } }; walk(dir); return Buffer.concat(out); };

test("backup: the server holds ciphertext only; a second run uploads only what changed; the newest manifest restores everything", async t => {
  const server = new FileBackend(tmp(t));
  const dev = newDeviceKey();
  let now = 10 * HOUR;
  const b = await Backup.create({ backend: server, identity: "me", devices: { phone: dev.publicJwk }, recoveryCode: "correct horse battery", clock: () => now });
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
  // restore on a new device after recovery, from the code alone
  const fresh = await Backup.open({ backend: server, identity: "me", recoveryCode: "correct horse battery" });
  const got = new Map();
  const res = await fresh.restore((e, bytes) => got.set(e.name, bytes.toString("latin1")));
  assert.equal(res.rev, 2);
  assert.deepEqual(res.missing, []);
  assert.equal(got.get("northwind/ledger.txt"), "Dana Reyes owes 0");
  assert.equal(got.get("northwind/big.bin"), big);
  assert.equal(got.get("rows/projects.jsonl"), '{"name":"Northwind Bakery books"}\n');
  await assert.rejects(() => Backup.open({ backend: server, identity: "me", recoveryCode: "wrong" }), /cannot open/);
  // a device key opens it with no prompt; one that was never added cannot
  assert.ok(await Backup.open({ backend: server, identity: "me", holder: "phone", privateJwk: dev.privateJwk }));
  const stranger = newDeviceKey();
  await assert.rejects(() => Backup.open({ backend: server, identity: "me", holder: "laptop", privateJwk: stranger.privateJwk }), /holds no wrap/);
  await b.addDevice("laptop", stranger.publicJwk);
  assert.ok(await Backup.open({ backend: server, identity: "me", holder: "laptop", privateJwk: stranger.privateJwk }));
});

test("backup: an interrupted run leaves the last manifest newest and the next run skips what is already up; retention keeps three; a damaged chunk is named", async t => {
  const server = new FileBackend(tmp(t));
  const dev = newDeviceKey();
  const b = await Backup.create({ backend: server, identity: "me", devices: { phone: dev.publicJwk } });
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
  const res = await (await Backup.open({ backend: server, identity: "me", holder: "phone", privateJwk: dev.privateJwk })).restore(() => {});
  assert.equal(res.missing.length, 1);
  assert.match(res.missing[0].why, /damaged/);
});

test("backup status: ok while nothing older than an hour is missing, behind when it is, none with no team", async t => {
  const server = new FileBackend(tmp(t));
  const dev = newDeviceKey();
  let now = 100 * HOUR;
  const b = await Backup.create({ backend: server, identity: "me", devices: { phone: dev.publicJwk }, clock: () => now });
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
