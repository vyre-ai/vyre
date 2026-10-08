// @ts-check
// The sealing process behind a local socket, the way the Windows sealing service (local/capsule/native-win/seal) serves it: one process per connection with the master key handed over in the
// environment, the same NDJSON, the same SealApi, and the process ends with the connection. A unix socket stands in for the named pipe, a few lines of Node for the service.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectSealer } from "./client.js";
import { masterOf, custodyNote, hostCheck } from "./process.js";
import { tmp } from "./testing.js";

const PROCESS = path.join(path.dirname(fileURLToPath(import.meta.url)), "process.js");

/** A stand-in service: a process per connection, the master in its environment, ended with the connection. @returns {Promise<{ path: string, children: import("node:child_process").ChildProcess[], close: () => Promise<void> }>} */
async function service(t, dir, master) {
  const sock = path.join(tmp("sealsock"), "s.sock");
  const children = [];
  const srv = net.createServer(c => {
    const child = spawn(process.execPath, [PROCESS], { stdio: ["pipe", "pipe", "inherit"], env: { VYRE_SEAL_DIR: dir, VYRE_SEAL_DEV: "1", VYRE_SEAL_PROFILE: "windows-service", VYRE_SEAL_MASTER_B64: master.toString("base64"), PATH: process.env.PATH || "" } });
    children.push(child);
    c.pipe(child.stdin); child.stdout.pipe(c);
    c.on("close", () => child.stdin.end()); child.on("exit", () => c.end());
  });
  await new Promise(r => srv.listen(sock, r));
  const close = () => new Promise(r => srv.close(() => r()));
  t.after(async () => { await close(); for (const c of children) c.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { path: sock, children, close };
}

test("a sealing process behind a socket answers the SealApi, keeps what it is given under the master it was handed, and ends with its connection", async t => {
  const dir = tmp("seal"), master = crypto.randomBytes(32);
  const svc = await service(t, dir, master);
  const a = await connectSealer({ pipe: svc.path, timeoutMs: 8000 });
  const h = await a.health();
  assert.equal(h.ok, true);
  assert.equal(h.custody.master, "dpapi-service", "the process says its master came from the service");
  await a.service.put({ name: "twenty/test", value: "sk-test-abc123" });
  assert.equal(await a.service.get({ name: "twenty/test" }), "sk-test-abc123");
  const first = svc.children[0];
  await a.close();
  await new Promise(r => (first.exitCode !== null ? r(0) : first.once("exit", r)));
  assert.notEqual(first.exitCode === null && first.signalCode === null, true, "the process ended with the connection");
  // a second connection: another process, the same master, the same sealed value
  const b = await connectSealer({ pipe: svc.path, timeoutMs: 8000 });
  assert.equal(await b.service.get({ name: "twenty/test" }), "sk-test-abc123");
  assert.notEqual(svc.children[1].pid, first.pid);
  await b.close();
});

test("a process handed a different master cannot open what another master sealed", async t => {
  const dir = tmp("seal");
  const svc = await service(t, dir, crypto.randomBytes(32));
  const a = await connectSealer({ pipe: svc.path, timeoutMs: 8000 });
  await a.service.put({ name: "twenty/test", value: "sk-test-abc123" });
  await a.close();
  await svc.close();
  const svc2 = await service(t, dir, crypto.randomBytes(32));
  const c = await connectSealer({ pipe: svc2.path, timeoutMs: 8000 });
  await assert.rejects(c.service.get({ name: "twenty/test" }));
  await c.close().catch(() => {});
});

test("the master from the service is exactly 32 bytes, is removed from the process's environment once read, and a bad one is refused", () => {
  const env = { VYRE_SEAL_PROFILE: "windows-service", VYRE_SEAL_MASTER_B64: crypto.randomBytes(32).toString("base64") };
  assert.equal(masterOf("/nowhere", env).length, 32);
  for (const bad of ["", "AAAA", Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64")]) assert.throws(() => masterOf("/nowhere", { VYRE_SEAL_PROFILE: "windows-service", VYRE_SEAL_MASTER_B64: bad }), /32-byte master/);
  process.env.VYRE_SEAL_PROFILE = "windows-service"; process.env.VYRE_SEAL_MASTER_B64 = crypto.randomBytes(32).toString("base64");
  try { masterOf("/nowhere"); assert.equal(process.env.VYRE_SEAL_MASTER_B64, undefined, "the variable is gone after it is read"); } finally { delete process.env.VYRE_SEAL_PROFILE; delete process.env.VYRE_SEAL_MASTER_B64; }
});

test("the windows-service profile is accepted only on win32, and its custody note says what a program running as you can still do", () => {
  assert.doesNotThrow(() => hostCheck({ profile: "windows-service", platform: "win32", dev: false }));
  assert.throws(() => hostCheck({ profile: "windows-service", platform: "linux", dev: false }), /own user/);
  const note = custodyNote("windows-service", "win32");
  assert.match(note, /NT SERVICE\\VyreSealer/);
  assert.match(note, /Windows cannot tell it from Vyre/);
});
