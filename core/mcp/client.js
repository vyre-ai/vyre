// @ts-check
// The MCP client the hub uses to talk to one server (ADR 0016, "Transports").
//
// Three transports, no dependencies: stdio (a child process speaking newline-delimited JSON-RPC),
// streamable HTTP (protocol 2025-06-18: POST each message, the reply is JSON or an SSE stream)
// and legacy SSE (protocol 2024-11-05: GET a stream, POST to the endpoint it names). Each one is
// a small "channel" with request() and notify(); the MCP methods on top are shared.
//
// The rules that shape this file come from the floor, not from MCP:
// - A stdio server gets a minimal env plus what the caller passes, never vyred's own env, so a
//   credential vyred holds for one server can never be read by another.
// - HTTP headers are asked for on every request, because credentials are minted at call time
//   and a cached header would outlive its token.
// - Redirects are refused (redirect: "manual", any 3xx is an error), as the Gate does, so a
//   credential never follows one to another host.
// - No header value ever appears in an error message. Messages name the origin and path of the
//   server and a status, and network errors say only their code, because fetch's own messages
//   can quote an invalid header value.

import { spawn } from "node:child_process";
import fs from "node:fs";

const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version; } catch { return "0.0.0"; }
})();

/** The newest protocol this client speaks; legacy SSE servers get the one they were built for. */
export const PROTOCOL = "2025-06-18";
export const LEGACY_PROTOCOL = "2024-11-05";
/** A reply bigger than this is refused: no tool result a model reads needs more. */
export const MAX_RESPONSE = 4 * 1024 * 1024;
export const DEFAULT_TIMEOUT = 60_000;
const STDERR_LINES = 50;
const KILL_AFTER = 3000;
const MAX_PAGES = 100;

/** An error with a stable `code` the hub can branch on. */
export class McpError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, any>} [extra] */
  constructor(code, message, extra) {
    super(message);
    this.name = "McpError";
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

/**
 * @typedef {{ transport: "stdio", command: string, args?: string[], cwd?: string }
 *   | { transport: "http", url: string } | { transport: "sse", url: string }} Spec
 * @typedef {{ headers?: () => Promise<Record<string, string>>, env?: Record<string, string>,
 *   fetch?: typeof fetch, onExit?: (code: number | null, signal: string | null) => void,
 *   onStderr?: (line: string) => void, onNotification?: (msg: any) => void, timeout?: number }} Options
 */

/**
 * Open a connection to one MCP server. Nothing is exchanged until initialize(), except for
 * legacy SSE, whose stream has to be open before there is anywhere to POST.
 *
 * onExit fires once when the server goes away on its own (a stdio child exits, an SSE stream
 * ends), never after close(). Pending calls reject either way.
 * @param {Spec} spec
 * @param {Options} [opts]
 */
export async function connect(spec, opts = {}) {
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const o = { ...opts, timeout };
  if (!spec || typeof spec !== "object") throw new McpError("bad_input", "a server spec is required");
  let ch;
  if (spec.transport === "stdio") ch = stdioChannel(spec, o);
  else if (spec.transport === "http") ch = httpChannel(spec, o);
  else if (spec.transport === "sse") ch = await sseChannel(spec, o);
  else throw new McpError("bad_input", `unknown transport ${JSON.stringify(/** @type {any} */ (spec).transport)}`);
  return makeClient(ch);
}

/** @param {any} ch */
function makeClient(ch) {
  /** @param {string} method @param {any} [params] */
  async function rpc(method, params) {
    const res = await ch.request(method, params);
    if (res.error) {
      const msg = String(res.error.message || "error").slice(0, 500);
      throw new McpError("rpc", `${method} failed: ${msg}`, { rpcCode: res.error.code });
    }
    return res.result ?? {};
  }
  return {
    transport: ch.transport,
    get pid() { return ch.pid; },
    /** The last lines the server wrote to stderr (stdio only), for `mcp.test`. Unscrubbed. */
    stderr: () => ch.stderr ? [...ch.stderr] : [],
    async initialize() {
      const r = await rpc("initialize", { protocolVersion: ch.protocol, capabilities: {}, clientInfo: { name: "vyre", version: VERSION } });
      if (typeof r.protocolVersion === "string") ch.protocol = r.protocolVersion;
      await ch.notify("notifications/initialized");
      return { protocolVersion: ch.protocol, serverInfo: r.serverInfo || {}, capabilities: r.capabilities || {}, instructions: r.instructions };
    },
    async listTools() {
      const tools = [];
      const seen = new Set();
      /** @type {string | undefined} */
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await rpc("tools/list", cursor === undefined ? {} : { cursor });
        if (Array.isArray(r.tools)) tools.push(...r.tools);
        const next = r.nextCursor;
        // A server that hands back a cursor it already gave would page forever.
        if (typeof next !== "string" || !next || seen.has(next)) break;
        seen.add(next);
        cursor = next;
      }
      return tools;
    },
    /** @param {string} name @param {any} [args] */
    callTool: (name, args) => rpc("tools/call", { name, arguments: args || {} }),
    close: () => ch.close(),
  };
}

