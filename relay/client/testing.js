// @ts-check
// Test helpers for relay/client (not shipped): @noble's shapes built from node:crypto, and an
// in-memory "relay" whose WebSocket class connects a client straight to core/relay/channel.js's
// box side, so reconnects, stalls and drops can be driven without a network or real waits.

import nodeCrypto from "node:crypto";
import { keyPair } from "../../core/relay/noise.js";
import { boxSide } from "../../core/relay/channel.js";

export const ROUTE = "abcdefghijklmnopqrstuvwxyz";

/** @noble's function shapes, from node:crypto, so nobleCrypto() runs without the dependency. */
export function nodeNoble() {
  const PK = Buffer.from("302e020100300506032b656e04220420", "hex"), SPKI = Buffer.from("302a300506032b656e032100", "hex");
  const priv = raw => nodeCrypto.createPrivateKey({ key: Buffer.concat([PK, raw]), format: "der", type: "pkcs8" });
  const u8 = b => new Uint8Array(b);
  return {
    x25519: {
      getPublicKey: raw => u8(nodeCrypto.createPublicKey(priv(raw)).export({ format: "der", type: "spki" }).subarray(-32)),
      getSharedSecret: (raw, pub) => u8(nodeCrypto.diffieHellman({ privateKey: priv(raw), publicKey: nodeCrypto.createPublicKey({ key: Buffer.concat([SPKI, pub]), format: "der", type: "spki" }) })),
      utils: { randomSecretKey: () => u8(nodeCrypto.randomBytes(32)) },
    },
    sha256: b => u8(nodeCrypto.createHash("sha256").update(b).digest()),
    hmac: (_hash, key, msg) => u8(nodeCrypto.createHmac("sha256", key).update(msg).digest()),
    gcm: (key, nonce, aad) => ({
      encrypt(pt) {
        const c = nodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
        if (aad) c.setAAD(aad);
        return u8(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]));
      },
      decrypt(ct) {
        const d = nodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
        if (aad) d.setAAD(aad);
        d.setAuthTag(ct.subarray(ct.length - 16));
        return u8(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
      },
    }),
    randomBytes: n => u8(nodeCrypto.randomBytes(n)),
  };
}

/** Collect a box-side stream's request body, then call `handle(stream, head, body)`. */
export function serveWith(handle) {
  return channel => {
    channel.onstream = s => {
      const parts = [];
      s.ondata = c => parts.push(c);
      s.onend = () => handle(s, s.head, Buffer.concat(parts));
    };
  };
}

/** Answer a box-side stream with JSON. */
export function reply(s, status, body, headers = {}) {
  s.respond({ status, headers: { "content-type": "application/json", ...headers } });
  s.write(Buffer.from(JSON.stringify(body)));
  s.end();
}

/**
 * An in-memory relay plus box. `WebSocket` is a class the client can take; each instance runs the
 * box's side of the handshake and hands the channel to `serve`.
 * @param {{ serve: (channel: any) => void, admit?: (pub: Buffer, hello: any) => Promise<any>, route?: string }} o
 */
export function memoryBox(o) {
  const box = keyPair();
  const route = o.route || ROUTE;
  const world = {
    box, route,
    /** @type {any[]} */ sockets: [],
    /** the relay answers "ping" with "pong" */
    pong: true,
    /** @type {any[]} */ hellos: [],
    dials: 0,
    /** refuse new sockets (the relay is unreachable) */
    down: false,
    WebSocket: /** @type {any} */ (null),
  };
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.binaryType = "blob";
      this.pings = 0;
      /** @type {any} */ this.onopen = null; /** @type {any} */ this.onmessage = null;
      /** @type {any} */ this.onclose = null; /** @type {any} */ this.onerror = null;
      world.dials++;
      world.sockets.push(this);
      this.side = boxSide({ send: b => this.deliver(new Uint8Array(b).slice().buffer), close: (c, r) => this.drop(c, r) },
        { s: box, route, admit: o.admit || (async (_pub, hello) => { world.hellos.push(hello); return { v: 1, box: { name: "juno" }, device: "kitdevice00000000" }; }) });
      this.side.ready.then(({ channel }) => { this.boxChannel = channel; o.serve(channel); }, () => {});
      queueMicrotask(() => {
        if (world.down) { this.drop(1006, ""); return; }
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this.onopen?.({});
      });
    }
    send(d) {
      if (this.readyState !== 1) throw new Error("not open");
      if (typeof d === "string") {
        this.pings++;
        if (d === "ping" && world.pong) this.deliver("pong");
        return;
      }
      const b = Buffer.from(d);
      queueMicrotask(() => { if (this.readyState === 1) this.side.receive(b); });
    }
    deliver(data) { queueMicrotask(() => { if (this.readyState === 1) this.onmessage?.({ data }); }); }
    close(code = 1000, reason = "") { this.drop(code, reason); }
    /** The connection ends, from either side or the network. */
    drop(code = 1006, reason = "") {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      this.side.gone(reason || "dropped");
      queueMicrotask(() => this.onclose?.({ code, reason }));
    }
  }
  world.WebSocket = FakeWS;
  return world;
}

/**
 * Let promises, microtasks and WebCrypto's thread pool run (never advances mocked timers): until
 * `until()` holds, for at most `ms` of real time, and always at least a few turns of the loop.
 */
export async function settle(until = () => true, ms = 10_000) {
  const end = Date.now() + ms;
  for (let i = 0; ; i++) {
    if (i >= 20 && until()) return;
    if (Date.now() > end) throw new Error("settle: condition never held");
    await new Promise(r => setImmediate(r));
  }
}
