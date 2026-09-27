// @ts-check
// channel: the device side of the relay channel (ADR 0026, sections 3 and 4), frame for frame the
// same as core/relay/channel.js, whose box side it talks to. Transport-agnostic: give it
// `send(bytes)` and `close(code, reason)`, feed it every binary message with `receive(bytes)`.
//
//   [type u8][stream u32 big-endian][payload]   1 head, 2 data, 3 end, 4 reset
//
// Crypto is async here, so frames go out and come in through two queues: the counter nonces must
// match the order on the wire. Devices open odd stream ids. Any decrypt failure closes the channel.

import { Initiator, MAX_NONCE } from "./noise.js";
import { EMPTY, utf8, fromUtf8 } from "./bytes.js";

export { MAX_NONCE };

export const FRAME = Object.freeze({ head: 1, data: 2, end: 3, reset: 4, ping: 5, pong: 6 });
/** Body bytes per data frame, as on the box. */
export const CHUNK = 64 * 1024;
/** Both sides rekey after this many messages in a direction. */
export const REKEY_EVERY = 2 ** 20;
/** A session lasts at most a day; then the client handshakes again. */
export const MAX_AGE = 24 * 60 * 60 * 1000;
/** The Noise prologue's prefix, as in core/relay/wire.js. */
export const PROLOGUE_TAG = "vyre-relay-v1";
/** The relay forwards frames of at most 1 MiB. */
export const MAX_FRAME = 1 << 20;

/** @param {string} route */
export const prologue = route => utf8(`${PROLOGUE_TAG}\n${route}`);

/**
 * @typedef {{ send: (bytes: Uint8Array) => void, close: (code?: number, reason?: string) => void }} Transport
 */

export class Channel {
  /**
   * @param {Transport} transport
   * @param {import("./noise.js").CipherState} send
   * @param {import("./noise.js").CipherState} recv
   * @param {{ peer: Uint8Array, hash: Uint8Array, now?: () => number, rekeyEvery?: number }} info
   */
  constructor(transport, send, recv, info) {
    this.transport = transport;
    this.tx = send;
    this.rx = recv;
    this.peer = info.peer;
    this.hash = info.hash;
    this.now = info.now || (() => Date.now());
    this.rekeyEvery = info.rekeyEvery || REKEY_EVERY;
    this.opened = this.now();
    this.closed = false;
    /** @type {Map<number, Stream>} */
    this.streams = new Map();
    this.nextId = 1;
    /** @type {Promise<void>} */ this.txq = Promise.resolve();
    /** @type {Promise<void>} */ this.rxq = Promise.resolve();
    /** @type {(reason: string) => void} */
    this.onclose = () => {};
  }

  /** Queue one frame; frames leave in call order. @param {number} type @param {number} id @param {Uint8Array} [payload] */
  frame(type, id, payload = EMPTY) {
    if (this.closed) return;
    if (this.now() - this.opened > MAX_AGE) { this.close(1000, "session too old"); return; }
    const pt = new Uint8Array(5 + payload.length);
    pt[0] = type;
    new DataView(pt.buffer).setUint32(1, id);
    pt.set(payload, 5);
    this.txq = this.txq.then(async () => {
      if (this.closed) return;
      const ct = await this.tx.encrypt(EMPTY, pt);
      if (this.tx.n % this.rekeyEvery === 0) await this.tx.rekey();
      if (!this.closed) this.transport.send(ct);
    }).catch(e => this.close(1011, String(e?.message || e)));
  }

  /** @param {Uint8Array} bytes one binary WebSocket message */
  receive(bytes) {
    const b = bytes.slice();
    this.rxq = this.rxq.then(() => this.take(b), () => {});
  }

  /** @param {Uint8Array} bytes */
  async take(bytes) {
    if (this.closed) return;
    let pt;
    try { pt = await this.rx.decrypt(EMPTY, bytes); } catch { this.close(4400, "decrypt failed"); return; }
    if (this.rx.n % this.rekeyEvery === 0) await this.rx.rekey();
    if (this.closed) return;
    if (pt.length < 5) { this.close(4400, "short frame"); return; }
    const type = pt[0], id = new DataView(pt.buffer, pt.byteOffset).getUint32(1), payload = pt.subarray(5);
    // Stream 0 is the box measuring the round trip: send its bytes straight back.
    if (id === 0) { if (type === FRAME.ping) this.frame(FRAME.pong, 0, payload.slice()); return; }
    const s = this.streams.get(id);
    if (!s) return;                                    // the box never opens streams; late frames for a stream already gone
    if (type === FRAME.head) {
      let head;
      try { head = JSON.parse(fromUtf8(payload)); } catch { s.reset("bad head"); return; }
      s.onhead(head);
    } else if (type === FRAME.data) s.ondata(payload.slice());
    else if (type === FRAME.end) { s.remoteEnded = true; s.onend(); s.gc(); }
    else if (type === FRAME.reset) { this.streams.delete(id); s.onreset(fromUtf8(payload)); }
  }

