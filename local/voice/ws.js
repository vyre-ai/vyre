// @ts-check
// ws: the small part of RFC 6455 voice needs, on both ends of the relay.
//
// The Capsule's side is a server: vyred has already parsed the HTTP upgrade, and the stream
// handler owns the raw socket from then on. The provider's side is a client. Node's global
// WebSocket would do for the client, except that it hides the handshake: a 401 for a revoked
// key and a network that is not there both arrive as "error" then close 1006, and the person
// holding the push-to-talk key needs to be told which one it was. So the client handshake is
// done here too, over http(s).request, where the response status is plain to read.
//
// The framing is lib/ws.js, shared with Glass, the stream router, the terminal and the relay; this file adds what voice needs on top: a Peer over a raw socket, text and JSON messages, and the
// client handshake.

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { pin } from "../../lib/http.js";
import { acceptKey, encodeFrame, upgradeHead, FrameParser as BaseParser } from "../../lib/ws.js";

/** One message larger than this is not speech control or a transcript; refuse to buffer it. */
const MAX_FRAME = 4_000_000;

export { acceptKey, encodeFrame };

/**
 * @typedef {{ text?: string, binary?: Buffer, control?: "close"|"ping"|"pong", payload?: Buffer, code?: number }} WSEvent
 */

/**
 * lib/ws.js's parser, answering in voice's event shape: { text } or { binary } for a message, { control, payload, code } for ping, pong and close. `masked` is what the other end must do.
 */
export class FrameParser extends BaseParser {
  /** @param {{ masked: boolean }} opts */
  constructor({ masked }) { super({ masked, max: MAX_FRAME }); }

  /** @param {Buffer} chunk @returns {WSEvent[]} */
  push(chunk) {
    return /** @type {any[]} */ (super.push(chunk)).map(e => e.control ? e : e.opcode === 0x1 ? { text: e.message.toString("utf8") } : { binary: e.message });
  }
}

/**
 * One end of an open WebSocket over a raw socket: send text or binary, get messages through
 * `on`, close with a code. Pings are answered here so neither side has to.
 */
export class Peer {
  /**
   * @param {import("node:stream").Duplex} socket
   * @param {{ client: boolean, head?: Buffer }} opts client: this end masks what it sends
   */
  constructor(socket, { client, head }) {
    this.socket = socket;
    this.client = client;
    this.open = true;
    this.parser = new FrameParser({ masked: !client });
    // Messages and the close that arrive before anyone listens are held, not dropped: the bytes
    // after a 101 can come in the same read as the handshake, before the caller has had a
    // chance to call on().
    /** @type {WSEvent[]} */
    this.queue = [];
    /** @type {((e: WSEvent) => void)|null} */
    this.onMessage = null;
    /** @type {((code: number) => void)|null} */
    this.onClose = null;
    /** @type {number|null} */
    this.closedWith = null;
    this.closeCode = 1006;
    socket.on("data", chunk => this.data(chunk));
    socket.on("close", () => this.gone());
    socket.on("error", () => this.gone());
    if (head && head.length) this.data(head);
  }

  /** @param {"message"|"close"} what @param {any} fn */
  on(what, fn) {
    if (what === "message") { this.onMessage = fn; const q = this.queue; this.queue = []; for (const e of q) fn(e); }
    else { this.onClose = fn; if (this.closedWith !== null) { const c = this.closedWith; this.closedWith = null; this.onClose = null; fn(c); } }
    return this;
  }

  /** @param {WSEvent} e */
  deliver(e) { if (this.onMessage) this.onMessage(e); else this.queue.push(e); }

  /** @param {number} code */
  ended(code) {
    const fn = this.onClose;
    this.onClose = null;
    if (fn) fn(code); else this.closedWith = code;
  }

  /** @param {Buffer} chunk */
  data(chunk) {
    if (!this.open) return;
    let events;
    try { events = this.parser.push(chunk); }
    catch { this.close(1002); return; }
    for (const e of events) {
      if (e.control === "ping") { this.raw(/** @type {Buffer} */ (e.payload), 0xa); continue; }
      if (e.control === "pong") continue;
      if (e.control === "close") { this.closeCode = e.code || 1005; this.close(e.code && e.code >= 1000 && e.code < 5000 && e.code !== 1005 ? e.code : 1000); return; }
      this.deliver(e);
    }
  }

  /** @param {Buffer} payload @param {number} opcode */
  raw(payload, opcode) {
    if (!this.open) return false;
    try { this.socket.write(encodeFrame(payload, opcode, this.client)); return true; } catch { return false; }
  }

