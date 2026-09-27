// @ts-check
// bridge: each stream a paired device opens becomes a real HTTP request to vyred's own router
// (ADR 0026, section 4). Node's http client writes the request into one end of an in-memory
// duplex, and a private http.Server reads it from the other and hands it to ctx.handler with the
// caller the relay established. So every route, the SSE stream, the presence header and the
// router's own checks work exactly as they do for the tailnet listener, and nothing here parses
// HTTP.
//
// A stream with a `ws` head (/v1/streams/<module>/<name>, Glass's screen) becomes a real upgrade
// through vyred's stream router in the same way. The bridge is the WebSocket client: it answers
// the server's pings itself, and each whole message crosses the channel as one data frame,
// `[1 text | 2 binary][message]`, never split.

import http from "node:http";
import crypto from "node:crypto";
import { duplexPair } from "node:stream";
import { clientFrame, ServerFrames, OP, MAX_MESSAGE } from "./wsclient.js";
import { FRAME } from "./channel.js";

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
 * @param {{ handler: (req: any, res: any, caller: string, peer: any) => any, caller: string, peer: any,
 *   upgrade?: () => (req: any, socket: any, head: Buffer, caller: string) => void, log?: (m: string) => void }} o
 */
export function bridge(channel, o) {
  const server = http.createServer((req, res) => o.handler(req, res, o.caller, o.peer));
  server.on("upgrade", (req, socket, head) => {
    if (!o.upgrade) { socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n"); return; }
    o.upgrade()(req, socket, head, o.caller);
  });
  const connect = () => {
    const [client, side] = duplexPair();
    server.emit("connection", side);
    return client;
  };
  channel.onstream = s => {
    const h = s.head || {};
    if (JSON.stringify(h).length > MAX_HEAD) return fail(s, 431, "bad_input", "request head too large");
    if (h.ws) return socketStream(s, h);
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

  /** A device's WebSocket: upgrade through the stream router, then carry whole messages. */
  function socketStream(s, h) {
    const path = String(h.ws || "");
    if (!/^\/v1\/streams\/[a-z0-9-]+\/[a-z0-9-]+(\?[^\s\0#]*)?$/.test(path)) return fail(s, 400, "bad_input", "a stream path is /v1/streams/<module>/<name>");
    /** @type {Record<string, string>} */
    const headers = { host: "relay", connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
      "sec-websocket-key": crypto.randomBytes(16).toString("base64") };
    const proto = h.headers && h.headers["sec-websocket-protocol"];
    if (typeof proto === "string" && /^[\w ,.-]{1,128}$/.test(proto)) headers["sec-websocket-protocol"] = proto;
    const req = http.request({ method: "GET", path, headers, createConnection: connect });
    /** @type {import("node:stream").Duplex|null} */
    let sock = null;
    let done = false;
    const finish = (why = "") => {
      if (done) return;
      done = true;
      if (sock) { try { sock.end(clientFrame(Buffer.from([0x03, 0xe8]), OP.close)); } catch {} sock.destroy(); }
      why ? s.reset(why) : s.end();
    };
    req.on("response", res => {
      // The router refused the upgrade (403, 404): hand the device the status and the body.
      s.respond({ status: res.statusCode, headers: { "content-type": String(res.headers["content-type"] || "text/plain") } });
      res.on("data", chunk => s.write(chunk));
      res.on("end", () => { done = true; s.end(); });
    });
    req.on("upgrade", (res, socket, head) => {
      sock = socket;
      /** @type {Record<string, string>} */
      const out = {};
      if (res.headers["sec-websocket-protocol"]) out["sec-websocket-protocol"] = String(res.headers["sec-websocket-protocol"]);
      s.respond({ status: 101, headers: out });
      const frames = new ServerFrames();
      const take = chunk => {
        let got;
        try { got = frames.push(chunk); } catch (e) { finish(String(/** @type {any} */ (e).message)); return; }
        for (const f of got) {
          if (f.op === OP.ping) { try { socket.write(clientFrame(f.payload, OP.pong)); } catch {} }
          else if (f.op === OP.close) finish();
          else if (f.op === OP.text || f.op === OP.binary) s.ch.frame(FRAME.data, s.id, Buffer.concat([Buffer.from([f.op]), f.payload]));
        }
      };
      if (head && head.length) take(head);
      socket.on("data", take);
      socket.on("close", () => finish());
      socket.on("error", () => finish("stream failed"));
    });
    req.on("error", e => { if (!sock && !done) fail(s, 502, "internal", e.message); else finish("stream failed"); });
    req.end();
    s.ondata = msg => {
      if (!sock || done || msg.length < 1) return;
      const op = msg[0] === 1 ? OP.text : OP.binary;
      if (msg.length - 1 > MAX_MESSAGE) { finish("message too big"); return; }
      try { sock.write(clientFrame(msg.subarray(1), op)); } catch {}
    };
    s.onend = () => finish();
    s.onreset = () => { done = true; if (sock) sock.destroy(); else req.destroy(); };
  }
}
