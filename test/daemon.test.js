// @ts-check
// The daemon, end to end: start vyred in a temp home, talk to it over its socket as the CLI and
// the Harness hooks will, and check it cleans up after itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { start } from "../core/daemon/index.js";
import { request, call } from "../core/daemon/client.js";
import { tempHome } from "./helpers.js";

test("daemon: answers health, lists the system module and runs its tools", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const h = await request("GET", "/v1/health", undefined, { root });
  assert.equal(h.data.pid, process.pid);
  assert.ok(h.data.modules.running >= 1);
  const tools = (await request("GET", "/v1/tools", undefined, { root })).data.map(x => x.name);
  assert.ok(tools.includes("system.echo"));
  assert.deepEqual(await call("system.echo", { text: "hello" }, { root }), { data: { text: "hello" } });
  assert.match((await call("system.info", {}, { root })).data.version, /^\d+\.\d+\.\d+/);
  const ev = (await request("GET", "/v1/events", undefined, { root })).data;
  assert.ok(ev.some(e => e.type === "system.started"));
});

test("daemon: bad tool input is a 400 with a readable message", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await call("system.echo", {}, { root });
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /text is required/);
});

test("daemon: the socket is private and removed on stop", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.equal(fs.statSync(d.paths.socket).mode & 0o777, 0o600, "other users on the machine could talk to vyred");
  await d.stop();
  assert.equal(fs.existsSync(d.paths.socket), false);
  assert.equal(fs.existsSync(d.paths.pid), false);
});

test("daemon: a second vyred on the same home refuses to start", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await assert.rejects(start({ root, log: () => {} }), /already running/);
});

test("daemon: a stale socket from a crash is cleared, not fatal", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  const sock = d.paths.socket;
  await d.stop();
  fs.writeFileSync(sock, "");            // what a crash leaves behind
  const again = await start({ root, log: () => {} });
  t.after(() => again.stop());
  assert.ok((await request("GET", "/v1/health", undefined, { root })).data);
});

test("client: with no vyred running, calls degrade to an error instead of throwing", async t => {
  const root = tempHome(t);
  const r = await call("system.echo", { text: "x" }, { root });
  assert.equal(r.error.code, "unreachable");
});