// ---- shared JSON-RPC plumbing ----

/** Requests waiting for a reply, each with its own timer. */
function pendingMap() {
  /** @type {Map<number, {resolve: (m: any) => void, reject: (e: any) => void, timer: any}>} */
  const m = new Map();
  return {
    /** @param {number} id @param {number} ms @param {string} method */
    add(id, ms, method) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { m.delete(id); reject(new McpError("timeout", `${method} timed out after ${ms} ms`)); }, ms);
        m.set(id, { resolve, reject, timer });
      });
    },
    /** @param {any} msg */
    settle(msg) {
      const p = m.get(msg.id);
      if (!p) return;
      m.delete(msg.id); clearTimeout(p.timer); p.resolve(msg);
    },
    /** @param {number} id @param {any} err */
    reject(id, err) {
      const p = m.get(id);
      if (!p) return;
      m.delete(id); clearTimeout(p.timer); p.reject(err);
    },
    /** @param {any} err */
    rejectAll(err) {
      for (const [id, p] of m) { m.delete(id); clearTimeout(p.timer); p.reject(err); }
    },
  };
}

/**
 * Route one incoming message. The client offers no capabilities, so the only server request it
 * answers is `ping`; anything else gets "method not found" rather than silence, which would
 * leave the server waiting.
 * @param {any} msg @param {(m: any) => void} settle @param {(m: any) => void} reply
 * @param {((m: any) => void) | undefined} onNotification
 */
function dispatch(msg, settle, reply, onNotification) {
  if (Array.isArray(msg)) { for (const m of msg) dispatch(m, settle, reply, onNotification); return; }
  if (!msg || typeof msg !== "object") return;
  if (typeof msg.method === "string") {
    if (msg.id === undefined || msg.id === null) { try { onNotification?.(msg); } catch {} return; }
    if (msg.method === "ping") reply({ jsonrpc: "2.0", id: msg.id, result: {} });
    else reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    return;
  }
  if ("id" in msg && ("result" in msg || "error" in msg)) settle(msg);
}

const tooLarge = () => new McpError("too_large", `the server's reply is over ${MAX_RESPONSE} bytes`);
const closedErr = () => new McpError("closed", "the connection was closed");

// ---- stdio ----

/** What a stdio server gets from vyred's env: enough to find programs and a temp dir, no more. */
function baseEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const k of ["PATH", "HOME", "LANG", "TMPDIR"]) if (process.env[k] !== undefined) env[k] = /** @type {string} */ (process.env[k]);
  return env;
}

/**
 * Split a stream into lines. A line over `cap` either fails the stream (stdout, where it is a
 * reply we must not buffer without bound) or is cut short (stderr, where only the tail matters).
 * @param {import("node:stream").Readable} stream @param {number} cap
 * @param {(line: string) => void} onLine @param {(() => void) | null} onOverflow
 */
function lines(stream, cap, onLine, onOverflow) {
  let buf = "";
  let dropping = false;
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; }
      if (line.trim()) onLine(line);
    }
    if (buf.length > cap) {
      if (onOverflow) { buf = ""; onOverflow(); return; }
      if (!dropping) onLine(buf.slice(0, cap) + " [cut]");
      buf = ""; dropping = true;
    }
  });
}

