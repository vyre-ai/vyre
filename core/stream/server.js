// @ts-check
// server: serve one SessionLog to one connection, over anything that moves JSON (ADR 0052).
//
// serve(log, conn) is transport-agnostic. conn is { send(frame), onClose(cb), close?(), onMessage?(cb),
// buffered?(), onDrain?(cb) }. subscribe(from) replays the frames after `from` and joins the live
// fan-out in ONE synchronous step, so a frame appended while subscribing is neither missed nor sent
// twice. There is no polling: a frame is sent the moment the log appends it. The one timer is the
// heartbeat (at most every 25 s), which carries the head cursor so a client that lost a frame
// notices at once.
//
// A slow connection (buffered() over maxBuffered) stops receiving live frames and is caught up from
// the log when it drains. If it has fallen past what the log holds it is sent `reset` and closed;
// the client reads a snapshot and resumes from it (client.js).
//
// Adapters: serveSSE (HTTP, with Last-Event-ID) and serveWS (RFC 6455 over an upgraded socket,
// the helpers core/term and Glass use).

import { acceptKey, encodeFrame, FrameParser } from "../computers/ws.js";
import { heartbeatFrame, resetFrame } from "./protocol.js";

export const HEARTBEAT_MS = 25_000;
export const MAX_BUFFERED = 1024 * 1024;

/**
 * @typedef {{ send: (f: any) => void, onClose: (cb: () => void) => void, close?: () => void,
 *   onMessage?: (cb: (m: any) => void) => void, buffered?: () => number, onDrain?: (cb: () => void) => void }} Conn
 * @typedef {{ from?: number, heartbeatMs?: number, maxBuffered?: number,
 *   timers?: { setInterval: Function, clearInterval: Function } }} ServeOptions
 */

/**
 * @param {import("./log.js").SessionLog} log
 * @param {Conn} conn
 * @param {ServeOptions} [opts]
 * @returns {{ close: () => void, readonly sent: number, readonly paused: boolean }}
 */
export function serve(log, conn, opts = {}) {
  const timers = opts.timers || { setInterval, clearInterval };
  const hbMs = Math.max(1000, opts.heartbeatMs ?? HEARTBEAT_MS);
  const maxBuffered = opts.maxBuffered ?? MAX_BUFFERED;
  let sent = 0, paused = false, closed = false, subscribed = false;
  /** @type {null | (() => void)} */ let off = null;
  /** @type {any} */ let hb = null;

  const send = (/** @type {any} */ f) => { try { conn.send(f); } catch { shut(); } };
  const shut = () => {
    if (closed) return;
    closed = true;
    if (off) { off(); off = null; }
    if (hb) { timers.clearInterval(hb); hb = null; }
    try { conn.close?.(); } catch {}
  };
  const full = () => !!conn.buffered && conn.buffered() > maxBuffered;

  /**
   * Send what the log holds after `sent`, or tell the client to reset (returns false). It loops until
   * `sent` is the head, so a frame appended by a send() itself (a re-entrant emit) is not missed.
   */
  const catchUp = () => {
    while (!closed && sent < log.head) {
      const r = log.since(sent);
      if (r.reset) { send(resetFrame(log.session, sent > log.head ? "ahead" : "behind", r.head)); shut(); return false; }
      if (!r.frames.length) break;
      for (const f of r.frames) { if (closed) return false; sent = f.cur; send(f); }
    }
    if (!closed && sent > log.head) { send(resetFrame(log.session, "ahead", log.head)); shut(); return false; }
    return !closed;
  };

  const onLive = (/** @type {any} */ f) => {
    if (closed) return;
    if (paused) {
      if (full()) return;
      paused = false;
      // The log appended f already; catching up from `sent` delivers it too, in order.
      catchUp();
      return;
    }
    if (f.cur !== sent + 1) { catchUp(); return; }
    sent = f.cur; send(f);
    if (full()) paused = true;
  };

  /** @param {number} from */
  const subscribe = from => {
    if (subscribed || closed) return;
    subscribed = true;
    sent = from;
    // One synchronous step: replay, then join. Nothing can append in between.
    if (!catchUp()) return;
    off = log.subscribe(onLive);
    send(heartbeatFrame(log.session, sent));
    hb = timers.setInterval(() => {
      if (closed) return;
      if (paused && !full()) { paused = false; catchUp(); }
      send(heartbeatFrame(log.session, sent));
    }, hbMs);
    hb.unref?.();
  };

  conn.onClose(shut);
  conn.onDrain?.(() => { if (paused && !closed && !full()) { paused = false; catchUp(); } });
  if (opts.from !== undefined) subscribe(opts.from);
  else if (conn.onMessage) conn.onMessage(m => {
    if (m && m.t === "subscribe") subscribe(Number.isInteger(m.from) && m.from >= 0 ? m.from : log.head);
  });
  else subscribe(log.head);

  return { close: shut, get sent() { return sent; }, get paused() { return paused; } };
}

