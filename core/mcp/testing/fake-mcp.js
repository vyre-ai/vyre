#!/usr/bin/env node
// @ts-check
// A fake MCP server for tests, so no test ever starts a real one (ADR 0016).
//
// Two ways to run it:
// - `node core/mcp/testing/fake-mcp.js --stdio`, a real child process, set up through env:
//     FAKE_MCP_TOOLS         JSON array of tools that replaces the default list (see below)
//     FAKE_MCP_PAGE_SIZE     tools per tools/list page (default 4, so the defaults take two pages)
//     FAKE_MCP_REQUIRE_ENV   initialize fails unless this env var is set
//     FAKE_MCP_CRASH_AFTER   n: n calls succeed, the next one exits the process (code 3) unanswered
//     FAKE_MCP_LOG           a file it appends "start <pid>" and "call <tool> <args>" lines to,
//                            for counting starts and asserting a held call never arrived
//     FAKE_MCP_PING_CLIENT   before each call, ping the client and send it an unknown request,
//                            and put both answers in the result
//     FAKE_MCP_IGNORE_TERM   ignore SIGTERM, to prove close() falls back to SIGKILL
// - `startFakeMcpHttp(t, opts)` in-process, streamable HTTP or legacy SSE on 127.0.0.1 port 0.
//
// A custom tool is `{ name, description?, inputSchema?, annotations?, result?, delay?, bytes? }`:
// `result` is returned as the MCP result, `delay` holds the reply that many ms, `bytes` returns a
// text of that size. With none of them, a default tool of that name keeps its behaviour, and any
// other tool echoes its arguments.

import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const ISSUES = [
  { id: 1, title: "Oven rota for the Northwind Bakery kitchen" },
  { id: 2, title: "Harlow Legal intake form asks for the wrong date" },
];

const obj = (/** @type {Record<string, any>} */ properties, /** @type {string[]} */ required = []) => ({ type: "object", properties, required });

export const DEFAULT_TOOLS = [
  { name: "list_issues", description: "List open issues.", inputSchema: obj({}), annotations: { readOnlyHint: true } },
  { name: "get_issue", description: "Get one issue by id.", inputSchema: obj({ id: { type: "number" } }, ["id"]) },
  { name: "create_issue", description: "Open an issue.", inputSchema: obj({ title: { type: "string" } }, ["title"]) },
  { name: "send_message", description: "Send a message to someone.", inputSchema: obj({ to: { type: "string" }, text: { type: "string" } }, ["to", "text"]) },
  { name: "delete_issue", description: "Delete an issue.", inputSchema: obj({ id: { type: "number" } }, ["id"]) },
  { name: "echo_env", description: "Say whether an env var is set in the server, never its value.", inputSchema: obj({ name: { type: "string" } }, ["name"]) },
];

/** @param {any} value */
const ok = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
/** @param {string} text */
const fail = text => ({ content: [{ type: "text", text }], isError: true });

/** @type {Record<string, (args: any, env: Record<string, string | undefined>) => any>} */
const BEHAVIOUR = {
  list_issues: () => ok({ issues: ISSUES }),
  get_issue: a => { const i = ISSUES.find(x => x.id === Number(a.id)); return i ? ok(i) : fail(`no issue ${a.id}`); },
  create_issue: a => ok({ id: 3, title: String(a.title || "") }),
  send_message: a => ok({ sent: true, to: String(a.to || "") }),
  delete_issue: a => ok({ deleted: Number(a.id) }),
  echo_env: (a, env) => ok({ name: String(a.name || ""), set: env[String(a.name || "")] !== undefined }),
};

/**
 * The protocol, shared by both ways of running. `peer.request` sends a request to the client
 * (stdio only). `beforeCall` can refuse to answer (the crash option).
 * @param {{ tools?: any[], pageSize?: number, requireEnv?: string, env?: Record<string, string | undefined>,
 *   onCall?: (c: {name: string, arguments: any}) => void, beforeCall?: (n: number) => void,
 *   pingClient?: boolean }} o
 */