/** @param {{command: string, args?: string[], cwd?: string}} spec @param {Options & {timeout: number}} opts */
function stdioChannel(spec, opts) {
  if (typeof spec.command !== "string" || !spec.command) throw new McpError("bad_input", "a stdio server needs a command");
  const child = spawn(spec.command, spec.args || [], {
    cwd: spec.cwd, env: { ...baseEnv(), ...(opts.env || {}) }, stdio: ["pipe", "pipe", "pipe"],
  });
  const pend = pendingMap();
  /** @type {string[]} */
  const ring = [];
  let next = 1;
  let gone = false;
  let closing = false;
  /** @type {any} */
  let failure = null;
  /** @type {() => void} */
  let markExited = () => {};
  const exited = new Promise(r => { markExited = () => r(undefined); });

  /** @param {number | null} code @param {string | null} signal @param {any} err */
  const finish = (code, signal, err) => {
    if (gone) return;
    gone = true;
    failure = closing ? closedErr() : err;
    pend.rejectAll(failure);
    markExited();
    if (!closing) { try { opts.onExit?.(code, signal); } catch {} }
  };
  child.on("error", err => finish(null, null, new McpError("spawn_failed", `could not start ${spec.command}: ${/** @type {any} */ (err).code || "error"}`)));
  child.on("exit", (code, signal) => finish(code, signal, new McpError("exited", `the server exited (${signal ? signal : `code ${code}`})`, { exitCode: code, signal })));
  // A write after the child died raises EPIPE here; the exit handler already rejected the calls.
  child.stdin.on("error", () => {});

  /** @param {any} msg */
  const write = msg => {
    if (gone) throw failure || closedErr();
    child.stdin.write(JSON.stringify(msg) + "\n");
  };
  lines(child.stdout, MAX_RESPONSE, line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    dispatch(msg, m => pend.settle(m), m => { try { write(m); } catch {} }, opts.onNotification);
  }, () => {
    // A reply we cannot hold: fail what is waiting and stop the server, since the stream is now
    // mid-message and nothing after it can be trusted to line up.
    pend.rejectAll(tooLarge());
    child.kill("SIGKILL");
  });
  lines(child.stderr, 4000, line => {
    ring.push(line);
    if (ring.length > STDERR_LINES) ring.shift();
    try { opts.onStderr?.(line); } catch {}
  }, null);

  return {
    transport: "stdio",
    protocol: PROTOCOL,
    stderr: ring,
    get pid() { return child.pid; },
    /** @param {string} method @param {any} [params] */
    request(method, params) {
      const id = next++;
      const p = pend.add(id, opts.timeout, method);
      try { write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }); } catch (e) { pend.reject(id, e); }
      return p;
    },
    /** @param {string} method */
    async notify(method) { write({ jsonrpc: "2.0", method }); },
    async close() {
      if (gone) return;
      closing = true;
      try { child.stdin.end(); } catch {}
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!gone) child.kill("SIGKILL"); }, KILL_AFTER);
      await exited;
      clearTimeout(timer);
    },
  };
}

// ---- HTTP shared ----

/** @param {string} raw */
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new McpError("bad_input", "the server url is not a valid URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new McpError("bad_input", "the server url must be http or https");
  return u;
}

/** Origin and path only: a query string can carry a key. @param {URL} u */
const where = u => u.origin + u.pathname;

/** Ask for the caller's headers and lowercase them, so ours cannot be doubled by case. @param {Options} opts */
async function callerHeaders(opts) {
  const h = opts.headers ? await opts.headers() : {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = String(v);
  return out;
}

/** @param {Response} res @param {URL} u */
function checkStatus(res, u) {
  if (res.status >= 300 && res.status < 400 || res.type === "opaqueredirect") {
    throw new McpError("redirect", `${where(u)} answered with a redirect (${res.status}); redirects are refused so a credential never follows one`);
  }
  if (res.status === 401) throw new McpError("unauthorized", `${where(u)} answered 401 unauthorized`, { status: 401 });
  if (!res.ok) throw new McpError("http", `${where(u)} answered ${res.status}`, { status: res.status });
}

/** A fetch failure, named by its code only. @param {any} e @param {URL} u */
function netError(e, u) {
  const code = e?.cause?.code || e?.code || "network error";
  return new McpError("unreachable", `could not reach ${where(u)}: ${code}`);
}

/** Read a whole body, refusing one over the cap. @param {Response} res */
async function readCapped(res) {
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_RESPONSE) { res.body?.cancel().catch(() => {}); throw tooLarge(); }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE) { reader.cancel().catch(() => {}); throw tooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Server-sent events from a body. `totalCap` bounds a reply stream that should end; `eventCap`
 * bounds each event of a stream that stays open.
 * @param {ReadableStream<Uint8Array>} body @param {{totalCap?: number, eventCap?: number}} caps
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
async function* sseEvents(body, { totalCap = Infinity, eventCap = MAX_RESPONSE } = {}) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "", event = "", total = 0, size = 0;
  /** @type {string[]} */
  let data = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      total += value.byteLength;
      if (total > totalCap) throw tooLarge();
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        let line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (data.length) yield { event: event || "message", data: data.join("\n") };
          data = []; size = 0; event = "";
          continue;
        }
        if (line.startsWith(":")) continue;
        const c = line.indexOf(":");
        const field = c < 0 ? line : line.slice(0, c);
        let v = c < 0 ? "" : line.slice(c + 1);
        if (v.startsWith(" ")) v = v.slice(1);
        if (field === "data") { data.push(v); size += v.length; if (size > eventCap) throw tooLarge(); }
        else if (field === "event") event = v;
      }
      if (buf.length > eventCap) throw tooLarge();
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// ---- streamable HTTP ----

