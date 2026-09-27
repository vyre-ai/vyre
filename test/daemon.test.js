// @ts-check
// The daemon, end to end: start vyred in a temp home, talk to it over its socket as the CLI and
// the Harness hooks will, and check it cleans up after itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { request, call } from "../core/daemon/client.js";
import { tempHome, writeModule } from "./helpers.js";

test("daemon: answers health, lists the system module and runs its tools", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const h = await request("GET", "/v1/health", undefined, { root });
  assert.equal(h.data.pid, process.pid);
  assert.ok(h.data.modules.running >= 1);
  const tools = (await request("GET", "/v1/tools", undefined, { root })).data.map(x => x.name);
  assert.ok(tools.includes("system.echo"));
  assert.deepEqual(await call("system.echo", { text: "hello" }, { root }), { data: { text: "hello" } });
  const info = (await call("system.info", {}, { root })).data;
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(info.owner, { name: null }, "no name before onboarding step 1");
  assert.deepEqual(info.assistant, { name: null }, "no assistant name before onboarding: surfaces say Vyre");
  const ev = (await request("GET", "/v1/events", undefined, { root })).data;
  assert.ok(ev.some(e => e.type === "system.started"));
  // A surface follows the stream from here rather than replaying the whole log.
  const last = (await request("GET", "/v1/health", undefined, { root })).data.last_event;
  assert.equal(last, Math.max(...ev.map(e => e.id)));
});

test("daemon: bad tool input is a 400 with a readable message", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await call("system.echo", {}, { root });
  assert.equal(r.error.code, "bad_input");
  assert.match(r.error.message, /text is required/);
});

test("daemon: the socket is private and removed on stop", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.equal(fs.statSync(d.paths.socket).mode & 0o777, 0o600, "other users on the machine could talk to vyred");
  await d.stop();
  assert.equal(fs.existsSync(d.paths.socket), false);
  assert.equal(fs.existsSync(d.paths.pid), false);
});

test("daemon: a second vyred on the same home refuses to start", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await assert.rejects(start({ root, log: () => {} }), /already running/);
});

test("daemon: a stale socket from a crash is cleared, not fatal", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  const sock = d.paths.socket;
  await d.stop();
  fs.writeFileSync(sock, "");            // what a crash leaves behind
  const again = await start({ root, log: () => {} });
  t.after(() => again.stop());
  assert.ok((await request("GET", "/v1/health", undefined, { root })).data);
});

test("client: with no vyred running, calls degrade to an error instead of throwing", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const r = await call("system.echo", { text: "x" }, { root });
  assert.equal(r.error.code, "unreachable");
});

import http from "node:http";

/**
 * Read an SSE stream until `n` events arrive. `onOpen`, if given, fires as soon as the response
 * headers land — the daemon flushes those the moment it has registered its live listener (see
 * core/daemon/index.js `stream()`), so this is the one reliable signal that emitting now will be
 * seen, instead of a caller guessing with a fixed sleep and losing the event to a race on a
 * loaded machine.
 *
 * Has its own hard timeout: without one, a daemon-side regression that drops or delays an event
 * turns into this promise never settling, which hangs its test forever and, with it, the whole
 * suite behind it — exactly the failure mode this helper exists to catch, not hide.
 */
function sse(socketPath, pathname, n, { onOpen, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const got = [];
    const req = http.request({ socketPath, path: pathname, method: "GET" }, res => {
      if (onOpen) onOpen();
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", c => {
        buf += c;
        for (let i; (i = buf.indexOf("\n\n")) >= 0;) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").find(l => l.startsWith("data: "));
          if (data) got.push(JSON.parse(data.slice(6)));
          if (got.length >= n) { clearTimeout(timer); req.destroy(); resolve(got); }
        }
      });
    });
    req.on("error", e => { if (got.length < n) { clearTimeout(timer); reject(e); } });
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`sse: only ${got.length}/${n} events on ${pathname} within ${timeout}ms`));
    }, timeout);
    req.end();
  });
}

