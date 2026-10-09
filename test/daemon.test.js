// @ts-check
// The daemon, end to end: start vyred in a temp home, talk to it over its socket as the CLI and
// the Harness hooks will, and check it cleans up after itself.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start, retryUnknown } from "../core/daemon/index.js";
import { htmlWithBuild } from "../core/daemon/build.js";
import { request, call } from "../core/daemon/client.js";
import { tempHome, writeModule } from "./helpers.js";

test("daemon: retryUnknown gives a /proc TOCTOU race a second look, bounded, still failing closed", async () => {
  // A flat unknown (no named server) succeeds on a later attempt: the race resolved, trusted.
  const calls1 = [{ unknown: true }, { inside: false }];
  assert.deepEqual(await retryUnknown(() => calls1.shift(), 2, 1), { inside: false });

  // Every attempt agrees it's unknown: still unknown after exhausting attempts, never more than
  // asked (2 retries -> 3 calls total, not stretched into a long hang).
  let n = 0;
  assert.deepEqual(await retryUnknown(() => { n++; return { unknown: true }; }, 2, 1), { unknown: true });
  assert.equal(n, 3, "the first try plus exactly 2 retries, never more");

  // A NAMED server (the terminal-host allowlist's other unknown shape) is not a race: never
  // retried, returned as-is on the first call.
  let calledOnce = 0;
  const server = { unknown: true, server: { exe: "/usr/bin/tmux", pid: 1, started: "t" } };
  assert.deepEqual(await retryUnknown(() => { calledOnce++; return server; }, 2, 1), server);
  assert.equal(calledOnce, 1);

  // A definite answer (inside:true, or inside:false with no unknown) is never retried either.
  let definiteCalls = 0;
  assert.deepEqual(await retryUnknown(() => { definiteCalls++; return { inside: true, by: 42 }; }, 2, 1), { inside: true, by: 42 });
  assert.equal(definiteCalls, 1);
});

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
  // owner.id's fingerprints ride along (anywhere, ADR 0043 2f): base64url, 8 bytes; never the id itself.
  assert.equal(info.owner.name, null, "no name before onboarding step 1");
  assert.ok(info.owner.fingerprint8 == null || /^[A-Za-z0-9_-]{11}$/.test(info.owner.fingerprint8), String(info.owner.fingerprint8));
  assert.ok(!("id" in info.owner), "owner.id never leaves the box");
  assert.equal(info.assistant.name, null, "no assistant name before onboarding: surfaces say Vyre");
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

test("daemon: non-API paths serve the app and web/ and never anything outside them", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const get = p => new Promise(resolve => http.get({ socketPath: d.paths.socket, path: p }, res => { let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b })); }));
  for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json"]) {
    const r = await get(p);
    assert.ok(!r.body.includes('"name": "vyre"'), `${p} escaped web/`);
  }
});

