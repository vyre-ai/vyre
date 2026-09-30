// @ts-check
// The session's MCP server reads JSON-RPC lines a model shapes. Whatever arrives, it stays up and
// still answers the next valid request.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { rng, junk } from "../../test/fuzz.js";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "harness", "mcp", "server.js");

test("mcp server fuzz: malformed and hostile JSON-RPC lines never take it down", { timeout: 60_000 }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const env = { ...process.env, VYRE_HOME: root };
  delete env.VYRE_SOCKET; delete env.VYRE_AGENT; delete env.VYRE_HUB_CHILD;
  const child = spawn(process.execPath, [SERVER], { env, stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => child.kill());
  child.stdin.on("error", () => {});
  let err = "";
  child.stderr.on("data", c => { err += c; });
  let exited = /** @type {any} */ (null);
  child.on("exit", (code, signal) => { exited = { code, signal }; });
  const got = new Map();
  readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", l => { try { const m = JSON.parse(l); got.set(m.id, m); } catch {} });
  const ask = async (/** @type {number} */ id, /** @type {string} */ method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200 && !got.has(id) && !exited; i++) await new Promise(r => setTimeout(r, 50));
    return got.get(id);
  };
  await ask(1, "initialize", { protocolVersion: "2025-06-18" });

  const r = rng(13);
  const lines = ["", "{", "}", "null", "[]", "[[[[", "1", '"x"', "\u0000\u0001", "{\"id\":", '{"jsonrpc":"2.0"}', '{"jsonrpc":"2.0","id":{},"method":{}}', "x".repeat(200_000)];
  for (let i = 0; i < 400; i++) lines.push(JSON.stringify(r.pick([junk(r), { jsonrpc: "2.0", id: r.int(50), method: junk(r), params: junk(r) }, { jsonrpc: "2.0", id: r.int(50), method: "tools/call", params: { name: junk(r), arguments: junk(r) } }])));
  for (const l of lines) { if (exited) break; child.stdin.write(l + "\n"); }
  const after = await ask(9001, "tools/list");
  assert.equal(exited, null, `the server exited: ${JSON.stringify(exited)} ${err.slice(-400)}`);
  assert.ok(after && after.result && Array.isArray(after.result.tools), "it still answers a valid request");
});