export function fakeCore(o = {}) {
  const tools = o.tools || DEFAULT_TOOLS;
  const pageSize = o.pageSize || 4;
  const env = o.env || {};
  let calls = 0;
  /**
   * @param {any} msg
   * @param {{ request?: (method: string) => Promise<any> }} [peer]
   * @returns {Promise<any>} the response, or null for a notification or a response
   */
  async function handle(msg, peer = {}) {
    if (!msg || typeof msg.method !== "string" || msg.id === undefined || msg.id === null) return null;
    const { id, method, params = {} } = msg;
    const result = (/** @type {any} */ r) => ({ jsonrpc: "2.0", id, result: r });
    const error = (/** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: "2.0", id, error: { code, message } });
    switch (method) {
      case "initialize":
        if (o.requireEnv && env[o.requireEnv] === undefined) return error(-32000, `${o.requireEnv} is not set`);
        return result({
          protocolVersion: params.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fake-mcp", version: "1.0.0" },
          instructions: "A fake issue tracker for tests.",
        });
      case "ping": return result({});
      case "tools/list": {
        const start = params.cursor ? Number(params.cursor) : 0;
        const page = tools.slice(start, start + pageSize).map(t => ({
          name: t.name, description: t.description || t.name, inputSchema: t.inputSchema || obj({}),
          ...(t.annotations ? { annotations: t.annotations } : {}),
        }));
        const more = start + pageSize < tools.length;
        return result({ tools: page, ...(more ? { nextCursor: String(start + pageSize) } : {}) });
      }
      case "tools/call": {
        const tool = tools.find(t => t.name === params.name);
        if (!tool) return error(-32602, `Unknown tool: ${params.name}`);
        o.beforeCall?.(calls);
        calls++;
        const args = params.arguments || {};
        o.onCall?.({ name: tool.name, arguments: args });
        if (tool.delay) await new Promise(r => setTimeout(r, tool.delay));
        if (o.pingClient && peer.request) {
          const ping = await peer.request("ping");
          const unknown = await peer.request("sampling/createMessage");
          return result(ok({ ping: ping.result ?? null, unknown: unknown.error ?? null }));
        }
        if (tool.result) return result(tool.result);
        if (tool.bytes) return result({ content: [{ type: "text", text: "x".repeat(tool.bytes) }] });
        const b = BEHAVIOUR[tool.name];
        return result(b ? b(args, env) : ok({ echo: args }));
      }
      default: return error(-32601, `method not found: ${method}`);
    }
  }
  return { handle };
}

// ---- stdio ----

function runStdio() {
  const env = process.env;
  const logFile = env.FAKE_MCP_LOG;
  const log = (/** @type {string} */ line) => { if (logFile) fs.appendFileSync(logFile, line + "\n"); };
  const crashAfter = env.FAKE_MCP_CRASH_AFTER === undefined ? Infinity : Number(env.FAKE_MCP_CRASH_AFTER);
  // A stubborn server: ignores SIGTERM and the end of stdin, and stays up until SIGKILL.
  const stubborn = !!env.FAKE_MCP_IGNORE_TERM;
  if (stubborn) { process.on("SIGTERM", () => {}); setInterval(() => {}, 60_000); }
  const send = (/** @type {any} */ m) => process.stdout.write(JSON.stringify(m) + "\n");
  /** @type {Map<string, (m: any) => void>} */
  const waiting = new Map();
  let next = 1;
  const peer = {
    request: (/** @type {string} */ method) => new Promise(resolve => {
      const id = `fake-${next++}`;
      waiting.set(id, resolve);
      send({ jsonrpc: "2.0", id, method });
    }),
  };
  const core = fakeCore({
    tools: env.FAKE_MCP_TOOLS ? JSON.parse(env.FAKE_MCP_TOOLS) : undefined,
    pageSize: env.FAKE_MCP_PAGE_SIZE ? Number(env.FAKE_MCP_PAGE_SIZE) : undefined,
    requireEnv: env.FAKE_MCP_REQUIRE_ENV || undefined,
    env,
    pingClient: !!env.FAKE_MCP_PING_CLIENT,
    beforeCall: n => { if (n >= crashAfter) process.exit(3); },
    onCall: c => log(`call ${c.name} ${JSON.stringify(c.arguments)}`),
  });
  log(`start ${process.pid}`);
  process.stderr.write("fake-mcp ready\n");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === undefined && waiting.has(msg.id)) { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); continue; }
      // A notification is sent to the client before each answer, which the client must ignore.
      if (msg.method === "tools/call") send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } });
      core.handle(msg, peer).then(r => { if (r) send(r); });
    }
  });
  process.stdin.on("end", () => { if (!stubborn) process.exit(0); });
}

// ---- HTTP and SSE, in-process ----