/** @param {{url: string}} spec @param {Options & {timeout: number}} opts */
function httpChannel(spec, opts) {
  const u = checkUrl(spec.url);
  const f = opts.fetch || fetch;
  /** @type {string | null} */
  let session = null;
  let initialized = false;
  let closed = false;
  let next = 1;
  /** @type {Set<AbortController>} */
  const open = new Set();
  const ch = {
    transport: "http",
    protocol: PROTOCOL,
    pid: undefined,
    /** @param {string} method @param {any} [params] */
    async request(method, params) {
      const id = next++;
      const res = await post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, method);
      if (method === "initialize" && !res.error) initialized = true;
      return res;
    },
    /** @param {string} method */
    async notify(method) { await post({ jsonrpc: "2.0", method }, method); },
    async close() {
      if (closed) return;
      closed = true;
      for (const ac of open) ac.abort();
      if (!session) return;
      // Ending the session is a courtesy: a server that is gone or slow must not hold close up.
      try {
        const res = await f(u, { method: "DELETE", headers: { ...(await callerHeaders(opts)), ...protoHeaders() }, redirect: "manual", signal: AbortSignal.timeout(5000) });
        await res.body?.cancel().catch(() => {});
      } catch {}
      session = null;
    },
  };

  const protoHeaders = () => ({
    ...(session ? { "mcp-session-id": session } : {}),
    ...(initialized ? { "mcp-protocol-version": ch.protocol } : {}),
  });

  /** @param {any} msg @param {string} method @returns {Promise<any>} */
  async function post(msg, method) {
    if (closed) throw closedErr();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, opts.timeout);
    open.add(ac);
    try {
      const headers = {
        ...(await callerHeaders(opts)),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...protoHeaders(),
      };
      let res;
      try {
        res = await f(u, { method: "POST", headers, body: JSON.stringify(msg), redirect: "manual", signal: ac.signal });
      } catch (e) {
        throw e instanceof McpError ? e : netError(e, u);
      }
      if (res.status === 404 && session) {
        res.body?.cancel().catch(() => {});
        session = null; initialized = false;
        throw new McpError("session_expired", `${where(u)} no longer knows this session`, { status: 404 });
      }
      if (!res.ok || res.status >= 300) { res.body?.cancel().catch(() => {}); checkStatus(res, u); }
      const sid = res.headers.get("mcp-session-id");
      if (sid) session = sid;
      if (msg.id === undefined) { res.body?.cancel().catch(() => {}); return null; }

      /** @type {any} */
      let found = null;
      const settle = (/** @type {any} */ m) => { if (m.id === msg.id) found = m; };
      const reply = (/** @type {any} */ m) => { post(m, "reply").catch(() => {}); };
      const type = res.headers.get("content-type") || "";
      if (type.includes("text/event-stream")) {
        if (!res.body) throw new McpError("bad_response", `${where(u)} sent an empty stream for ${method}`);
        for await (const ev of sseEvents(res.body, { totalCap: MAX_RESPONSE })) {
          if (ev.event !== "message") continue;
          let m;
          try { m = JSON.parse(ev.data); } catch { continue; }
          dispatch(m, settle, reply, opts.onNotification);
          if (found) break;
        }
      } else {
        const text = await readCapped(res);
        let m;
        try { m = JSON.parse(text); } catch { throw new McpError("bad_response", `${where(u)} sent a reply to ${method} that is not JSON`); }
        dispatch(m, settle, reply, opts.onNotification);
      }
      if (!found) throw new McpError("bad_response", `${where(u)} sent no reply to ${method}`);
      return found;
    } catch (e) {
      if (timedOut) throw new McpError("timeout", `${method} timed out after ${opts.timeout} ms`);
      if (closed && !(e instanceof McpError && e.code !== "unreachable")) throw closedErr();
      if (e instanceof McpError) throw e;
      throw netError(e, u);
    } finally {
      clearTimeout(timer);
      open.delete(ac);
    }
  }
  return ch;
}

