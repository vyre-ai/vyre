// @ts-check
// The daemon, end to end: start vyred in a temp home, talk to it over its socket as the CLI and
// the Harness hooks will, and check it cleans up after itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start, REPO } from "../core/daemon/index.js";
import { request, call } from "../core/daemon/client.js";
import { tempHome, writeModule } from "./helpers.js";

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
  // A surface follows the stream from here rather than replaying the whole log.
  const last = (await request("GET", "/v1/health", undefined, { root })).data.last_event;
  assert.equal(last, Math.max(...ev.map(e => e.id)));
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

test("daemon: since=latest skips the backlog and delivers only new events", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.events.emit("test", "thread.started", { n: 1 });
  const pending = sse(d.paths.socket, "/v1/events/stream?since=latest&type=thread.*", 1);
  await new Promise(r => setTimeout(r, 50));
  d.events.emit("test", "thread.stopped", { n: 2 });
  assert.deepEqual((await pending).map(e => e.payload.n), [2]);
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
  // Without the fix, stop() never returns at all (it hangs forever waiting on the
  // connected stream), so the guarantee this test protects is "resolves" vs "hangs",
  // not a particular speed. The bound stays wall-clock (there is no work counter for
  // "an unbounded hang") but is deliberately huge (measured ~5-10ms on this machine)
  // so a busy shared machine running many concurrent suites never trips it by accident.
  assert.ok(Date.now() - t0 < 15000, "stop waited on the stream");
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

test("daemon: a view's own real subfolder falls back to the shell when it has no index.html", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const get = p => new Promise(resolve => http.get({ socketPath: d.paths.socket, path: p }, res => { let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));
  const shell = fs.readFileSync(path.join(REPO, "deck", "index.html"), "utf8");

  // A real subfolder (a view's own, like deck/chat/) but no index.html of its own: the shell,
  // not a 404, since a client-side route may still name a real directory under deck/.
  const bare = path.join(REPO, "deck", "zzz-daemon-test-subfolder");
  fs.mkdirSync(bare, { recursive: true });
  t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
  const noOwn = await get("/zzz-daemon-test-subfolder");
  assert.equal(noOwn.status, 200);
  assert.equal(noOwn.body, shell);

  // The same subfolder, once it has its own index.html, serves that instead.
  fs.writeFileSync(path.join(bare, "index.html"), "<html>own</html>");
  const withOwn = await get("/zzz-daemon-test-subfolder");
  assert.equal(withOwn.status, 200);
  assert.equal(withOwn.body, "<html>own</html>");
});

test("daemon: on the socket, x-vyre-caller is a label and cannot claim another identity", async t => {
  const root = tempHome(t);
  let seen = [];
  const d = await start({ root, log: () => {}, rules: async c => { seen.push(c.caller); return { allow: true }; } });
  t.after(() => d.stop());
  for (const forged of ["module:vault", "tailnet:alex@example.com", "onboard", "hook", "cli", "capsule"]) {
    await call("system.echo", { text: "x" }, { root, caller: forged });
  }
  assert.deepEqual(seen, ["local", "local", "local", "local", "cli", "capsule"]);
  // Naming an agent without that agent's thread key is refused outright, before any rule runs.
  const agent = await call("system.echo", { text: "x" }, { root, caller: "mcp:agent:kit" });
  assert.equal(agent.error && agent.error.code, "denied");
  assert.equal(seen.length, 6);
});

test("client: the first call after vyred restarts reaches the new vyred", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.ok((await call("system.echo", { text: "a" }, { root })).data);
  await d.stop();
  const again = await start({ root, log: () => {} });
  t.after(() => again.stop());
  assert.deepEqual(await call("system.echo", { text: "b" }, { root }), { data: { text: "b" } });
});

test("daemon: no client on the socket can claim to be a module", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  let seen = null;
  d.registry.tools.set("system.whoami", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, run: async (_, { caller }) => { seen = caller; return {}; } });
  await call("system.whoami", {}, { root, caller: "module:vault" });
  assert.equal(seen, "local");
});

test("daemon: a request cannot claim the hook caller to reach a webhook-only tool", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "hooky", { does: { tools: ["hooky.in"] } },
    `export default { async start(ctx) { ctx.tool("hooky.in", { hook: true, run: async () => ({ reached: true }) }); return {}; } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await request("POST", "/v1/tools/hooky.in", {}, { root, caller: "hook" });
  assert.equal(r.error && r.error.code, "no_such_tool");
});
