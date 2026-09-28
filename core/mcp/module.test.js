// @ts-check
// The MCP hub inside a real vyred, in a temp home, with the real vault and the real Gate, against
// fake MCP servers (core/mcp/testing/fake-mcp.js): stdio children, streamable HTTP and legacy
// SSE on 127.0.0.1. What it proves: credentials reach the one server they are for and nothing
// else; reads run, outward calls wait for the person; scope follows what vyred verified; servers
// start lazily, stop when idle, and stop restarting when they keep crashing.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { startFakeMcpHttp } from "./testing/fake-mcp.js";

const FAKE = path.join(import.meta.dirname, "testing", "fake-mcp.js");
const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const tick = ms => new Promise(r => setTimeout(r, ms));

/** Wait for a condition without a fixed sleep: check every 20 ms, give up after `ms`. */
async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting"); await tick(20); }
}

async function vyred(t, extra = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" }, ...extra }));
  const lines = [];
  const d = await start({ root, presence: present, log: (m, x) => lines.push(m + (x ? " " + JSON.stringify(x) : "")) });
  t.after(() => d.stop());
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  const cli = as("cli");
  /** A model in an agent's thread: vyred verified the agent and the thread, so this goes in-process. */
  const agent = (name, thread) => (tool, input = {}) => d.registry.call(tool, input, `mcp:agent:${name}`, { thread, agent: name });
  /** A person's own Claude session, bound to a thread. */
  const session = thread => (tool, input = {}) => d.registry.call(tool, input, "mcp", thread ? { thread } : {});
  const secret = async (name, value) => {
    assert.ok((await cli("vault.put", { name, kind: "api-key", fields: { value } })).data);
    assert.equal((await cli("vault.grant", { name, module: "mcp" })).data.grant.status, "active");
  };
  return { root, d, lines, cli, as, agent, session, secret, events: () => d.registry.deps.events.since(0, { limit: 5000 }) };
}

const stdio = (name, logFile, vars = {}, more = {}) => ({ name, transport: "stdio", command: process.execPath, args: [FAKE, "--stdio"],
  vars: { FAKE_MCP_LOG: logFile, ...vars }, ...more });
const starts = f => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(l => l.startsWith("start ")).length : 0);
const calls = f => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(l => l.startsWith("call ")) : []);

