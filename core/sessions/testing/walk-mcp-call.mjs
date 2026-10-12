#!/usr/bin/env node
// @ts-check
// A walk's stand-in agent calls a Vyre tool the way a real ACP agent does: through the MCP server the client handed it in session/new (harness/mcp/server.js), over stdio.
// Used by fake-acp.js ("walk-mcp:<tool> <json>") and, run as a program, for a job a turn leaves behind: node walk-mcp-call.mjs <server json> <tool> <input json> <outfile> <delay seconds>.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** @param {any} srv one entry of session/new's mcpServers @param {string} tool @param {any} input @returns {Promise<string>} "walk-mcp exit=<0|1|2|3>: <text>" */
export function callViaMcp(srv, tool, input) {
  if (!srv || !srv.command) return Promise.resolve("walk-mcp exit=2: the client handed this session no MCP server");
  return new Promise((resolve) => {
    const env = { ...process.env, ...Object.fromEntries((srv.env || []).map((/** @type {any} */ e) => [e.name, e.value])) };
    const child = spawn(srv.command, srv.args || [], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "", done = false;
    const finish = (/** @type {string} */ text) => { if (done) return; done = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve(text); };
    const timer = setTimeout(() => finish("walk-mcp exit=3: the MCP server did not answer in 40 s"), 40_000);
    const send = (/** @type {any} */ o) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    child.on("error", (e) => finish("walk-mcp exit=2: " + e.message));
    child.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let r; try { r = JSON.parse(line); } catch { continue; }
        if (r.id === 1) { send({ method: "notifications/initialized" }); send({ id: 2, method: "tools/call", params: { name: "tools_call", arguments: { tool, arguments: input } } }); }
        if (r.id === 2) {
          const text = r.error ? String(r.error.message) : (((r.result && r.result.content) || []).map((/** @type {any} */ c) => c.text || "").join("\n"));
          finish(`walk-mcp exit=${r.error || (r.result && r.result.isError) ? 1 : 0}: ${text.slice(0, 1500)}`);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-acp", version: "0" } } });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , server, tool, input, outfile, delay] = process.argv;
  setTimeout(async () => { fs.writeFileSync(outfile, (await callViaMcp(JSON.parse(server), tool, JSON.parse(input || "{}"))) + "\n"); process.exit(0); }, Number(delay || 0) * 1000);
}
