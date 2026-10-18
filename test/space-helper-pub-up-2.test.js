// The root side of a site's server, second half of the second half: one name is one server, pub-stop's refusal, two starts at once and the forwarding checks. Split from space-helper-pub-up.test.js so each file fits its time budget on a busy host. The rig is test/space-helper-pub-rig.js.
// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { opts } from "./space-helper-rig.js";
import { DEP, DEP2, SPC, SPC2, REQUEST, read, ready } from "./space-helper-pub-rig.js";

test("a name is one server on this box: another Space cannot take over a running server's compose, secrets and data volume, nor stop it, and a newer deployment of the same Space still replaces it", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP, { request: REQUEST({ secrets: "GREETING_PHRASE" }) })).state, "ok");
  assert.equal((await r.up(DEP, { request: REQUEST({ secrets: "GREETING_PHRASE" }), secrets: { GREETING_PHRASE: "first-owner-secret" } })).state, "ok");
  const dir = path.join(r.priv, "apps", "northwind");
  const before = { compose: read(path.join(dir, "compose.yml")), secrets: read(path.join(dir, "secrets.env")), pubdep: read(path.join(dir, "pubdep")), rules: JSON.stringify(r.appFw()) };
  // a second hosted Space builds the same name (its own deployment) and asks to start it
  assert.equal((await r.build(DEP2, { space: SPC2 })).state, "ok", "building is allowed: it takes nothing of the first server");
  const taken = await r.up(DEP2, { space: SPC2, secrets: { GREETING_PHRASE: "the-other-space" } });
  assert.equal(taken.state, "failed", JSON.stringify(taken));
  assert.match(taken.message, /another Space already has a server with that name/);
  assert.deepEqual({ compose: read(path.join(dir, "compose.yml")), secrets: read(path.join(dir, "secrets.env")), pubdep: read(path.join(dir, "pubdep")), rules: JSON.stringify(r.appFw()) }, before, "nothing of the first Space's server changed");
  assert.ok(!read(path.join(dir, "secrets.env")).includes("the-other-space"));
  // it cannot stop or take it down either
  for (const verb of ["pub-stop", "pub-down"]) {
    const st = await r.ask(`${verb} ${DEP2}`);
    assert.equal(st.state, "failed", `${verb}: ${JSON.stringify(st)}`);
    assert.match(st.message, /not the server running under that name/);
  }
  assert.ok(fs.existsSync(path.join(r.F, "app-running-northwind")), "the first Space's server still runs");
  // a folder for a start has to be in the Space the build was made for
  assert.equal((await r.build(DEP2, { request: REQUEST({ version: "4" }), space: SPC })).state, "ok");
  const elsewhere = await r.up(DEP2, { request: REQUEST({ version: "4" }), space: SPC2 });
  assert.equal(elsewhere.state, "failed", JSON.stringify(elsewhere));
  assert.match(elsewhere.message, /not in the Space the server was built for/);
  // the same Space replaces its own server with the newer deployment
  const next = await r.up(DEP2, { request: REQUEST({ version: "4" }), space: SPC });
  assert.equal(next.state, "ok", JSON.stringify(next));
  assert.equal(read(path.join(dir, "pubdep")).trim(), `${DEP2} ${SPC}`);
});

test("pub-stop of a deployment that is not the one running under the name is refused", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  assert.equal((await r.up(DEP)).state, "ok");
  assert.equal((await r.build(DEP2, { request: REQUEST({ version: "4" }) })).state, "ok");
  const st = await r.ask(`pub-stop ${DEP2}`);
  assert.equal(st.state, "failed", JSON.stringify(st));
  assert.match(st.message, /not the server running under that name/);
  assert.ok(fs.existsSync(path.join(r.F, "app-running-northwind")), "the running server was not stopped");
});

test("two starts of one name at once: the second is told to wait and writes nothing, and a lock left by a process that is gone does not block the name", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  const lock = path.join(r.priv, "lock-pub-name.northwind");
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
  const busy = await r.up(DEP);
  assert.equal(busy.state, "failed", JSON.stringify(busy));
  assert.match(busy.message, /another start, stop or removal of that name is running/);
  assert.ok(!fs.existsSync(path.join(r.priv, "apps", "northwind", "compose.yml")), "nothing of the second start was written");
  for (const verb of ["pub-stop", "pub-down"]) assert.match((await r.ask(`${verb} ${DEP}`)).message, /another start, stop or removal/, verb);
  // the process that held it is gone: the lock is stale and cleaned
  fs.writeFileSync(path.join(lock, "pid"), "999999");
  const ok = await r.up(DEP);
  assert.equal(ok.state, "ok", JSON.stringify(ok));
  assert.ok(!fs.existsSync(lock), "the lock is released when the start is over");
});

test("Docker turns forwarding on in the vyre container when it joins a server's network: the helper turns it off again before the server starts", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  r.flag("ip-forward-docker");
  const st = await r.up(DEP);
  assert.equal(st.state, "ok", JSON.stringify(st));
  assert.ok(fs.existsSync(path.join(r.F, "ip-forward-zeroed")), "the helper wrote 0 into the container's network namespace");
});

test("a server is not started when the vyre container forwards packets between its networks, and its compose keeps the log files bounded", opts, async t => {
  const r = await ready(t);
  assert.equal((await r.build(DEP)).state, "ok");
  r.flag("ip-forward-on");
  const st = await r.up(DEP);
  assert.equal(st.state, "failed", JSON.stringify(st));
  assert.match(st.message, /forwards packets between its networks/);
  assert.ok(!fs.existsSync(path.join(r.F, "app-running-northwind")), "nothing started");
  fs.rmSync(path.join(r.F, "ip-forward-on"));
  assert.equal((await r.up(DEP)).state, "ok");
  const compose = read(path.join(r.priv, "apps", "northwind", "compose.yml"));
  for (const want of ["    logging:", "      driver: json-file", '        max-size: "10m"', '        max-file: "3"']) assert.ok(compose.includes(want), want);
});