test("daemon: the event stream replays the backlog, then goes live, filtered by type", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.events.emit("test", "thread.started", { n: 1 });
  d.events.emit("test", "file.touched", { n: 2 });
  // Wait for the response headers, not a fixed sleep, before emitting the event this test
  // expects to arrive live: on a loaded machine a guessed sleep can fire before the daemon has
  // actually registered its live listener, and the emitted event is then lost for good (see
  // core/daemon/index.js `stream()`, which now flushes headers exactly when that listener goes
  // live, precisely so this signal exists).
  let connected;
  const opened = new Promise(r => { connected = r; });
  const pending = sse(d.paths.socket, "/v1/events/stream?type=thread.*", 2, { onOpen: connected });
  await opened;
  d.events.emit("test", "thread.stopped", { n: 3 });
  const got = await pending;
  assert.deepEqual(got.map(e => e.payload.n), [1, 3]);
});

test("daemon: since=latest skips the backlog and delivers only new events", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  d.events.emit("test", "thread.started", { n: 1 });
  let connected;
  const opened = new Promise(r => { connected = r; });
  const pending = sse(d.paths.socket, "/v1/events/stream?since=latest&type=thread.*", 1, { onOpen: connected });
  await opened;
  d.events.emit("test", "thread.stopped", { n: 2 });
  assert.deepEqual((await pending).map(e => e.payload.n), [2]);
});

test("daemon: stop is not held open by a connected event stream", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  const req = http.request({ socketPath: d.paths.socket, path: "/v1/events/stream", method: "GET" }, res => res.resume());
  req.on("error", () => {});
  t.after(() => req.destroy());
  const opened = new Promise(resolve => req.once("response", resolve));
  req.end();
  await opened;
  const t0 = Date.now();
  await d.stop();
  // Without the fix, stop() never returns at all (it hangs forever waiting on the
  // connected stream), so the guarantee this test protects is "resolves" vs "hangs",
  // not a particular speed. The bound stays wall-clock (there is no work counter for
  // "an unbounded hang") but is deliberately huge (measured ~5-10ms on this machine)
  // so a busy shared machine running many concurrent suites never trips it by accident. The
  // test's own { timeout } above is the backstop if stop() regresses to hanging outright.
  assert.ok(Date.now() - t0 < 15000, "stop waited on the stream");
});

test("daemon: non-API paths serve the Deck and never anything outside deck/", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const get = p => new Promise(resolve => http.get({ socketPath: d.paths.socket, path: p }, res => { let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const r = await get(p);
    assert.ok(!r.body.includes('"name": "vyre"'), `${p} escaped deck/`);
  }
});

test("daemon: a real directory under deck/ with no index.html of its own still gets the shell", { timeout: 20_000 }, async t => {
  // A view's own folder (deck/chat/, holding JS modules a view imports, not a page) is a real
  // directory. Before this fix, a bare request for it 404'd instead of falling back to the one
  // shell every client route shares, the way a path that is not a file at all already did.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "deck");
  const probe = path.join(dir, "_daemon-test-no-index");
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, "module.js"), "// not a page");
  t.after(() => fs.rmSync(probe, { recursive: true, force: true }));

  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const get = p => new Promise(resolve => http.get({ socketPath: d.paths.socket, path: p }, res => { let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));

  const shell = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const r = await get("/_daemon-test-no-index");
  assert.equal(r.status, 200);
  assert.equal(r.body, shell);
  // A real file in that directory is still served as itself, not the shell.
  const mod = await get("/_daemon-test-no-index/module.js");
  assert.equal(mod.status, 200);
  assert.equal(mod.body, "// not a page");
});

test("daemon: on the socket, x-vyre-caller is a label and cannot claim another identity", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  let seen = [];
  // Modules' own calls (Memory's curator, on its timer) go through the rules too; only the socket's count here.
  const d = await start({ root, log: () => {}, rules: async c => { if (!String(c.caller).startsWith("module:")) seen.push(c.caller); return { allow: true }; } });
  t.after(() => d.stop());
  for (const forged of ["module:vault", "tailnet:alex@example.com", "onboard", "hook", "cli", "capsule"]) {
    await call("system.echo", { text: "x" }, { root, caller: forged });
  }
  assert.deepEqual(seen, ["anonymous", "anonymous", "anonymous", "anonymous", "cli", "capsule"]);
  // Naming an agent without that agent's thread key is refused outright, before any rule runs.
  const agent = await call("system.echo", { text: "x" }, { root, caller: "mcp:agent:kit" });
  assert.equal(agent.error && agent.error.code, "denied");
  assert.equal(seen.length, 6);
});

