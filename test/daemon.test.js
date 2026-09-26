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

import http from "node:http";

/** Read an SSE stream until `n` events arrive. */
function sse(socketPath, pathname, n) {
  return new Promise((resolve, reject) => {
    const got = [];
    const req = http.request({ socketPath, path: pathname, method: "GET" }, res => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        buf += c;
        for (let i; (i = buf.indexOf("\n\n")) >= 0;) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").find(l => l.startsWith("data: "));
          if (data) got.push(JSON.parse(data.slice(6)));
          if (got.length >= n) { req.destroy(); resolve(got); }
        }
      });
    });
    req.on("error", e => { if (got.length < n) reject(e); });
    req.end();
  });
}

test("daemon: the event stream replays the backlog, then goes live, filtered by type", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.events.emit("test", "thread.started", { n: 1 });
  d.events.emit("test", "file.touched", { n: 2 });
  const pending = sse(d.paths.socket, "/v1/events/stream?type=thread.*", 2);
  await new Promise(r => setTimeout(r, 50));
  d.events.emit("test", "thread.stopped", { n: 3 });
  const got = await pending;
  assert.deepEqual(got.map(e => e.payload.n), [1, 3]);
});

test("daemon: stop is not held open by a connected event stream", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  const req = http.request({ socketPath: d.paths.socket, path: "/v1/events/stream", method: "GET" }, res => res.resume());
  req.on("error", () => {});
  req.end();
  await new Promise(r => setTimeout(r, 50));
  const t0 = Date.now();
  await d.stop();
  assert.ok(Date.now() - t0 < 1000, "stop waited on the stream");
});

test("daemon: non-API paths serve the Deck and never anything outside deck/", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const get = p => new Promise(resolve => http.get({ socketPath: d.paths.socket, path: p }, res => { let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const r = await get(p);
    assert.ok(!r.body.includes('"name": "vyre"'), `${p} escaped deck/`);
  }
});