  /** Open a stream with this head (a request, or a WebSocket open). */
  open(head) {
    if (this.closed) throw Object.assign(new Error("channel closed"), { lost: true });
    const id = this.nextId;
    this.nextId += 2;
    const s = new Stream(this, id);
    s.head = head;
    this.streams.set(id, s);
    this.frame(FRAME.head, id, utf8(JSON.stringify(head)));
    if (this.nextId >= 2 ** 32) this.close(1000, "streams exhausted");
    return s;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    const streams = [...this.streams.values()];
    this.streams.clear();
    for (const s of streams) s.onreset(reason || "channel closed");
    try { this.transport.close(code, reason); } catch {}
    this.onclose(reason);
  }
}

/** One request, response or WebSocket inside a channel. Set the on* handlers you need. */
export class Stream {
  /** @param {Channel} ch @param {number} id */
  constructor(ch, id) {
    this.ch = ch;
    this.id = id;
    /** @type {any} */ this.head = null;
    this.localEnded = false;
    this.remoteEnded = false;
    /** @type {(head: any) => void} */ this.onhead = () => {};
    /** @type {(chunk: Uint8Array) => void} */ this.ondata = () => {};
    /** @type {() => void} */ this.onend = () => {};
    /** @type {(reason: string) => void} */ this.onreset = () => {};
  }
  /** Body bytes, split into CHUNK-sized data frames. @param {Uint8Array} bytes */
  write(bytes) {
    for (let i = 0; i < bytes.length; i += CHUNK) this.ch.frame(FRAME.data, this.id, bytes.subarray(i, i + CHUNK));
  }
  end() { if (this.localEnded) return; this.localEnded = true; this.ch.frame(FRAME.end, this.id); this.gc(); }
  reset(reason = "") {
    if (!this.ch.streams.has(this.id)) return;
    this.ch.frame(FRAME.reset, this.id, utf8(reason));
    this.ch.streams.delete(this.id);
  }
  gc() { if (this.localEnded && this.remoteEnded) this.ch.streams.delete(this.id); }
}

/**
 * The device's side of the handshake over any transport. Resolves with the open channel and the
 * box's reply payload.
 * @param {Transport} transport
 * @param {{ crypto: import("./noise.js").CryptoProvider, s: import("./noise.js").KeyPair, box: Uint8Array, route: string,
 *   hello: any, e?: import("./noise.js").KeyPair, now?: () => number, rekeyEvery?: number }} o
 * @returns {{ receive: (bytes: Uint8Array) => void, gone: (reason: string) => void, ready: Promise<{ channel: Channel, reply: any }> }}
 */
export function dial(transport, o) {
  const hs = new Initiator(o.crypto, { s: o.s, rs: o.box, prologue: prologue(o.route), e: o.e });
  /** @type {Channel|null} */
  let channel = null;
  let failed = false;
  /** @type {{ resolve: (v: any) => void, reject: (e: any) => void }} */
  let settle = /** @type {any} */ (null);
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const fail = msg => { if (failed || channel) return; failed = true; settle.reject(new Error(msg)); };
  let q = hs.writeMessage(utf8(JSON.stringify(o.hello))).then(m1 => { if (!failed) transport.send(m1); }, e => {
    transport.close(4400, "handshake failed");
    fail(String(e?.message || e));
  });
  return {
    ready,
    gone(reason) { channel ? channel.close(1000, reason) : fail(reason || "connection closed"); },
    receive(bytes) {
      const b = bytes.slice();
      q = q.then(async () => {
        if (channel) return channel.receive(b);
        if (failed) return;
        let reply;
        try { reply = JSON.parse(fromUtf8(await hs.readMessage(b))); } catch {
          transport.close(4400, "handshake failed");
          fail("handshake failed: this is not the box in the QR code");
          return;
        }
        channel = new Channel(transport, /** @type {any} */ (hs.send), /** @type {any} */ (hs.recv),
          { peer: o.box, hash: /** @type {Uint8Array} */ (hs.hash), now: o.now, rekeyEvery: o.rekeyEvery });
        settle.resolve({ channel, reply });
      }).catch(() => {});
    },
  };
}