test("daemon: a socket request with no caller label is anonymous, not a person", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  let seen = null;
  d.registry.tools.set("system.whoami", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, run: async (_, { caller }) => { seen = caller; return {}; } });
  const http = await import("node:http");
  const { paths } = await import("../core/config/index.js");
  await new Promise((resolve, reject) => {
    const r = http.request({ socketPath: paths(root).socket, path: "/v1/tools/system.whoami", method: "POST", headers: { "content-type": "application/json" } }, res => { res.resume(); res.on("end", resolve); });
    r.on("error", reject); r.end("{}");
  });
  assert.equal(seen, "anonymous");
});

test("client: the first call after vyred restarts reaches the new vyred", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  assert.ok((await call("system.echo", { text: "a" }, { root })).data);
  await d.stop();
  const again = await start({ root, log: () => {} });
  t.after(() => again.stop());
  assert.deepEqual(await call("system.echo", { text: "b" }, { root }), { data: { text: "b" } });
});

test("daemon: no client on the socket can claim to be a module", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  let seen = null;
  d.registry.tools.set("system.whoami", { module: "system", description: "", input: { type: "object" }, internal: false, callers: null, run: async (_, { caller }) => { seen = caller; return {}; } });
  await call("system.whoami", {}, { root, caller: "module:vault" });
  assert.equal(seen, "anonymous");
});

test("daemon: a request cannot claim the hook caller to reach a webhook-only tool", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "hooky", { does: { tools: ["hooky.in"] } },
    `export default { async start(ctx) { ctx.tool("hooky.in", { hook: true, run: async () => ({ reached: true }) }); return {}; } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const r = await request("POST", "/v1/tools/hooky.in", {}, { root, caller: "hook" });
  assert.equal(r.error && r.error.code, "no_such_tool");
});

import crypto from "node:crypto";
import { inputHash } from "../core/presence/index.js";

/** A raw request on the socket with whatever headers a client cares to forge. */
function raw(socketPath, pathname, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ socketPath, path: pathname, method: "POST", agent: false,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, res => {
      let buf = "";
      res.on("data", c => { buf += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(buf) }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("daemon: vyred checks presence, so a forged caller cannot run a human-only tool, and a Capsule signature can", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "held", { does: { tools: ["held.release"] } },
    `export default { async start(ctx) { ctx.tool("held.release", { presence: true, input: { type: "object" }, run: async i => ({ released: i.id }) }); return {}; } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const sock = d.paths.socket;
  const input = { id: "a1" };
  for (const caller of ["cli", "capsule", "deck", "local", "mcp:agent:assistant"]) {
    const r = await raw(sock, "/v1/tools/held.release", input, { "x-vyre-caller": caller });
    assert.equal(r.status, 403, `${caller} got ${r.status}`);
    // An unvouched agent claim is refused before presence is asked (the Switchboard's key check).
    assert.equal(r.body.error.code, caller.includes("agent:") ? "denied" : "presence_required", caller);
  }
  // The floor's list applies too: presence's own tools are refused without a proof.
  assert.equal((await raw(sock, "/v1/tools/presence.code", {}, { "x-vyre-caller": "cli" })).body.error.code, "presence_required");
  const tools = (await request("GET", "/v1/tools", undefined, { root })).data;
  assert.equal(tools.find(x => x.name === "held.release").presence, true);

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  d.registry.deps.db.prepare("INSERT INTO presence_keys (id, kind, name, public_key, alg, sign_count, created) VALUES (?,?,?,?,?,0,?)")
    .run("capsule-test", "capsule", "Capsule", publicKey.export({ format: "der", type: "spki" }).toString("base64url"), -8, Date.now());
  const sign = (tool, inp) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign(null, Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(inp)}\n${ts}\n${nonce}`), privateKey).toString("base64url");
    return `capsule key=capsule-test ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const header = sign("held.release", input);
  const ok = await raw(sock, "/v1/tools/held.release", input, { "x-vyre-caller": "capsule", "x-vyre-presence": header });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { data: { released: "a1" } });
  const replay = await raw(sock, "/v1/tools/held.release", input, { "x-vyre-caller": "capsule", "x-vyre-presence": header });
  assert.equal(replay.status, 403, "a Capsule proof was replayed");
  const other = await raw(sock, "/v1/tools/held.release", { id: "b2" }, { "x-vyre-caller": "capsule", "x-vyre-presence": sign("held.release", input) });
  assert.equal(other.status, 403, "a proof for a1 released b2");
  const ev = d.events.since(0).filter(e => e.source === "presence").map(e => e.type);
  assert.ok(ev.includes("presence.proved") && ev.includes("presence.refused"));
});

