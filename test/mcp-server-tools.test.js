// @ts-check
// The plugin's MCP server offers a session only the tools it can call: never the person's own
// (answering, approving, presence, a session's mode), which vyred refuses from any session.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { PERSON_ONLY, HUMAN_ONLY } from "../core/presence/index.js";
import { tempHome } from "./helpers.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "mcp", "server.js");

test("mcp server: no person-only or human-only tool is listed; ordinary ones are", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { ...process.env, VYRE_HOME: root };
  delete env.VYRE_SOCKET; delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: /** @type {any} */ (child.stdout) });
  const got = new Map();
  lines.on("line", l => { try { const m = JSON.parse(l); got.set(m.id, m); } catch {} });
  const ask = async (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200 && !got.has(id); i++) await new Promise(r => setTimeout(r, 50));
    return got.get(id);
  };
  await ask(1, "initialize", { protocolVersion: "2025-06-18" });
  const names = new Set((await ask(2, "tools/list")).result.tools.map(x => x.name));
  assert.ok(names.size > 10, `${names.size} tools`);
  assert.ok(names.has("system_echo"), "an ordinary tool is offered");
  for (const tool of [...PERSON_ONLY, ...HUMAN_ONLY]) assert.ok(!names.has(tool.replace(/\./g, "_")), `${tool} is not offered`);
});

test("mcp server: a tool call carries Claude Code's tool_use id as X-Vyre-Call-Id", async t => {
  const fs = await import("node:fs");
  const http = await import("node:http");
  const { SCRATCH } = await import("./scratch.mjs");
  const dir = fs.mkdtempSync(path.join(SCRATCH, "mcpc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sock = path.join(dir, "t.sock");
  /** @type {Record<string, any>[]} */ const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, call: req.headers["x-vyre-call-id"] || null });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: req.method === "GET" ? [{ name: "system.echo", description: "echo", input: { type: "object" } }] : { ok: true } }));
  });
  await new Promise(r => server.listen(sock, () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  const env = { ...process.env, VYRE_HOME: tempHome(t), VYRE_SOCKET: sock, VYRE_THREAD: "t1" };
  delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill());
  const lines = readline.createInterface({ input: /** @type {any} */ (child.stdout) });
  const got = new Map();
  lines.on("line", l => { try { const m = JSON.parse(l); got.set(m.id, m); } catch {} });
  const ask = async (id, method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200 && !got.has(id); i++) await new Promise(r => setTimeout(r, 50));
    return got.get(id);
  };
  await ask(1, "initialize", {});
  await ask(2, "tools/call", { name: "system_echo", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_01AbC" } });
  await ask(3, "tools/call", { name: "system_echo", arguments: {} });
  const calls = seen.filter(s => s.url === "/v1/tools/system.echo");
  assert.deepEqual(calls.map(c => c.call), ["toolu_01AbC", null]);
});
