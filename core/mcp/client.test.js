// @ts-check
// The MCP client against the fake servers, over all three transports. Only fakes this file
// starts itself: a child process from testing/fake-mcp.js, or an HTTP server on 127.0.0.1:0.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./client.js";
import { startFakeMcpHttp } from "./testing/fake-mcp.js";
import { tempHome } from "../../test/helpers.js";

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-mcp.js");
const stdioSpec = /** @type {const} */ ({ transport: "stdio", command: process.execPath, args: [FAKE, "--stdio"] });

/** @param {number} pid */
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @param {() => boolean} cond */
async function until(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await wait(20); }
  return cond();
}

/** Connect over stdio and close it after the test, so no child outlives it. */
async function stdio(t, /** @type {any} */ opts = {}) {
  const c = await connect(stdioSpec, opts);
  t.after(() => c.close());
  return c;
}

// ---- stdio ----

test("stdio: initialize, paged tool list, calls and errors", async t => {
  const lines = [];
  const c = await stdio(t, { onStderr: (/** @type {string} */ l) => lines.push(l) });
  assert.equal(c.transport, "stdio");
  assert.ok(c.pid && alive(c.pid));
  const init = await c.initialize();
  assert.equal(init.serverInfo.name, "fake-mcp");
  assert.equal(init.instructions, "A fake issue tracker for tests.");
  assert.ok(init.capabilities.tools);

  const tools = await c.listTools();
  assert.deepEqual(tools.map(x => x.name), ["list_issues", "get_issue", "create_issue", "send_message", "delete_issue", "echo_env"]);
  assert.equal(tools[0].annotations.readOnlyHint, true);

  const r = await c.callTool("get_issue", { id: 2 });
  assert.equal(r.structuredContent.title, "Harlow Legal intake form asks for the wrong date");
  const missing = await c.callTool("get_issue", { id: 9 });
  assert.equal(missing.isError, true);
  await assert.rejects(c.callTool("no_such_tool", {}), (/** @type {any} */ e) => e.code === "rpc" && e.rpcCode === -32602);

  assert.ok(await until(() => lines.includes("fake-mcp ready")));
  assert.ok(c.stderr().includes("fake-mcp ready"));
});

test("stdio: vyred's own env never reaches the server unless passed", async t => {
  process.env.VYRE_TEST_PARENT_ONLY = "northwind-parent-value";
  t.after(() => { delete process.env.VYRE_TEST_PARENT_ONLY; });
  const c = await stdio(t, { env: { HARLOW_GIVEN: "1" } });
  await c.initialize();
  const parent = await c.callTool("echo_env", { name: "VYRE_TEST_PARENT_ONLY" });
  assert.equal(parent.structuredContent.set, false);
  const given = await c.callTool("echo_env", { name: "HARLOW_GIVEN" });
  assert.equal(given.structuredContent.set, true);
  const home = await c.callTool("echo_env", { name: "PATH" });
  assert.equal(home.structuredContent.set, true);
  assert.doesNotMatch(JSON.stringify(parent), /northwind-parent-value/);
});

test("stdio: initialize fails when the server's required env is missing", async t => {
  const c = await stdio(t, { env: { FAKE_MCP_REQUIRE_ENV: "HARLOW_TOKEN" } });
  await assert.rejects(c.initialize(), (/** @type {any} */ e) => e.code === "rpc" && /HARLOW_TOKEN is not set/.test(e.message));
  const ok = await stdio(t, { env: { FAKE_MCP_REQUIRE_ENV: "HARLOW_TOKEN", HARLOW_TOKEN: "t" } });
  assert.equal((await ok.initialize()).serverInfo.name, "fake-mcp");
});

test("stdio: answers ping, refuses unknown server requests, ignores notifications", async t => {
  const c = await stdio(t, { env: { FAKE_MCP_PING_CLIENT: "1" } });
  await c.initialize();
  const r = await c.callTool("list_issues", {});
  assert.deepEqual(r.structuredContent.ping, {});
  assert.equal(r.structuredContent.unknown.code, -32601);
});

test("stdio: a crash calls onExit and rejects the pending call, which never arrived", async t => {
  const home = tempHome(t);
  const log = path.join(home, "fake.log");
  /** @type {any[]} */
  const exits = [];
  const c = await stdio(t, { env: { FAKE_MCP_CRASH_AFTER: "1", FAKE_MCP_LOG: log }, onExit: (/** @type {any} */ code, /** @type {any} */ sig) => exits.push([code, sig]) });
  await c.initialize();
  await c.callTool("create_issue", { title: "first" });
  await assert.rejects(c.callTool("send_message", { to: "dana@harlowlegal.com", text: "hi" }), (/** @type {any} */ e) => e.code === "exited");
  assert.deepEqual(exits, [[3, null]]);
  const logged = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(logged.filter(l => l.startsWith("start ")).length, 1);
  assert.deepEqual(logged.filter(l => l.startsWith("call ")), ['call create_issue {"title":"first"}']);
  await assert.rejects(c.callTool("list_issues", {}), (/** @type {any} */ e) => e.code === "exited");
});