test("mcp: stdio, http and sse servers, with credentials that reach only their own server", async t => {
  const v = await vyred(t);
  assert.equal(v.d.registry.status().find(m => m.name === "mcp")?.state, "running");
  const token = fake("tracker"), gh = fake("gh");
  await v.secret("tracker-token", token);
  await v.secret("gh-token", gh);
  process.env.MCP_TEST_VYRED_ONLY = "vyred-wide";
  t.after(() => { delete process.env.MCP_TEST_VYRED_ONLY; });

  const http = await startFakeMcpHttp(t, { requireAuth: `Bearer ${token}` });
  const added = await v.cli("mcp.add", { name: "tracker", transport: "http", url: http.url, auth: { type: "bearer", item: "tracker-token" } });
  assert.equal(added.data.test.ok, true, JSON.stringify(added));
  assert.equal(added.data.tools, 6);
  assert.deepEqual(added.data.auth, { type: "bearer", item: "tracker-token" });

  const sse = await startFakeMcpHttp(t, { mode: "sse" });
  assert.equal((await v.cli("mcp.add", { name: "board", transport: "sse", url: sse.url })).data.test.ok, true);

  const log = path.join(v.root, "local.log");
  const local = await v.cli("mcp.add", stdio("local-tracker", log, { FAKE_MCP_REQUIRE_ENV: "GH_TOKEN" }, { env: { GH_TOKEN: "gh-token" }, tools: { mode: { echo_env: "read" } } }));
  assert.equal(local.data.test.ok, true, JSON.stringify(local));
  assert.equal(local.data.auth.type, "env");

  const servers = (await v.cli("mcp.servers")).data;
  assert.deepEqual(servers.map(s => [s.name, s.transport, s.state]), [["board", "sse", "running"], ["local-tracker", "stdio", "running"], ["tracker", "http", "running"]]);

  // Reads run directly, on each transport.
  const issues = await v.cli("mcp.call", { server: "tracker", tool: "list_issues" });
  assert.equal(issues.data.structuredContent.issues.length, 2, JSON.stringify(issues));
  assert.ok(http.requests.length > 0 && http.requests.every(r => r.authorization === `Bearer ${token}`));
  assert.equal((await v.cli("mcp.call", { name: "board__get_issue", arguments: { id: 2 } })).data.structuredContent.id, 2);
  assert.equal(sse.calls.length, 1);

  // The env reaches the child it is for; vyred's own env does not.
  const set = await v.cli("mcp.call", { server: "local-tracker", tool: "echo_env", arguments: { name: "GH_TOKEN" } });
  assert.equal(set.data.structuredContent.set, true, JSON.stringify(set));
  assert.equal((await v.cli("mcp.call", { server: "local-tracker", tool: "echo_env", arguments: { name: "MCP_TEST_VYRED_ONLY" } })).data.structuredContent.set, false);
  assert.equal(process.env.GH_TOKEN, undefined);

  // A tool list for a session names each tool <server>__<tool>, with outward marked.
  const tools = (await v.session("t-1")("mcp.tools")).data;
  assert.equal(tools.length, 18);
  const send = tools.find(x => x.name === "tracker__send_message");
  assert.deepEqual([send.server, send.tool, send.outward], ["tracker", "send_message", true]);
  assert.equal(tools.find(x => x.name === "tracker__list_issues").outward, false);
  assert.equal(tools.find(x => x.name === "local-tracker__echo_env").outward, false, "mode read");

  // Refused at add: a value where a vault item belongs, a credential header, plain http off this machine.
  assert.match((await v.cli("mcp.add", stdio("bad-env", log, {}, { env: { GH_TOKEN: "ghp_" + "a1B2".repeat(9) } }))).error.message, /vault/);
  assert.match((await v.cli("mcp.add", { name: "bad-header", transport: "http", url: http.url, headers: { authorization: `Bearer ${fake("x")}` } })).error.message, /credential/);
  assert.match((await v.cli("mcp.add", { name: "bad-url", transport: "http", url: "http://tracker.example.com/mcp" })).error.message, /https/);
  assert.match((await v.cli("mcp.add", { name: "Bad", transport: "http", url: http.url })).error.message, /lowercase/);

  // The promise: the values are nowhere but the requests and the child that needed them.
  const rows = v.d.registry.deps.db.prepare("SELECT * FROM mcp_servers").all();
  const everything = JSON.stringify([v.events(), v.lines, rows, servers, tools, issues, set, added, local]);
  for (const value of [token, gh]) assert.ok(!everything.includes(value), "a credential leaked");
});