test("daemon: on the socket, x-vyre-caller is a label and cannot claim another identity", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  let seen = [];
  // Modules' own calls (Memory's curator, on its timer) go through the rules too; only the socket's count here.
  const d = await start({ root, log: () => {}, rules: async c => { if (!String(c.caller).startsWith("module:")) seen.push(c.caller); return { allow: true }; } });
  t.after(() => d.stop());
  for (const forged of ["module:vault", "tailnet:alex@example.com", "onboard", "hook", "setup:aaaaaaaaaaaaaaaa", "web:aaaaaaaaaaaaaaaa", "space:alex@harlow", "invitee:aaaaaaaaaaaaaaaa", "link:x", "setup", "web", "device", "cli", "capsule"]) {
    await call("system.echo", { text: "x" }, { root, caller: forged });
  }
  assert.deepEqual(seen, [...Array(12).fill("anonymous"), "cli", "capsule"]);
  // Naming an agent without that agent's thread key is refused outright, before any rule runs.
  const agent = await call("system.echo", { text: "x" }, { root, caller: "mcp:agent:kit" });
  assert.equal(agent.error && agent.error.code, "denied");
  assert.equal(seen.length, 14);
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
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
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
  writeModule(path.join(root, "modules"), "held", { does: { tools: [{ name: "held.release", outward: true }] } },
    `export default { async start(ctx) { ctx.tool("held.release", { effect: "read", presence: true, input: { type: "object" }, run: async i => ({ released: i.id }) }); return {}; } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
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

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  d.registry.deps.db.prepare("INSERT INTO presence_keys (id, kind, name, public_key, alg, sign_count, created) VALUES (?,?,?,?,?,0,?)")
    .run("capsule-test", "capsule", "Capsule", publicKey.export({ format: "der", type: "spki" }).toString("base64url"), -7, Date.now());
  const sign = (tool, inp) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(inp)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
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
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
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
    ctx.tool("probe.echo", { effect: "read", input: { type: "object", properties: { path: { type: "string" }, command: { type: "string" } } }, run: async input => ({ got: input }) });
    return { async stop() {} };
  } };`);
  const d = await start({ root, log: () => {}, firstPartyRoots: [path.join(root, "modules")] });
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
  assert.equal(info.owner.name, "Alex Rivera");
  assert.match(String(info.owner.fingerprint8), /^[A-Za-z0-9_-]{11}$/, "and the fingerprint a device's avatar is seeded from");
  assert.equal(info.assistant.name, "juno", "replies are labelled with the assistant's name");
  assert.ok(!("id" in info.owner) && !("id" in info.assistant), "owner.id never leaves the box");
});

test("daemon: without the appearance module, /theme.css serves config's theme.colors, read on every request", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  // The fallback path: with appearance on, it answers instead (core/settings/hub.test.js).
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ modules: { disable: ["appearance"] } }));
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