test("stdio: close ends the child, and SIGKILL follows a SIGTERM it ignores", async t => {
  /** @type {any[]} */
  const exits = [];
  const c = await stdio(t, { onExit: () => exits.push(1) });
  await c.initialize();
  const pid = /** @type {number} */ (c.pid);
  const pending = c.callTool("list_issues", {});
  await c.close();
  assert.equal(alive(pid), false);
  assert.equal(exits.length, 0, "close is not a crash");
  await pending.then(() => {}, () => {});

  const stubborn = await stdio(t, { env: { FAKE_MCP_IGNORE_TERM: "1" } });
  await stubborn.initialize();
  const pid2 = /** @type {number} */ (stubborn.pid);
  const started = Date.now();
  await stubborn.close();
  assert.equal(alive(pid2), false);
  assert.ok(Date.now() - started >= 2500, "waited for SIGTERM before SIGKILL");
});

test("stdio: timeout, oversized reply and a missing command are clean errors", async t => {
  const tools = JSON.stringify([{ name: "slow", delay: 2000 }, { name: "huge", bytes: 5 * 1024 * 1024 }]);
  const c = await stdio(t, { env: { FAKE_MCP_TOOLS: tools }, timeout: 300 });
  await c.initialize();
  await assert.rejects(c.callTool("slow", {}), (/** @type {any} */ e) => e.code === "timeout" && /timed out after 300 ms/.test(e.message));

  const big = await stdio(t, { env: { FAKE_MCP_TOOLS: tools } });
  await big.initialize();
  await assert.rejects(big.callTool("huge", {}), (/** @type {any} */ e) => e.code === "too_large");

  const home = tempHome(t);
  const gone = await connect({ transport: "stdio", command: path.join(home, "no-such-server") });
  await assert.rejects(gone.initialize(), (/** @type {any} */ e) => e.code === "spawn_failed" && /ENOENT/.test(e.message));
});

// ---- streamable HTTP ----

test("http: init, paged list and call, headers minted per request, session kept and deleted", async t => {
  const fake = await startFakeMcpHttp(t, { requireAuth: "Bearer juno-token" });
  let minted = 0;
  const c = await connect({ transport: "http", url: fake.url }, { headers: async () => { minted++; return { Authorization: "Bearer juno-token" }; } });
  const init = await c.initialize();
  assert.equal(init.serverInfo.name, "fake-mcp");
  assert.equal(init.protocolVersion, "2025-06-18");
  const tools = await c.listTools();
  assert.equal(tools.length, 6);
  const r = await c.callTool("send_message", { to: "kit", text: "Order is ready" });
  assert.deepEqual(r.structuredContent, { sent: true, to: "kit" });
  assert.deepEqual(fake.calls, [{ name: "send_message", arguments: { to: "kit", text: "Order is ready" } }]);

  const posts = fake.requests.filter(x => x.method === "POST");
  assert.equal(minted, posts.length, "headers() is called for every request");
  assert.equal(posts[0].session, undefined);
  assert.equal(posts[0].protocol, undefined);
  assert.equal(posts[1].body.method, "notifications/initialized");
  const sid = [...fake.sessions.keys()][0];
  for (const p of posts.slice(1)) { assert.equal(p.session, sid); assert.equal(p.protocol, "2025-06-18"); }

  await c.close();
  assert.equal(fake.requests.at(-1)?.method, "DELETE");
  assert.equal(fake.sessions.size, 0);
  await assert.rejects(c.callTool("list_issues", {}), (/** @type {any} */ e) => e.code === "closed");
});

test("http: a reply as an SSE stream is read to the matching response", async t => {
  const fake = await startFakeMcpHttp(t, { reply: "sse" });
  const c = await connect({ transport: "http", url: fake.url });
  t.after(() => c.close());
  await c.initialize();
  assert.equal((await c.listTools()).length, 6);
  const r = await c.callTool("get_issue", { id: 1 });
  assert.equal(r.structuredContent.id, 1);
});

test("http: 401 carries code unauthorized and never the header value", async t => {
  const fake = await startFakeMcpHttp(t, { requireAuth: "Bearer right" });
  const c = await connect({ transport: "http", url: fake.url }, { headers: async () => ({ authorization: "Bearer wrong-secret-alex" }) });
  await assert.rejects(c.initialize(), (/** @type {any} */ e) => e.code === "unauthorized" && !e.message.includes("wrong-secret-alex"));
});

