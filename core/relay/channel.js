// @ts-check
// channel: the Noise IK session over one relayed WebSocket, and the streams inside it (ADR 0026,
// sections 3 and 4). Transport-agnostic: give it `send(bytes)` and `close(code, reason)`, feed it
// every binary message with `receive(bytes)`. The box side and the device side are both here so
// they are tested against each other; relay/client/ carries the device side for the Expo app.
//
// On the wire, after the two handshake messages, every WebSocket binary message is one Noise
// ciphertext. Its plaintext is one frame:
//   [type u8][stream u32 big-endian][payload]
//   1 head  JSON: a request {method, path, headers}, a response {status, headers}, or a
//           WebSocket open {ws: path, headers}
//   2 data  bytes of the body, or for a WebSocket stream [1 text | 2 binary][message]
//   3 end   the sender has no more to say on this stream
//   4 reset abandon the stream; payload is a reason
//   5 ping  on stream 0, from the box: 8 bytes the device sends straight back in
//   6 pong  on stream 0, which is how the box measures the round trip (relay.devices.list rtt)
// Devices open odd stream ids. Any decrypt failure closes the channel: a frame the relay replayed,
// dropped, reordered or reflected cannot decrypt under the next counter.

import crypto from "node:crypto";
import { Handshake, MAX_NONCE } from "./noise.js";
import { PROLOGUE_TAG } from "./wire.js";

export const FRAME = Object.freeze({ head: 1, data: 2, end: 3, reset: 4, ping: 5, pong: 6 });
/** Body bytes per data frame; well under the relay's 1 MiB frame limit after the 21 bytes of framing and tag. */
export const CHUNK = 64 * 1024;
/** Both sides rekey after this many messages in a direction, with no signal needed. */
export const REKEY_EVERY = 2 ** 20;
/** A session lasts at most a day; the device reconnects and handshakes again. */
export const MAX_AGE = 24 * 60 * 60 * 1000;

const EMPTY = Buffer.alloc(0);
export const prologue = route => Buffer.from(`${PROLOGUE_TAG}\n${route}`);

/**
 * @typedef {{ send: (bytes: Buffer) => void, close: (code?: number, reason?: string) => void }} Transport
 * @typedef {{ priv: Buffer, pub: Buffer }} Keys
 * @typedef {{ pub: Buffer, priv?: Buffer, dh?: (remotePub: Buffer) => Buffer | Promise<Buffer> }} StaticKey the box's static key: its bytes, or vyre-core's dh
 */

/** An open channel: encrypted frames in and out, streams on top. */
export class Channel {
  /** @param {Transport} transport @param {import("./noise.js").CipherState} send @param {import("./noise.js").CipherState} recv @param {{ peer: Buffer, hash: Buffer, now?: () => number }} info */
  constructor(transport, send, recv, info) {
    this.transport = transport;
    this.tx = send;
    this.rx = recv;
    this.peer = info.peer;
    this.hash = info.hash;
    this.now = info.now || Date.now;
    this.opened = this.now();
    this.closed = false;
    /** @type {Map<number, Stream>} */
    this.streams = new Map();
    this.nextId = 1;
    /** @type {(s: Stream) => void} set by the box: a device opened a stream */
    this.onstream = () => {};
    /** @type {(reason: string) => void} */
    this.onclose = () => {};
    /** @type {Map<string, (ms: number) => void>} pings waiting for their pong */
    this.pings = new Map();
  }

  /**
   * The round trip to the device in ms, or null when it does not answer in time (an older client
   * never does). Asked on demand, never on a timer.
   * @param {number} [timeout]
   * @returns {Promise<number|null>}
   */
  ping(timeout = 1000) {
    if (this.closed) return Promise.resolve(null);
    const nonce = crypto.randomBytes(8);
    const key = nonce.toString("hex");
    const t0 = performance.now();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pings.delete(key); resolve(null); }, timeout);
      timer.unref?.();
      this.pings.set(key, () => { clearTimeout(timer); resolve(Math.round(performance.now() - t0)); });
      this.frame(FRAME.ping, 0, nonce);
    });
  }

  /** @param {number} type @param {number} id @param {Buffer} payload */
  frame(type, id, payload = EMPTY) {
    if (this.closed) return;
    if (this.now() - this.opened > MAX_AGE) { this.close(1000, "session too old"); return; }
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32BE(id, 1);
    let ct;
    try { ct = this.tx.encrypt(EMPTY, Buffer.concat([head, payload])); } catch (e) { this.close(1011, String(/** @type {any} */ (e).message)); return; }
    if (this.tx.n % REKEY_EVERY === 0) this.tx.rekey();
    this.transport.send(ct);
  }

  /** @param {Buffer} bytes one binary WebSocket message */
  receive(bytes) {
    if (this.closed) return;
    let pt;
    try { pt = this.rx.decrypt(EMPTY, bytes); } catch { this.close(4400, "decrypt failed"); return; }
    if (this.rx.n % REKEY_EVERY === 0) this.rx.rekey();
    if (pt.length < 5) { this.close(4400, "short frame"); return; }
    const type = pt[0], id = pt.readUInt32BE(1), payload = pt.subarray(5);
    if (id === 0) {
      if (type === FRAME.ping) this.frame(FRAME.pong, 0, Buffer.from(payload));
      else if (type === FRAME.pong) { const k = payload.toString("hex"); this.pings.get(k)?.(0); this.pings.delete(k); }
      return;
    }
    let s = this.streams.get(id);
    if (!s) {
      if (type !== FRAME.head) return;             // late frames for a stream already gone
      s = new Stream(this, id);
      this.streams.set(id, s);
      let head;
      try { head = JSON.parse(payload.toString()); } catch { s.reset("bad head"); return; }
      s.head = head;
      this.onstream(s);
      return;
    }
    if (type === FRAME.head) {
      try { s.onhead(JSON.parse(payload.toString())); } catch { s.reset("bad head"); }
    } else if (type === FRAME.data) s.ondata(Buffer.from(payload));
    else if (type === FRAME.end) { s.remoteEnded = true; s.onend(); s.gc(); }
    else if (type === FRAME.reset) { this.streams.delete(id); s.onreset(payload.toString()); }
  }

  /** Device side: open a stream with this head. */
  open(head) {
    const id = this.nextId;
    this.nextId += 2;
    if (this.nextId >= 2 ** 32) { this.close(1000, "streams exhausted"); }
    const s = new Stream(this, id);
    s.head = head;
    this.streams.set(id, s);
    this.frame(FRAME.head, id, Buffer.from(JSON.stringify(head)));
    return s;
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams.values()) s.onreset(reason || "channel closed");
    this.streams.clear();
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
    /** @type {any} the head that opened it */
    this.head = null;
    this.localEnded = false;
    this.remoteEnded = false;
    /** @type {(head: any) => void} */ this.onhead = () => {};
    /** @type {(chunk: Buffer) => void} */ this.ondata = () => {};
    /** @type {() => void} */ this.onend = () => {};
    /** @type {(reason: string) => void} */ this.onreset = () => {};
  }
  /** Answer with a head (a response, or 101 for a WebSocket). */
  respond(head) { this.ch.frame(FRAME.head, this.id, Buffer.from(JSON.stringify(head))); }
  /** @param {Buffer} bytes */
  write(bytes) {
    for (let i = 0; i < bytes.length; i += CHUNK) this.ch.frame(FRAME.data, this.id, bytes.subarray(i, i + CHUNK));
  }
  end() { if (this.localEnded) return; this.localEnded = true; this.ch.frame(FRAME.end, this.id); this.gc(); }
  reset(reason = "") { this.ch.frame(FRAME.reset, this.id, Buffer.from(reason)); this.ch.streams.delete(this.id); }
  gc() { if (this.localEnded && this.remoteEnded) this.ch.streams.delete(this.id); }
}

