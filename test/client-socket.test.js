// @ts-check
// Inside a session Vyre started, the client talks on the session's own socket (VYRE_SOCKET, ADR
// 0030 phase 3), and never starts a vyred from there. An explicit root or socket wins.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { call } from "../core/daemon/client.js";
import { ensureUp } from "../core/cli/daemonctl.js";
import { tempHome } from "./helpers.js";
import { SCRATCH } from "./scratch.mjs";

/** A stand-in for a thread's socket that answers every call with which socket it is. */
async function fake(t, name) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "cs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${name}.sock`);
  const server = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { at: name, url: req.url } })); });
  await new Promise(r => server.listen(file, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return file;
}

/** Set env keys for one test. @param {any} t @param {Record<string, string|undefined>} kv */
function env(t, kv) {
  const saved = Object.fromEntries(Object.keys(kv).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(kv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("client: VYRE_SOCKET is used when no root or socket is given; an explicit one wins", async t => {
  const own = await fake(t, "thread");
  const other = await fake(t, "other");
  env(t, { VYRE_SOCKET: own });
  assert.equal((await call("x.y", {})).data.at, "thread");
  assert.equal((await call("x.y", {}, { socket: other })).data.at, "other");
  const root = tempHome(t);
  assert.equal((await call("x.y", {}, { root })).error.code, "unreachable", "an explicit root goes to that home's vyred, not the session's");
});

test("ensureUp: inside a session it never starts a vyred, it only checks the session's socket", async t => {
  const root = tempHome(t);
  env(t, { VYRE_HOME: root, VYRE_THREAD: "t1", VYRE_SOCKET: path.join(SCRATCH, "missing.sock") });
  const r = await ensureUp();
  assert.equal(r.ok, false);
  assert.match(String(r.error), /session's socket/);
  assert.ok(!fs.existsSync(path.join(root, "vyred.pid")), "no vyred was started");
});