// ---- SSE ---------------------------------------------------------------------------------------

/**
 * Serve a log over Server-Sent Events. `from` comes from the caller (the URL) or the Last-Event-ID
 * header, which a browser EventSource sends by itself on every automatic reconnect.
 * @param {import("./log.js").SessionLog} log @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res
 * @param {ServeOptions} [opts]
 */
export function serveSSE(log, req, res, opts = {}) {
  let from = opts.from;
  if (from === undefined) {
    const h = req.headers["last-event-id"];
    const n = Number(Array.isArray(h) ? h[0] : h);
    if (h !== undefined && Number.isInteger(n) && n >= 0) from = n;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
  res.socket?.setNoDelay?.(true);
  res.write("retry: 500\n\n");
  /** @type {(() => void)[]} */ const closers = [];
  const conn = {
    send(/** @type {any} */ f) { res.write(`${f.cur ? `id: ${f.cur}\n` : ""}data: ${JSON.stringify(f)}\n\n`); },
    onClose(/** @type {() => void} */ cb) { closers.push(cb); },
    close() { try { res.end(); } catch {} },
    buffered: () => res.writableLength,
    onDrain(/** @type {() => void} */ cb) { res.on("drain", cb); },
  };
  const done = () => { for (const c of closers.splice(0)) c(); };
  res.on("close", done);
  req.on("aborted", done);
  return serve(log, conn, { ...opts, ...(from !== undefined ? { from } : {}) });
}

// ---- WebSocket ---------------------------------------------------------------------------------

/** @param {import("node:net").Socket} socket @param {number} status @param {string} reason */
function refuse(socket, status, reason) { try { socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`); } catch {} }

/**
 * Complete a WebSocket handshake on an upgraded socket and serve the log on it. Text messages out
 * are JSON frames; text messages in are {"t":"subscribe","from":n} (when `from` was not on the URL).
 * @param {import("./log.js").SessionLog} log @param {any} req @param {import("node:net").Socket} socket @param {Buffer} head
 * @param {ServeOptions} [opts]
 */
export function serveWS(log, req, socket, head, opts = {}) {
  const key = req.headers && req.headers["sec-websocket-key"];
  const upgrade = req.headers && String(req.headers["upgrade"] || "").toLowerCase();
  if (upgrade !== "websocket" || !key) { refuse(socket, 400, "Bad Request"); return null; }
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
  socket.setNoDelay?.(true);
  /** @type {(() => void)[]} */ const closers = [];
  /** @type {((m: any) => void)[]} */ const listeners = [];
  const parser = new FrameParser();
  let ended = false;
  const done = () => { if (ended) return; ended = true; for (const c of closers.splice(0)) c(); try { socket.destroy(); } catch {} };
  const onData = (/** @type {Buffer} */ chunk) => {
    let msgs;
    try { msgs = parser.push(chunk); } catch { done(); return; }
    for (const m of msgs) {
      if ("control" in m) {
        if (m.control === "close") { try { socket.write(encodeFrame(Buffer.from([0x03, 0xe8]), 0x8)); } catch {} done(); return; }
        if (m.control === "ping") { try { socket.write(encodeFrame(m.payload, 0xa)); } catch {} }
        continue;
      }
      if (m.opcode !== 1 || m.message.length > 64 * 1024) continue;
      let j; try { j = JSON.parse(m.message.toString("utf8")); } catch { continue; }
      for (const l of listeners) l(j);
    }
  };
  socket.on("data", onData);
  socket.on("close", done);
  socket.on("error", done);
  const conn = {
    send(/** @type {any} */ f) { socket.write(encodeFrame(Buffer.from(JSON.stringify(f)), 0x1)); },
    onClose(/** @type {() => void} */ cb) { closers.push(cb); },
    close() { try { socket.write(encodeFrame(Buffer.from([0x03, 0xe8]), 0x8)); } catch {} setTimeout(() => { try { socket.destroy(); } catch {} }, 200).unref?.(); },
    onMessage(/** @type {(m: any) => void} */ cb) { listeners.push(cb); },
    buffered: () => socket.writableLength,
    onDrain(/** @type {() => void} */ cb) { socket.on("drain", cb); },
  };
  const h = serve(log, conn, opts);
  // Bytes that arrived with the upgrade (a client that sent subscribe at once).
  if (head && head.length) onData(head);
  return h;
}
