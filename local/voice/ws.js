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
// core/computers/ws.js does the server half for Glass. A module does not import another
// module's files, so this is its own copy, extended with masking for the client direction and
// text frames.

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** One message larger than this is not speech control or a transcript; refuse to buffer it. */
const MAX_FRAME = 4_000_000;

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return crypto.createHash("sha1").update(String(key) + GUID).digest("base64");
}

/**
 * One frame, fin set. A server never masks and a client always does (RFC 6455 5.1), so the
 * caller says which end it is.
 * @param {Buffer} payload @param {number} opcode 1 text, 2 binary, 8 close, 9 ping, 10 pong
 * @param {boolean} [mask]
 */
export function encodeFrame(payload, opcode, mask = false) {
  const len = payload.length;
  const bit = mask ? 0x80 : 0;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, bit | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = bit | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = bit | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([header, payload]);
  const key = crypto.randomBytes(4);
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([header, key, out]);
}

/**
 * @typedef {{ text?: string, binary?: Buffer, control?: "close"|"ping"|"pong", payload?: Buffer, code?: number }} WSEvent
 */

/**
 * Cuts a byte stream into whole messages. `masked` is what the other end must do: a server
 * parsing a client requires masking (an unmasked client frame is not a real WebSocket client),
 * and a client parsing a server requires the opposite.
 */
export class FrameParser {
  /** @param {{ masked: boolean }} opts */
  constructor({ masked }) {
    this.masked = masked;
    this.buf = Buffer.alloc(0);
    /** @type {Buffer[]} */
    this.fragments = [];
    /** @type {number|null} */
    this.fragOpcode = null;
  }

  /** @param {Buffer} chunk @returns {WSEvent[]} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    /** @type {WSEvent[]} */
    const out = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = Boolean(b0 & 0x80), opcode = b0 & 0x0f, masked = Boolean(b1 & 0x80);
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buf.length < 4) break; len = this.buf.readUInt16BE(2); offset = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) throw new Error("a WebSocket frame over the voice limit");
        len = Number(big); offset = 10;
      }
      if (len > MAX_FRAME) throw new Error("a WebSocket frame over the voice limit");
      if (masked !== this.masked) throw new Error(this.masked ? "a client frame must be masked (RFC 6455 5.2)" : "a server frame must not be masked (RFC 6455 5.1)");
      const keyLen = masked ? 4 : 0;
      const total = offset + keyLen + len;
      if (this.buf.length < total) break;
      let payload = this.buf.subarray(offset + keyLen, total);
      if (masked) {
        const key = this.buf.subarray(offset, offset + 4);
        const plain = Buffer.alloc(len);
        for (let i = 0; i < len; i++) plain[i] = payload[i] ^ key[i & 3];
        payload = plain;
      } else payload = Buffer.from(payload);
      this.buf = this.buf.subarray(total);

      if (opcode === 0x8) { out.push({ control: "close", payload, code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005 }); continue; }
      if (opcode === 0x9) { out.push({ control: "ping", payload }); continue; }
      if (opcode === 0xa) { out.push({ control: "pong", payload }); continue; }
      let op = opcode, whole = payload;
      if (opcode === 0x0) {
        if (this.fragOpcode === null) throw new Error("a continuation frame with nothing to continue");
        this.fragments.push(payload);
        if (!fin) continue;
        whole = Buffer.concat(this.fragments); op = this.fragOpcode;
        this.fragments = []; this.fragOpcode = null;
      } else if (opcode !== 0x1 && opcode !== 0x2) throw new Error(`unknown WebSocket opcode ${opcode}`);
      else if (!fin) { this.fragOpcode = opcode; this.fragments = [payload]; continue; }
      out.push(op === 0x1 ? { text: whole.toString("utf8") } : { binary: whole });
    }
    return out;
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
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
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
    let done = false;
    const finish = v => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
    const where = socketPath ? { socketPath } : { host: u.hostname, port: u.port || (u.protocol === "wss:" ? 443 : 80) };
    const req = lib.request({ ...where, path: u.pathname + u.search, method: "GET", agent: false,
      headers: { ...headers, connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key } });
    const timer = setTimeout(() => { req.destroy(); finish({ unreachable: "timeout" }); }, timeout);
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
  });
}