/** @param {http.IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Start a fake MCP server over HTTP. `calls` records every tool call, `requests` every HTTP
 * request with the auth, session and protocol headers it carried, and `sessions` the live ones.
 * @param {any} t the node:test context, whose after() stops the server
 * @param {{ tools?: any[], pageSize?: number, requireAuth?: string | ((authorization: string | undefined) => boolean), mode?: "http" | "sse",
 *   redirect?: boolean, reply?: "json" | "sse", endpoint?: string, protectedBy?: string }} [o]
 *   `requireAuth` may be a function that judges the Authorization header; `protectedBy` names an
 *   authorization server and makes this server publish RFC 9728 protected-resource metadata for it.
 *   `reply: "sse"` answers each streamable-HTTP request with an SSE stream; `endpoint` makes the
 *   legacy SSE server name that message endpoint instead of its own.
 */
export async function startFakeMcpHttp(t, o = {}) {
  const mode = o.mode || "http";
  /** @type {{name: string, arguments: any}[]} */
  const calls = [];
  /** @type {{method: string, path: string, authorization?: string, session?: string, protocol?: string, body?: any}[]} */
  const requests = [];
  /** @type {Map<string, any>} */
  const sessions = new Map();
  const core = fakeCore({ tools: o.tools, pageSize: o.pageSize, onCall: c => calls.push(c) });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = req.method === "POST" ? await readBody(req) : "";
    let msg = null;
    try { msg = body ? JSON.parse(body) : null; } catch {}
    requests.push({
      method: req.method || "", path: url.pathname,
      authorization: /** @type {string | undefined} */ (req.headers.authorization),
      session: /** @type {string | undefined} */ (req.headers["mcp-session-id"]),
      protocol: /** @type {string | undefined} */ (req.headers["mcp-protocol-version"]),
      body: msg,
    });
    if (o.redirect) { res.writeHead(307, { location: "http://127.0.0.1:9/elsewhere" }); return res.end(); }
    if (o.protectedBy && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ resource: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}/mcp`, authorization_servers: [o.protectedBy] }));
    }
    if (o.requireAuth && !(typeof o.requireAuth === "function" ? o.requireAuth(req.headers.authorization) : req.headers.authorization === o.requireAuth)) { res.writeHead(401); return res.end(); }
    if (mode === "sse") return sse(req, res, url, msg);
    return streamable(req, res, msg);
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {any} msg */
  async function streamable(req, res, msg) {
    const sid = /** @type {string | undefined} */ (req.headers["mcp-session-id"]);
    if (req.method === "DELETE") { if (sid) sessions.delete(sid); res.writeHead(204); return res.end(); }
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    if (!msg) { res.writeHead(400); return res.end(); }
    /** @type {Record<string, string>} */
    const extra = {};
    if (msg.method === "initialize") {
      const id = crypto.randomUUID();
      sessions.set(id, { started: Date.now() });
      extra["mcp-session-id"] = id;
    } else if (!sid) { res.writeHead(400); return res.end(); }
    else if (!sessions.has(sid)) { res.writeHead(404); return res.end(); }
    const reply = await core.handle(msg);
    if (!reply) { res.writeHead(202, extra); return res.end(); }
    if (o.reply === "sse") {
      res.writeHead(200, { ...extra, "content-type": "text/event-stream" });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
      res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return res.end();
    }
    res.writeHead(200, { ...extra, "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {URL} url @param {any} msg */
  async function sse(req, res, url, msg) {
    if (req.method === "GET" && url.pathname === "/sse") {
      const id = crypto.randomUUID();
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(`event: endpoint\ndata: ${o.endpoint || `/messages?sessionId=${id}`}\n\n`);
      sessions.set(id, res);
      req.on("close", () => sessions.delete(id));
      return;
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const stream = sessions.get(url.searchParams.get("sessionId") || "");
      if (!stream) { res.writeHead(404); return res.end(); }
      if (!msg) { res.writeHead(400); return res.end(); }
      res.writeHead(202); res.end();
      const reply = await core.handle(msg);
      if (reply) stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      return;
    }
    res.writeHead(404); res.end();
  }

  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  const base = `http://127.0.0.1:${addr.port}`;
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(() => r(undefined)); }));
  return { url: mode === "sse" ? `${base}/sse` : `${base}/mcp`, base, calls, requests, sessions, server };
}

if (process.argv.includes("--stdio") && process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) runStdio();
