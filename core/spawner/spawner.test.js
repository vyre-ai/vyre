// @ts-check
// The spawner and its client, as the same uid (no root here): the protocol, what it refuses, the
// environment it passes, and kill. The uid change itself (setpriv) is checked in the box image by
// scripts/e2e-headscale.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serve } from "./server.js";
import { spawnAsAgent } from "./client.js";
import { SCRATCH } from "../../test/scratch.mjs";

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-spawner-"));
  const work = path.join(dir, "work");
  fs.mkdirSync(path.join(work, "northwind"), { recursive: true });
  // Unix socket paths are short: keep it near the root of the scratch folder.
  const socket = path.join(dir, "s.sock");
  const srv = await serve({ socket, allow: ["/bin/sh"], work,
    agent: { uid: 0, gid: 0, groups: [] }, wrap: argv => argv });
  t.after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { socket, work, srv };
}

const collect = stream => new Promise(resolve => { let out = ""; stream.setEncoding("utf8"); stream.on("data", d => (out += d)); stream.on("end", () => resolve(out)); });
const exited = p => new Promise(resolve => p.once("exit", (code, signal) => resolve({ code, signal })));

test("spawner: a session child's stdin, stdout, stderr and exit ride the connections", async t => {
  const { socket, work } = await setup(t);
  const p = await spawnAsAgent(["/bin/sh", "-c", 'read line; echo "got $line"; echo "$VYRE_THREAD ${LD_PRELOAD:-none} $(pwd)"; echo oops >&2; exit 3'],
    { socket, cwd: path.join(work, "northwind"), env: { VYRE_THREAD: "t1", LD_PRELOAD: "/tmp/evil.so", PATH: "/usr/bin:/bin" } });
  assert.ok(Number.isInteger(p.pid) && p.pid > 1);
  const out = collect(p.stdout), err = collect(p.stderr), done = exited(p);
  p.stdin.write("hello\n");
  p.stdin.end();
  assert.deepEqual(await done, { code: 3, signal: null });
  assert.equal(await out, `got hello\nt1 none ${fs.realpathSync(path.join(work, "northwind"))}\n`, "LD_PRELOAD never reaches the child");
  assert.equal(await err, "oops\n");
});

test("spawner: only allowed programs, only under the work folder", async t => {
  const { socket, work } = await setup(t);
  await assert.rejects(spawnAsAgent(["/usr/bin/env", "true"], { socket, cwd: work }), /not a program the spawner starts/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: "/etc" }), /cwd must be under/);
  await assert.rejects(spawnAsAgent(["/bin/sh", "-c", "true"], { socket, cwd: path.join(work, "..", "elsewhere") }), /cwd must be under/);
});

test("spawner: kill ends the child's whole group, including what it left in the background", async t => {
  const { socket, work, srv } = await setup(t);
  const marker = path.join(work, "still-running");
  const p = await spawnAsAgent(["/bin/sh", "-c", `(sleep 2; touch ${marker}) & sleep 30`], { socket, cwd: work });
  const done = exited(p);
  p.kill("SIGTERM");
  const r = await done;
  assert.equal(r.signal, "SIGTERM");
  await new Promise(r2 => setTimeout(r2, 2500));
  assert.ok(!fs.existsSync(marker), "the background child went with the group");
  assert.equal(srv.live(), 0);
});

test("spawner: its socket is the owner's alone", async t => {
  const { socket } = await setup(t);
  assert.equal(fs.statSync(socket).mode & 0o777, 0o600);
});