  /** @param {any} obj */
  json(obj) { return this.raw(Buffer.from(JSON.stringify(obj)), 0x1); }
  /** @param {Buffer} buf */
  binary(buf) { return this.raw(buf, 0x2); }

  /** Say goodbye and end the socket. Safe to call twice. @param {number} [code] */
  close(code = 1000) {
    if (!this.open) return;
    const b = Buffer.alloc(2); b.writeUInt16BE(code, 0);
    try { this.socket.write(encodeFrame(b, 0x8, this.client)); } catch {}
    this.open = false;
    try { this.socket.end(); } catch {}
    // A peer that never answers the close must not hold the socket; end() alone waits on it.
    const s = this.socket;
    const guard = setTimeout(() => { try { s.destroy(); } catch {} }, 1000).unref();
    s.once("close", () => clearTimeout(guard));
    this.ended(this.closeCode === 1006 ? code : this.closeCode);
  }

  gone() {
    if (!this.open) return;
    this.open = false;
    this.ended(this.closeCode);
  }
}

/**
 * Accept a WebSocket that vyred handed over: check the handshake, answer 101, and return the
 * open Peer, or null after refusing with an HTTP status.
 * @param {any} req @param {import("node:stream").Duplex} socket @param {Buffer} head
 */
export function accept(req, socket, head) {
  const key = req.headers && req.headers["sec-websocket-key"];
  const upgrade = req.headers && String(req.headers.upgrade || "").toLowerCase();
  if (upgrade !== "websocket" || !key) { refuse(socket, 400, "Bad Request"); return null; }
  socket.write(upgradeHead(key));
  return new Peer(socket, { client: false, head });
}

/** Refuse an upgrade with a status and a short JSON reason, then end the socket. */
export function refuse(socket, status, text, body = null) {
  const b = body ? JSON.stringify(body) : "";
  try { socket.end(`HTTP/1.1 ${status} ${text}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(b)}\r\nconnection: close\r\n\r\n${b}`); } catch {}
}

/**
 * Open a client WebSocket. Resolves { peer } once the server switched protocols, or
 * { status } when it answered with anything else, or { unreachable } when no connection could
 * be made at all. The headers go only to the server named in `url`; they carry the key.
 * @param {string} url ws: or wss:
 * `socketPath` dials a unix socket instead (vyred's own, for the Capsule's side and tests).
 * @param {{ headers?: Record<string, string>, timeout?: number, socketPath?: string }} [opts]
 * @returns {Promise<{ peer?: Peer, status?: number, body?: string, unreachable?: string }>}
 */
export function connect(url, { headers = {}, timeout = 8000, socketPath } = {}) {
  const u = new URL(url);
  const lib = u.protocol === "wss:" ? https : http;
  const key = crypto.randomBytes(16).toString("base64");
  return new Promise(resolve => {
    let done = false, timer;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    // The provider's address is checked like any other request that leaves the machine (lib/http.js pin): a public address, and the connection goes to the address that was checked.
    const dial = socketPath ? Promise.resolve(null) : pin(new URL(url.replace(/^ws/, "http")), {});
    dial.then(address => {
    const where = socketPath ? { socketPath } : { host: u.hostname, port: u.port || (u.protocol === "wss:" ? 443 : 80), ...(address ? { lookup: (_h, o, cb) => (o && o.all ? cb(null, [{ address, family: address.includes(":") ? 6 : 4 }]) : cb(null, address, address.includes(":") ? 6 : 4)) } : {}) };
    const req = lib.request({ ...where, path: u.pathname + u.search, method: "GET", agent: false,
      headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key } });
    timer = setTimeout(() => { req.destroy(); finish({ unreachable: "timeout" }); }, timeout);
    req.on("upgrade", (res, socket, head) => {
      if (res.headers["sec-websocket-accept"] !== acceptKey(key)) { socket.destroy(); finish({ status: 502 }); return; }
      finish({ peer: new Peer(socket, { client: true, head }) });
    });
    // The body of a refusal is kept only for vyred's own refusals, which tests read; the
    // provider path looks at the status alone and never passes a provider's words on.
    req.on("response", res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { if (body.length < 2000) body += c; });
      res.on("end", () => finish({ status: res.statusCode || 500, body }));
      res.on("error", () => finish({ status: res.statusCode || 500 }));
    });
    req.on("error", e => finish({ unreachable: /** @type {any} */ (e).code || "error" }));
    req.end();
    }, e => finish({ unreachable: /** @type {any} */ (e).code || "not_public" }));
  });
}
