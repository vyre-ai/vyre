// @ts-check
// A vyred that is busy (many sessions starting at once) answers the MCP server's first tools listing "not now" or not at all. The server asks again and never takes that for "no tools": an empty
// list made the agent say the Vyre finder was not reachable for the rest of its session (live, 10 Oct: three providers at once, nine sessions, 0 of 3 Codex had it).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempHome } from "./helpers.js";

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "harness", "mcp", "server.js");

test("the MCP server asks again when vyred says not now to its first tools listing, and lists the finder", async (t) => {
  const root = fs.realpathSync(tempHome(t));
  const sock = path.join(root, "s.sock");
  let lists = 0;
  const stub = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/tools") {
      lists++;
      return res.end(JSON.stringify(lists <= 2 ? { error: { code: "restarting", message: "vyred is busy" } } : { data: [{ name: "system.echo", description: "Say it back.", input: { type: "object", properties: {} }, callers: ["mcp"] }] }));
    }
    res.end(JSON.stringify({ error: { code: "no_such_tool", message: "no" } }));
  });
  await new Promise((r) => stub.listen(sock, () => r(undefined)));
  t.after(() => stub.close());
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, VYRE_HOME: root, VYRE_SOCKET: sock, VYRE_AGENT: "", VYRE_AGENT_KEY: "" } });
  t.after(() => p.kill());
  const replies = new Map();
  let buf = "";
  p.stdout.on("data", (c) => { buf += c; for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); } });
  const rpc = (id, method, params) => new Promise((r) => { replies.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  const listed = await rpc(2, "tools/list", {});
  const names = (listed.result?.tools || []).map((x) => x.name);
  assert.ok(names.includes("tools_find"), `the finder is listed (got ${JSON.stringify(listed).slice(0, 200)})`);
  assert.ok(lists >= 3, `vyred was asked again (${lists} listings)`);
});

test("a vyred that never answers the listing is an error to the client, not an empty list", async (t) => {
  const root = fs.realpathSync(tempHome(t));
  const sock = path.join(root, "s.sock");
  const stub = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: { code: "restarting", message: "vyred is busy" } })); });
  await new Promise((r) => stub.listen(sock, () => r(undefined)));
  t.after(() => stub.close());
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, VYRE_HOME: root, VYRE_SOCKET: sock, VYRE_AGENT: "", VYRE_AGENT_KEY: "" } });
  t.after(() => p.kill());
  const replies = new Map();
  let buf = "";
  p.stdout.on("data", (c) => { buf += c; for (let i; (i = buf.indexOf("\n")) >= 0;) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.get(m.id)?.(m); } });
  const rpc = (id, method, params) => new Promise((r) => { replies.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  await rpc(1, "initialize", { protocolVersion: "2025-06-18" });
  const listed = await rpc(2, "tools/list", {});
  assert.ok(listed.error && /busy/.test(listed.error.message), `an error the client can see: ${JSON.stringify(listed).slice(0, 200)}`);
});