test("mcp: an agent's outward call is held, edited by the person, and reaches the server as approved; a rejected one never does", async t => {
  const v = await vyred(t);
  const log = path.join(v.root, "chat.log");
  assert.equal((await v.cli("mcp.add", stdio("chat", log))).data.test.ok, true);
  const juno = v.agent("juno", "t-1");

  const held = await juno("mcp.call", { server: "chat", tool: "send_message", arguments: { to: "dana@harlowlegal.com", text: "The form is on staging." } });
  assert.ok(held.data.held, JSON.stringify(held));
  assert.match(held.data.message, /Held at the Gate/);
  assert.deepEqual(calls(log), [], "a held call reached the server");

  const list = (await v.cli("gate.held")).data;
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].via, list[0].kind, list[0].to, list[0].agent, list[0].thread], ["mcp:chat", "send", ["dana@harlowlegal.com"], "juno", "t-1"]);

  // A model never releases, and neither does any module but the Gate.
  assert.equal((await juno("mcp.release", { id: held.data.held, content: {} })).error.code, "no_such_tool");
  assert.equal((await v.d.registry.call("mcp.release", { id: held.data.held, content: {} }, "module:notes")).error.code, "denied");

  const text = "The form is on staging. Could we do a call on Friday?";
  const out = await v.cli("gate.approve", { id: held.data.held, edited: { arguments: { to: "dana@harlowlegal.com", text } } });
  assert.equal(out.data.state, "sent", JSON.stringify(out));
  assert.deepEqual(calls(log), [`call send_message ${JSON.stringify({ to: "dana@harlowlegal.com", text })}`]);
  assert.equal(out.data.result.structuredContent.sent, true);

  // Only `to` changed: it is written into the argument it came from.
  const h2 = (await juno("mcp.call", { name: "chat__send_message", arguments: { to: "dana@harlowlegal.com", text: "Ovens are in." } })).data.held;
  assert.equal((await v.cli("gate.approve", { id: h2, edited: { to: "alex@harlowlegal.com" } })).data.state, "sent");
  assert.equal(calls(log)[1], `call send_message ${JSON.stringify({ to: "alex@harlowlegal.com", text: "Ovens are in." })}`);

  // Rejected: nothing reaches the server.
  const h3 = (await juno("mcp.call", { server: "chat", tool: "delete_issue", arguments: { id: 1 } })).data.held;
  assert.equal((await v.cli("gate.get", { id: h3 })).data.kind, "delete");
  assert.equal((await v.cli("gate.reject", { id: h3 })).data.state, "rejected");
  assert.equal(calls(log).length, 2);

  // A model may not add servers or change them.
  assert.equal((await juno("mcp.add", stdio("sneaky", log))).error.code, "denied");
  assert.equal((await v.session("t-1")("mcp.update", { name: "chat", scope: { agents: ["juno"] } })).error.code, "denied");
  assert.equal((await v.session()("mcp.remove", { name: "chat" })).error.code, "denied");

  const events = v.events();
  assert.ok(events.some(e => e.type === "mcp.held") && events.some(e => e.type === "gate.released"));
  assert.ok(!JSON.stringify(events.filter(e => e.type.startsWith("mcp."))).includes("staging"), "an mcp event carried the arguments");
});

test("mcp: scope by agent, by an agent's projects, and by a session's thread", async t => {
  const v = await vyred(t);
  // option (a): agents.create now grants projects.access as part of making the agent, so the
  // projects it names have to exist first (they never did before this, since this test only
  // cares about MCP scoping, not real project folders).
  assert.ok((await v.cli("projects.create", { name: "Harlow Legal", home: path.join(v.root, "harlow-legal") })).data);
  assert.ok((await v.cli("projects.create", { name: "Northwind", home: path.join(v.root, "northwind") })).data);
  assert.ok((await v.cli("agents.create", { name: "juno", projects: ["harlow-legal"] })).data);
  assert.ok((await v.cli("agents.create", { name: "kit", projects: ["northwind"] })).data);
  const log = path.join(v.root, "x.log");
  await v.cli("mcp.add", stdio("tracker", log, {}, { scope: { projects: ["harlow-legal"] } }));
  await v.cli("mcp.add", stdio("ops", log, {}, { scope: { agents: ["juno"] }, tools: { allow: ["list_issues", "get_issue"] } }));

  const juno = v.agent("juno", "t-j"), kit = v.agent("kit", "t-k");
  const names = r => r.data.map(x => x.name).sort();
  assert.deepEqual(names(await juno("mcp.tools")), ["ops__get_issue", "ops__list_issues", "tracker__create_issue", "tracker__delete_issue", "tracker__echo_env",
    "tracker__get_issue", "tracker__list_issues", "tracker__send_message"]);
  assert.deepEqual(names(await kit("mcp.tools")), []);
  assert.deepEqual((await kit("mcp.servers")).data, []);
  assert.equal((await kit("mcp.call", { server: "tracker", tool: "list_issues" })).error.code, "denied");
  assert.equal((await kit("mcp.call", { server: "ops", tool: "list_issues" })).error.code, "denied");
  assert.equal((await juno("mcp.call", { server: "ops", tool: "create_issue", arguments: { title: "x" } })).error.code, "not_found", "not allowed");
  assert.equal((await juno("mcp.call", { server: "tracker", tool: "list_issues" })).data.structuredContent.issues.length, 2);

  // A person's session sees a project-scoped server when its thread is in that project.
  const db = v.d.registry.deps.db;
  const now = Date.now();
  for (const [id, project] of [["t-h", "harlow-legal"], ["t-n", "northwind"]])
    db.prepare("INSERT INTO threads_runs (id, cwd, project, status, started_at, last_at) VALUES (?,?,?,?,?,?)").run(id, v.root, project, "stopped", now, now);
  assert.deepEqual([...new Set((await v.session("t-h")("mcp.tools")).data.map(x => x.server))].sort(), ["ops", "tracker"]);
  assert.deepEqual((await v.session("t-n")("mcp.tools")).data.map(x => x.server), ["ops", "ops"]);
  assert.equal((await v.session("t-n")("mcp.call", { server: "tracker", tool: "list_issues" })).error.code, "denied");
  assert.equal((await v.session()("mcp.call", { server: "tracker", tool: "list_issues" })).error.code, "denied", "no thread, no project");

  // A held call from a session in a project is filed under that thread and project.
  const h = (await v.session("t-h")("mcp.call", { server: "tracker", tool: "create_issue", arguments: { title: "Intake form" } })).data.held;
  const it = (await v.cli("gate.get", { id: h })).data;
  assert.deepEqual([it.thread, it.project, it.to], ["t-h", "harlow-legal", ["tracker"]]);

  // People's own callers see everything, for managing it.
  assert.deepEqual((await v.cli("mcp.servers")).data.map(s => s.name), ["ops", "tracker"]);
});

