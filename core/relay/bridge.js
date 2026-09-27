// @ts-check
// bridge: each stream a paired device opens becomes a real HTTP request to vyred's own router
// (ADR 0026, section 4). Node's http client writes the request into one end of an in-memory
// duplex, and a private http.Server reads it from the other and hands it to ctx.handler with the
// caller the relay established. So every route, the SSE stream, the presence header and the
// router's own checks work exactly as they do for the tailnet listener, and nothing here parses
// HTTP.
//
// WebSocket streams (/v1/streams/...) come later: a stream with a `ws` head is reset.

import http from "node:http";
import { duplexPair } from "node:stream";

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers a device may send. Everything else is dropped: the caller comes from the channel, and a
 * device is never an agent, so it carries no agent or session key. Idempotency-Key rides along so a
 * retried write runs once (ADR 0029, R2). */
const PASS = /^(accept|accept-language|content-type|last-event-id|if-none-match|idempotency-key|x-vyre-presence)$/;
/** Headers that describe the hop, not the response. */
const HOP = /^(connection|keep-alive|transfer-encoding|upgrade|strict-transport-security)$/;
const MAX_HEAD = 16 * 1024;

const fail = (s, status, code, message) => {
  s.respond({ status, headers: { "content-type": "application/json" } });
  s.write(Buffer.from(JSON.stringify({ error: { code, message } })));
  s.end();
};

/**
 * Serve one channel's streams through vyred's router as this caller.
 * @param {import("./channel.js").Channel} channel
 * @param {{ handler: (req: any, res: any, caller: string, peer: any) => any, caller: string, peer: any, log?: (m: string) => void }} o
 */
export function bridge(channel, o) {
  const server = http.createServer((req, res) => o.handler(req, res, o.caller, o.peer));
  const connect = () => {
    const [client, side] = duplexPair();
    server.emit("connection", side);
    return client;
  };
  channel.onstream = s => {
    const h = s.head || {};
    if (h.ws) return s.reset("streams over the relay are not supported yet");
    if (JSON.stringify(h).length > MAX_HEAD) return fail(s, 431, "bad_input", "request head too large");
    const method = String(h.method || "").toUpperCase();
    const path = String(h.path || "");
    if (!METHODS.has(method) || !path.startsWith("/") || path.startsWith("//") || /[\s\0]/.test(path)) return fail(s, 400, "bad_input", "a request needs a method and a path");
    /** @type {Record<string, string>} */
    const headers = { host: "relay", connection: "close" };
    for (const [k, v] of Object.entries(h.headers || {})) {
      const name = k.toLowerCase();
      if (PASS.test(name) && typeof v === "string" && !/[\r\n\0]/.test(v)) headers[name] = v;
    }
    const req = http.request({ method, path, headers, createConnection: connect });
    let answered = false;
    req.on("response", res => {
      answered = true;
      /** @type {Record<string, string>} */
      const out = {};
      for (const [k, v] of Object.entries(res.headers)) if (!HOP.test(k) && v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : String(v);
      s.respond({ status: res.statusCode, headers: out });
      res.on("data", chunk => s.write(chunk));
      res.on("end", () => s.end());
      res.on("error", () => s.reset("response failed"));
    });
    req.on("error", e => {
      if (!answered) fail(s, 502, "internal", e.message);
      else s.reset("response failed");
    });
    s.ondata = chunk => req.write(chunk);
    s.onend = () => req.end();
    // The device gave up (closed an event stream, say): end the router's side too.
    s.onreset = () => req.destroy();
  };
  channel.onclose = () => server.close();
}