// ---- legacy SSE ----

/** @param {{url: string}} spec @param {Options & {timeout: number}} opts */
async function sseChannel(spec, opts) {
  const u = checkUrl(spec.url);
  const f = opts.fetch || fetch;
  const pend = pendingMap();
  const stream = new AbortController();
  let next = 1;
  let closed = false;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stream.abort(); }, opts.timeout);
  /** @type {URL} */
  let endpoint;
  /** @type {AsyncGenerator<{event: string, data: string}>} */
  let events;
  try {
    let res;
    try {
      res = await f(u, { method: "GET", headers: { ...(await callerHeaders(opts)), accept: "text/event-stream" }, redirect: "manual", signal: stream.signal });
    } catch (e) { throw e instanceof McpError ? e : netError(e, u); }
    if (!res.ok || res.status >= 300) { res.body?.cancel().catch(() => {}); checkStatus(res, u); }
    if (!res.body) throw new McpError("bad_response", `${where(u)} sent an empty stream`);
    events = sseEvents(res.body, { eventCap: MAX_RESPONSE });
    // Manual next() rather than for-await: breaking out of a for-await would close the stream.
    for (;;) {
      const { value, done } = await events.next();
      if (done) throw new McpError("bad_response", `${where(u)} closed the stream before naming an endpoint`);
      if (value.event !== "endpoint") continue;
      try { endpoint = new URL(value.data.trim(), u); } catch { throw new McpError("bad_response", `${where(u)} named an endpoint that is not a URL`); }
      break;
    }
    // The endpoint gets the same credentials as the stream, so it must be the same server.
    if (endpoint.origin !== u.origin) throw new McpError("refused", `${where(u)} named a message endpoint on another origin (${endpoint.origin}); refused so a credential never goes there`);
  } catch (e) {
    stream.abort();
    if (timedOut) throw new McpError("timeout", `${where(u)} named no endpoint within ${opts.timeout} ms`);
    throw e instanceof McpError ? e : netError(e, u);
  } finally {
    clearTimeout(timer);
  }

  const post = async (/** @type {any} */ msg) => {
    if (closed) throw closedErr();
    let res;
    try {
      res = await f(endpoint, {
        method: "POST", headers: { ...(await callerHeaders(opts)), "content-type": "application/json" },
        body: JSON.stringify(msg), redirect: "manual", signal: AbortSignal.timeout(opts.timeout),
      });
    } catch (e) {
      if (e instanceof McpError) throw e;
      if (/** @type {any} */ (e)?.name === "TimeoutError") throw new McpError("timeout", `posting to ${where(endpoint)} timed out after ${opts.timeout} ms`);
      throw netError(e, endpoint);
    }
    res.body?.cancel().catch(() => {});
    checkStatus(res, endpoint);
  };

  // The stream carries every reply from here on.
  (async () => {
    try {
      for (;;) {
        const { value, done } = await events.next();
        if (done) break;
        if (value.event !== "message") continue;
        let m;
        try { m = JSON.parse(value.data); } catch { continue; }
        dispatch(m, x => pend.settle(x), x => { post(x).catch(() => {}); }, opts.onNotification);
      }
    } catch (e) {
      if (!closed && e instanceof McpError) { pend.rejectAll(e); }
    }
    if (closed) return;
    closed = true;
    pend.rejectAll(new McpError("exited", `${where(u)} closed the event stream`));
    try { opts.onExit?.(null, null); } catch {}
  })();

  return {
    transport: "sse",
    protocol: LEGACY_PROTOCOL,
    pid: undefined,
    /** @param {string} method @param {any} [params] */
    request(method, params) {
      const id = next++;
      const p = pend.add(id, opts.timeout, method);
      post({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch(e => pend.reject(id, e));
      return p;
    },
    /** @param {string} method */
    notify: (method) => post({ jsonrpc: "2.0", method }),
    async close() {
      if (closed) return;
      closed = true;
      pend.rejectAll(closedErr());
      stream.abort();
    },
  };
}