test("http: a redirect is refused and not followed", async t => {
  const fake = await startFakeMcpHttp(t, { redirect: true });
  const c = await connect({ transport: "http", url: fake.url }, { headers: async () => ({ authorization: "Bearer kit-secret" }) });
  await assert.rejects(c.initialize(), (/** @type {any} */ e) => e.code === "redirect" && !e.message.includes("kit-secret"));
  assert.equal(fake.requests.length, 1);
});

test("http: timeout, oversized reply, bad url and unreachable server", async t => {
  const fake = await startFakeMcpHttp(t, { tools: [{ name: "slow", delay: 1500 }, { name: "huge", bytes: 5 * 1024 * 1024 }] });
  const c = await connect({ transport: "http", url: fake.url }, { timeout: 300 });
  t.after(() => c.close());
  await c.initialize();
  await assert.rejects(c.callTool("slow", {}), (/** @type {any} */ e) => e.code === "timeout");
  const c2 = await connect({ transport: "http", url: fake.url });
  t.after(() => c2.close());
  await c2.initialize();
  await assert.rejects(c2.callTool("huge", {}), (/** @type {any} */ e) => e.code === "too_large");

  await assert.rejects(connect({ transport: "http", url: "file:///etc/passwd" }), (/** @type {any} */ e) => e.code === "bad_input");
  // A port just freed on loopback: nothing listens, so the connection is refused.
  const dead = await startFakeMcpHttp({ after: () => {} });
  const deadUrl = dead.url;
  await new Promise(r => { dead.server.close(() => r(undefined)); });
  const c3 = await connect({ transport: "http", url: deadUrl + "?key=abc123" });
  await assert.rejects(c3.initialize(), (/** @type {any} */ e) => e.code === "unreachable" && !e.message.includes("abc123"));
});

// ---- legacy SSE ----

test("sse: init, paged list and call through the named endpoint, with headers each time", async t => {
  const fake = await startFakeMcpHttp(t, { mode: "sse", requireAuth: "Bearer dana" });
  let minted = 0;
  const c = await connect({ transport: "sse", url: fake.url }, { headers: async () => { minted++; return { authorization: "Bearer dana" }; } });
  const init = await c.initialize();
  assert.equal(init.protocolVersion, "2024-11-05");
  assert.equal(init.serverInfo.name, "fake-mcp");
  assert.equal((await c.listTools()).length, 6);
  const r = await c.callTool("delete_issue", { id: 2 });
  assert.deepEqual(r.structuredContent, { deleted: 2 });
  assert.equal(fake.calls.length, 1);
  assert.equal(minted, fake.requests.length);
  assert.ok(fake.requests.every(x => x.authorization === "Bearer dana"));
  assert.equal(fake.sessions.size, 1);
  await c.close();
  assert.ok(await until(() => fake.sessions.size === 0));
});

test("sse: an endpoint on another origin is refused", async t => {
  const fake = await startFakeMcpHttp(t, { mode: "sse", endpoint: "http://127.0.0.2:9/messages" });
  await assert.rejects(connect({ transport: "sse", url: fake.url }, { headers: async () => ({ authorization: "Bearer juno" }) }),
    (/** @type {any} */ e) => e.code === "refused" && !e.message.includes("juno"));
  assert.ok(fake.requests.every(x => x.path === "/sse"));
});

test("sse: 401 and redirect are refused", async t => {
  const locked = await startFakeMcpHttp(t, { mode: "sse", requireAuth: "Bearer right" });
  await assert.rejects(connect({ transport: "sse", url: locked.url }), (/** @type {any} */ e) => e.code === "unauthorized");
  const moved = await startFakeMcpHttp(t, { mode: "sse", redirect: true });
  await assert.rejects(connect({ transport: "sse", url: moved.url }), (/** @type {any} */ e) => e.code === "redirect");
  assert.equal(moved.requests.length, 1);
});

test("sse: the server ending the stream calls onExit and rejects pending calls", async t => {
  const fake = await startFakeMcpHttp(t, { mode: "sse", tools: [{ name: "slow", delay: 2000 }] });
  /** @type {any[]} */
  const exits = [];
  const c = await connect({ transport: "sse", url: fake.url }, { onExit: (/** @type {any} */ a, /** @type {any} */ b) => exits.push([a, b]) });
  t.after(() => c.close());
  await c.initialize();
  const pending = c.callTool("slow", {});
  await until(() => fake.calls.length === 1);
  for (const res of fake.sessions.values()) res.end();
  await assert.rejects(pending, (/** @type {any} */ e) => e.code === "exited");
  assert.deepEqual(exits, [[null, null]]);
});