/**
 * The device's side of the handshake. Resolves with the open channel and the box's reply payload.
 * @param {Transport & { onmessage?: any }} transport
 * @param {{ s: Keys, box: Buffer, route: string, hello: any, e?: Keys }} o
 * @returns {{ receive: (bytes: Buffer) => void, gone: (reason: string) => void, ready: Promise<{ channel: Channel, reply: any }> }}
 */
export function deviceSide(transport, o) {
  const hs = new Handshake({ initiator: true, s: o.s, rs: o.box, prologue: prologue(o.route), e: o.e });
  /** @type {Channel|null} */
  let channel = null;
  let settle;
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  transport.send(hs.writeMessage(Buffer.from(JSON.stringify(o.hello))));
  return {
    ready,
    /** The transport closed: fail the handshake, or close the channel. */
    gone(reason) { channel ? channel.close(1000, reason) : settle.reject(new Error(reason || "connection closed")); },
    receive(bytes) {
      if (channel) return channel.receive(bytes);
      let reply;
      try { reply = JSON.parse(hs.readMessage(bytes).toString()); } catch (e) {
        transport.close(4400, "handshake failed");
        settle.reject(new Error("handshake failed: this is not the box in the QR code"));
        return;
      }
      channel = new Channel(transport, /** @type {any} */ (hs.send), /** @type {any} */ (hs.recv), { peer: o.box, hash: /** @type {Buffer} */ (hs.hash) });
      settle.resolve({ channel, reply });
    },
  };
}

/**
 * The box's side. `admit` sees the device's static key and hello and returns the reply payload,
 * or throws to refuse (the connection closes with the error's message and nothing else is read).
 * @param {Transport} transport
 * @param {{ s: StaticKey, route: string, admit: (devicePub: Buffer, hello: any) => Promise<any>, now?: () => number }} o
 * @returns {{ receive: (bytes: Buffer) => void, gone: (reason: string) => void, ready: Promise<{ channel: Channel, hello: any, reply: any }> }}
 */
export function boxSide(transport, o) {
  const hs = new Handshake({ initiator: false, s: o.s, prologue: prologue(o.route) });
  /** @type {Channel|null} */
  let channel = null;
  let pending = false;
  let settle;
  const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  return {
    ready,
    gone(reason) { channel ? channel.close(1000, reason) : settle.reject(new Error(reason || "connection closed")); },
    async receive(bytes) {
      if (channel) return channel.receive(bytes);
      // The device holds no transport key until it reads the box's reply, so nothing real can
      // arrive while admit runs.
      if (pending) { transport.close(4400, "frame before the handshake finished"); return; }
      pending = true;
      let hello, reply;
      try {
        hello = JSON.parse((await hs.readMessageAsync(bytes)).toString());
        reply = await o.admit(/** @type {Buffer} */ (hs.rs), hello);
      } catch (e) {
        const reason = String(/** @type {any} */ (e)?.message || "refused").slice(0, 120);
        transport.close(4401, reason);
        settle.reject(new Error(reason));
        return;
      }
      const m2 = hs.writeMessage(Buffer.from(JSON.stringify(reply)));
      transport.send(m2);
      channel = new Channel(transport, /** @type {any} */ (hs.send), /** @type {any} */ (hs.recv), { peer: /** @type {Buffer} */ (hs.rs), hash: /** @type {Buffer} */ (hs.hash), now: o.now });
      settle.resolve({ channel, hello, reply });
    },
  };
}

export { MAX_NONCE };