test("daemon: the presence challenge route refuses what it cannot start", async t => {
  const root = tempHome(t);
  // A terminal code is for a Mac (a box takes passkeys only), and Linux defaults to the box.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local" }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const sock = d.paths.socket;
  assert.equal((await raw(sock, "/v1/presence/challenge", { tool: "nope.none", input: {}, method: "tty", tty: "/dev/ttys003" }, {})).status, 404);
  assert.equal((await raw(sock, "/v1/presence/challenge", { tool: "presence.code", input: {}, method: "tty", tty: "/etc/passwd" }, {})).status, 400);
  assert.equal((await raw(sock, "/v1/presence/challenge", { tool: "presence.code", input: {}, method: "passkey" }, {})).status, 400);
  assert.equal((await raw(sock, "/v1/presence/challenge", { tool: "presence.code", input: {}, method: "tty", tty: "/dev/ttys999" }, {})).status, 403);
});

test("daemon: every non-person call passes the floor's rules, not only Claude Code's hook (SPEC 5.3)", async t => {
  const root = tempHome(t);
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.echo"] } }, `export default { async start(ctx) {
    ctx.tool("probe.echo", { input: { type: "object", properties: { path: { type: "string" }, command: { type: "string" } } }, run: async input => ({ got: input }) });
    return { async stop() {} };
  } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const secret = { path: path.join(root, "vault", "items", "x.json") };
  const approve = { command: "vyre gate approve 7" };
  // An agent, however it arrives: its MCP server, the switchboard's harness, the Capsule on its behalf.
  for (const caller of ["mcp", "mcp:agent:kit", "harness:agent:kit", "capsule:agent:kit", "tailnet:agent:kit", "tailnet-guest:sam@example.com"]) {
    const r = await d.registry.call("probe.echo", secret, caller);
    assert.equal(r.error?.code, "denied", `${caller} reached the vault folder`);
    assert.match(r.error.message, /vault values off every screen/);
    assert.equal((await d.registry.call("probe.echo", approve, caller)).error?.code, "denied", `${caller} ran a human-only command`);
    assert.deepEqual((await d.registry.call("probe.echo", { path: "/tmp/notes.txt" }, caller)).data, { got: { path: "/tmp/notes.txt" } }, "anything else runs");
  }
  // The same through the socket, as the MCP server calls it.
  assert.equal((await call("probe.echo", secret, { root, caller: "mcp" })).error?.code, "denied");
  // A module is not a person either.
  assert.equal((await d.registry.call("probe.echo", secret, "module:notes")).error?.code, "denied");
  // A person at their own surface is not held here; presence and the Gate speak for them.
  // On a box the owner's Deck and phone arrive as tailnet:<owner>, a person at their own surface.
  for (const caller of ["cli", "local", "deck", "capsule", "tailnet:alex@example.com"]) assert.ok((await d.registry.call("probe.echo", secret, caller)).data, caller);
});

test("daemon: system.info names the owner as onboarding saved them, for a device's avatar", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ onboard: { person: "Alex Rivera", assistant: "juno" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const info = (await call("system.info", {}, { root })).data;
  assert.deepEqual(info.owner, { name: "Alex Rivera" });
  assert.deepEqual(info.assistant, { name: "juno" }, "replies are labelled with the assistant's name");
});

test("daemon: /theme.css serves config's theme.colors, read on every request", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const get = () => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: "/theme.css" }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ type: res.headers["content-type"], body: b }));
  }).on("error", reject));
  const before = /** @type {any} */ (await get());
  assert.equal(before.type, "text/css");
  assert.doesNotMatch(before.body, /--/);
  const cfgPath = path.join(root, "config.json");
  const cur = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf8")) : {};
  fs.writeFileSync(cfgPath, JSON.stringify({ ...cur, theme: { colors: { dark: { signal: "#B4E35A" } } } }));
  assert.match(/** @type {any} */ (await get()).body, /--signal: #B4E35A;/);
});