test("mcp: lazy start, cached tools, idle stop, one shared start, and nothing at boot", async t => {
  const v = await vyred(t);
  const log = path.join(v.root, "lazy.log");
  assert.equal((await v.cli("mcp.add", stdio("lazy", log, {}, { idle: 200 }))).data.test.ok, true);
  assert.equal(starts(log), 1, "add tests it once, to cache the tools");
  await until(async () => (await v.cli("mcp.servers")).data[0].state === "stopped");
  assert.ok(v.events().some(e => e.type === "mcp.stopped" && e.payload.reason === "idle"));

  assert.equal((await v.session("t-1")("mcp.tools")).data.length, 6);
  assert.equal(starts(log), 1, "mcp.tools spawned a server");

  const [a, b, c] = await Promise.all([1, 2, 1].map(id => v.cli("mcp.call", { server: "lazy", tool: "get_issue", arguments: { id } })));
  assert.deepEqual([a.data.structuredContent.id, b.data.structuredContent.id, c.data.structuredContent.id], [1, 2, 1]);
  assert.equal(starts(log), 2, "three callers, one start");
  await until(async () => (await v.cli("mcp.servers")).data[0].state === "stopped");
  assert.equal((await v.cli("mcp.call", { server: "lazy", tool: "list_issues" })).data.structuredContent.issues.length, 2);
  assert.equal(starts(log), 3, "restarted on the next call");

  // A new vyred on the same home starts nothing, and lists from the cache.
  await v.d.stop();
  const d2 = await start({ root: v.root, presence: present, log: () => {} });
  t.after(() => d2.stop());
  assert.equal((await d2.registry.call("mcp.tools", {}, "mcp", { thread: "t-1" })).data.length, 6);
  assert.equal((await call("mcp.servers", {}, { root: v.root, caller: "cli" })).data[0].state, "stopped");
  assert.equal(starts(log), 3);
});

test("mcp: a server that keeps crashing stops restarting after three tries, until mcp.restart", async t => {
  const v = await vyred(t);
  const log = path.join(v.root, "crash.log");
  assert.equal((await v.cli("mcp.add", stdio("flaky", log, { FAKE_MCP_CRASH_AFTER: "0" }))).data.test.ok, true);
  for (let i = 0; i < 4; i++) {
    const r = await v.cli("mcp.call", { server: "flaky", tool: "list_issues" });
    assert.equal(r.error.code, "exited", JSON.stringify(r));
  }
  assert.equal(starts(log), 4, "one start and three restarts");
  const refused = await v.cli("mcp.call", { server: "flaky", tool: "list_issues" });
  assert.match(refused.error.message, /stays failed until mcp.restart/);
  assert.equal(starts(log), 4);
  const s = (await v.cli("mcp.servers")).data[0];
  assert.equal(s.state, "failed");
  assert.equal((await v.cli("mcp.restart", { name: "flaky" })).data.state, "running");
  assert.equal(starts(log), 5);
});