test("daemon: asking for something that is not there is a 404 not_found, not a 500", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { paths } = await import("../core/config/index.js");
  const http = await import("node:http");
  const post = (/** @type {string} */ tool, /** @type {any} */ body) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: paths(root).socket, path: "/v1/tools/" + tool, method: "POST", agent: false,
      headers: { "content-type": "application/json", "x-vyre-caller": "cli" } }, res => {
      let b = ""; res.setEncoding("utf8"); res.on("data", c => (b += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  for (const [tool, body] of [["gate.get", { id: "x" }], ["agents.delete", { agent: "x" }]]) {
    const r = /** @type {any} */ (await post(tool, body));
    assert.equal(r.status, 404, `${tool}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, "not_found");
  }
});

test("daemon: the Deck's resilience client is served from core/resilience, and nothing else there is", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const get = (/** @type {string} */ p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: p }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  }).on("error", reject));
  for (const f of ["stream", "sse", "backoff", "outbox", "web"]) {
    const r = /** @type {any} */ (await get(`/core/resilience/${f}.js`));
    assert.equal(r.status, 200, f);
    assert.equal(r.headers["content-type"], "text/javascript");
    assert.equal(r.headers["cache-control"], "no-cache");
    assert.match(r.headers["content-security-policy"], /default-src 'self'/);
    assert.equal(r.body, fs.readFileSync(path.join(import.meta.dirname, "..", "core", "resilience", f + ".js"), "utf8"));
  }
  // lib/avatar-seed (ADR 0043 section 6): the project tile's one shared rule, served the same way.
  const seed = /** @type {any} */ (await get("/lib/avatar-seed/index.js"));
  assert.equal(seed.status, 200);
  assert.equal(seed.headers["content-type"], "text/javascript");
  assert.equal(seed.body, fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "avatar-seed", "index.js"), "utf8"));
  // lib/caps-flags (PLAN.md C14b): the provider capability flags, served the same way.
  const caps = /** @type {any} */ (await get("/lib/caps-flags/index.js"));
  assert.equal(caps.status, 200);
  assert.equal(caps.body, fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "caps-flags", "index.js"), "utf8"));
  // lib/theme/contrast.js: the colour maths a custom accent needs, served the same way (deck/ui/theme.js).
  const contrast = /** @type {any} */ (await get("/lib/theme/contrast.js"));
  assert.equal(contrast.status, 200);
  assert.equal(contrast.body, fs.readFileSync(path.join(import.meta.dirname, "..", "lib", "theme", "contrast.js"), "utf8"));
  // kernel/contracts/index.js: the frozen constant tables (task transitions, field kinds), served the same way (deck/ui/tasks.js reads them).
  const studs = /** @type {any} */ (await get("/kernel/contracts/index.js"));
  assert.equal(studs.status, 200);
  assert.equal(studs.body, fs.readFileSync(path.join(import.meta.dirname, "..", "kernel", "contracts", "index.js"), "utf8"));
  // node.js (Node transports) and the tests are not the Deck's; neither is anything else in core/ or lib/.
  for (const p of ["/core/resilience/node.js", "/core/resilience/sse.test.js", "/core/daemon/index.js", "/lib/avatar-seed/index.test.js", "/lib/caps-flags/index.test.js", "/lib/identity.js"]) {
    const r = /** @type {any} */ (await get(p));
    assert.doesNotMatch(r.body, /^\/\/ @ts-check/, p);
  }
});

test("daemon: Wink's relay client (web/js/pair-ticket.js's ../../relay/client/*.js imports) is served from relay/client, and the pages' CSP allows the relay it needs", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [], relay: { url: "wss://relay.example.com" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const get = (/** @type {string} */ p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: p }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  }).on("error", reject));
  for (const f of ["client", "channel", "bytes", "response", "sse", "webcrypto", "noise", "seedwords", "words"]) {
    const r = /** @type {any} */ (await get(`/relay/client/${f}.js`));
    assert.equal(r.status, 200, f);
    assert.equal(r.headers["content-type"], "text/javascript");
    assert.equal(r.body, fs.readFileSync(path.join(import.meta.dirname, "..", "relay", "client", f + ".js"), "utf8"));
    // The default relay and this box's own configured one, both wss: and the https: resolveTicket()
    // fetches /v1/pair on - never a wildcard.
    const csp = r.headers["content-security-policy"];
    assert.match(csp, /connect-src [^;]*'self'/);
    for (const origin of ["wss://relay.vyre.run", "https://relay.vyre.run", "wss://relay.example.com", "https://relay.example.com"]) {
      assert.ok(csp.includes(origin), `${f}: connect-src missing ${origin} (${csp})`);
    }
  }
  // relay/client/nodecrypto.js is Node-only, never imported by a page; not on the allowlist,
  // so it falls through to the app's client-routing shell (as any unmatched path does), not
  // the real file.
  const nodeOnly = /** @type {any} */ (await get("/relay/client/nodecrypto.js"));
  assert.notEqual(nodeOnly.body, fs.readFileSync(path.join(import.meta.dirname, "..", "relay", "client", "nodecrypto.js"), "utf8"));
  // The pre-app pages carry the same connect-src fix (the device page's own fetch/WebSocket to the relay runs from here, not from /relay/client/*.js).
  const page = /** @type {any} */ (await get("/onboard/device"));
  assert.ok(page.headers["content-security-policy"].includes("wss://relay.vyre.run"));
});

test("daemon: every module outside web/ that any pre-app page imports is served (a missing one blanks the page that imports it)", { timeout: 30_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const get = (/** @type {string} */ p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: p }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
  }).on("error", reject));
  const REPO = path.join(import.meta.dirname, "..");
  /** Every relative import from a file under web/ (not tests, vendor or fixtures) that lands outside web/. @type {Set<string>} */
  const outside = new Set();
  const seen = new Set();
  const walk = (/** @type {string} */ file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    // Comments are not imports: a JSDoc `import("./x.js").Type` is erased before the browser sees it.
    const src = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)|(?:^|\n)import\s+["'](\.[^"']+)["']/g)) {
      const spec = m[1] || m[2] || m[3];
      const target = path.normalize(path.join(path.dirname(file), spec));
      if (!target.startsWith(path.join(REPO, "web") + path.sep)) outside.add(path.relative(REPO, target));
      walk(target);
    }
  };
  const all = (/** @type {string} */ dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return ["vendor", "fixtures", "test", "node_modules"].includes(e.name) ? [] : all(p);
    return e.name.endsWith(".js") && !e.name.endsWith(".test.js") ? [p] : [];
  });
  for (const f of all(path.join(REPO, "web"))) walk(f);
  assert.ok(outside.size > 3, "the pre-app pages import a few shared modules from outside web/");
  const bad = [];
  for (const rel of [...outside].sort()) {
    const r = /** @type {any} */ (await get("/" + rel.split(path.sep).join("/")));
    if (r.status !== 200 || !/javascript/.test(String(r.headers["content-type"])) || r.body !== fs.readFileSync(path.join(REPO, rel), "utf8")) bad.push(rel);
  }
  assert.deepEqual(bad, [], `the daemon does not serve: ${bad.join(", ")} (add them to its web allowlist)`);
  // Only the contracts' constant tables are served from kernel/: nothing else there answers as a file.
  for (const p of ["/kernel/index.js", "/kernel/core/authorize.js", "/kernel/contracts/chain.d.ts", "/kernel/contracts/contracts.test.js", "/kernel/contracts/package.json", "/kernel/seal/process.js", "/kernel/grants/index.js"]) {
    const r = /** @type {any} */ (await get(p));
    assert.ok(!/javascript/.test(String(r.headers["content-type"])) || r.status !== 200, `${p} must not be served as a script`);
    assert.notEqual(r.body, fs.readFileSync(path.join(REPO, p.slice(1).split("/").filter(x => x !== "..").join("/")), "utf8").toString(), `${p} must not answer with the file`);
  }
});

test("daemon: a box never serves sample data, not even to a dev world that asks", { timeout: 20_000 }, async t => {
  const root = tempHome(t);
  const saved = process.env.VYRE_DECK_FIXTURES;
  process.env.VYRE_DECK_FIXTURES = "1";
  t.after(() => { if (saved === undefined) delete process.env.VYRE_DECK_FIXTURES; else process.env.VYRE_DECK_FIXTURES = saved; });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const get = (/** @type {string} */ p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: p }, res => {
    let b = ""; res.on("data", c => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  }).on("error", reject));
  for (const p of ["/fixtures/onboard.json", "/fixtures/relay.json", "/Fixtures/onboard.json", "/fixtures/../fixtures/onboard.json"]) {
    const r = /** @type {any} */ (await get(p));
    assert.doesNotMatch(r.body, /Harlow|Northwind|"onboard"/, p);
  }
});

test("daemon: every address the signed shell list names is served with exactly the listed bytes, the onboarding and passkey-claim pages included", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [] }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const { socketPath } = await import("../core/config/index.js");
  const http = await import("node:http");
  const { shellHashes } = await import("../scripts/shell-hashes.mjs");
  const crypto = await import("node:crypto");
  const get = (/** @type {string} */ p) => new Promise((resolve, reject) => http.get({ socketPath: socketPath(root), path: p }, res => {
    /** @type {Buffer[]} */ const c = []; res.on("data", x => c.push(x)); res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(c) }));
  }).on("error", reject));
  const bad = [];
  for (const [p, want] of shellHashes().files) {
    const r = /** @type {any} */ (await get(p));
    // A page carries its build id in one meta tag set per build (htmlWithBuild); the release lists it as "dev".
    const body = /\.html$/.test(p) || !/\.[a-z0-9]+$/.test(p) ? Buffer.from(r.body.toString("utf8").replace(/(<meta name="vyre-build" content=")[^"]*(")/, "$1dev$2")) : r.body;
    if (r.status !== 200 || crypto.createHash("sha256").update(body).digest("hex") !== want) bad.push(p);
  }
  assert.deepEqual(bad, [], "a page with anything per-box in its bytes cannot be on the signed list");
});

