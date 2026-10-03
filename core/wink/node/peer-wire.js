// @ts-check
// peer-wire: the application protocol two Vyre homes speak once they can reach each other, on any
// path (a Wink node's TCP stream, or a relay `peer` stream). It carries calls to the kernel's
// registry and answers, and nothing else, so it is the same on the direct path and on the relay.
//
// Frame: [type u8][flags u8][id u32][len u32][payload]   (10 bytes of header, len <= MAX_FRAME)
//   1 call    JSON {tool, input}                  id is chosen by the caller (odd from the opener)
//   2 result  JSON {ok:true, data} | {ok:false, error:{code, message}}
//   3 more    a continuation slice of the last call or result with the same id
//   4 ping    8 bytes, answered at once by a pong with the same bytes
//   5 pong
//   6 challenge  JSON {nonce, box}         the home to a peer that arrived on a Wink node (auth.js)
//   7 proof      JSON {device, proof}      the peer's answer
//   8 ready      JSON {caller}             the home accepts the proof
// flags bit 0: more slices follow for this message.
//
// Fair queueing (SPIKE-wink.md, relay: a ping waited 390 ms behind one bulk stream): messages up to
// SLICE bytes go in the small queue, which is always emptied first; a bigger message is cut into
// SLICE-byte slices that take turns, one slice per message per round. So a ping, or a small call
// among a bulk result, waits at most for the slice already in flight. The writer also stops while
// the transport reports a backlog, so slices are produced as fast as the wire takes them and not
// all at once.

import crypto from "node:crypto";

export const T = Object.freeze({ call: 1, result: 2, more: 3, ping: 4, pong: 5, challenge: 6, proof: 7, ready: 8 });
export const SLICE = 16 * 1024;
export const MAX_FRAME = 64 * 1024;
export const MAX_MESSAGE = 32 * 1024 * 1024;
const HEAD = 10;
const BACKLOG = 128 * 1024;

/**
 * What a session needs from a byte pipe. `buffered()` is how many bytes are queued and not yet on
 * the wire; the writer pauses while it exceeds BACKLOG and polls again shortly after.
 * @typedef {{ write: (b: Buffer) => void, end: () => void, destroy: () => void, buffered: () => number,
 *   ondata: (b: Buffer) => void, onclose: (why: string) => void }} Pipe
 */

/** A net.Socket (or any Duplex) as a Pipe. @param {import("node:stream").Duplex} sock @returns {Pipe} */
export function socketPipe(sock) {
  /** @type {Pipe} */
  const p = {
    write: b => { sock.write(b); }, end: () => sock.end(), destroy: () => sock.destroy(),
    buffered: () => sock.writableLength, ondata: () => {}, onclose: () => {},
  };
  sock.on("data", b => p.ondata(b));
  sock.on("close", () => p.onclose("closed"));
  sock.on("error", e => p.onclose(String(e.message || "error")));
  return p;
}

/** A relay Stream (core/relay/channel.js) as a Pipe. @param {any} s the Stream @returns {Pipe} */
export function streamPipe(s) {
  /** @type {Pipe} */
  const p = {
    write: b => s.write(b), end: () => s.end(), destroy: () => s.reset("closed"),
    buffered: () => Number(s.ch?.transport?.bufferedAmount || 0), ondata: () => {}, onclose: () => {},
  };
  s.ondata = b => p.ondata(b);
  s.onend = () => p.onclose("ended");
  s.onreset = why => p.onclose(why || "reset");
  return p;
}

/** Cut and queue outgoing messages fairly. @param {Pipe} pipe */
class Writer {
  constructor(/** @type {Pipe} */ pipe) {
    this.pipe = pipe;
    /** @type {Buffer[]} */ this.small = [];
    /** @type {Array<{ type: number, id: number, buf: Buffer, off: number }>} */ this.bulk = [];
    this.running = false;
    this.dead = false;
  }
  /** @param {number} type @param {number} id @param {Buffer} payload */
  send(type, id, payload) {
    if (this.dead) return;
    if (payload.length <= SLICE) this.small.push(frame(type, 0, id, payload));
    else this.bulk.push({ type, id, buf: payload, off: 0 });
    this.pump();
  }
  pump() {
    if (this.running || this.dead) return;
    this.running = true;
    const step = () => {
      if (this.dead) { this.running = false; return; }
      let guard = 0;
      while (guard++ < 64) {
        if (this.pipe.buffered() > BACKLOG) { setTimeout(step, 1).unref?.(); return; }
        const f = this.small.shift();
        if (f) { this.pipe.write(f); continue; }
        const b = this.bulk.shift();
        if (!b) { this.running = false; return; }
        const end = Math.min(b.off + SLICE, b.buf.length);
        const more = end < b.buf.length;
        this.pipe.write(frame(b.off === 0 ? b.type : T.more, more ? 1 : 0, b.id, b.buf.subarray(b.off, end)));
        b.off = end;
        if (more) this.bulk.push(b);
      }
      setImmediate(step);
    };
    step();
  }
  stop() { this.dead = true; this.small = []; this.bulk = []; }
}

/** @param {number} type @param {number} flags @param {number} id @param {Buffer} payload */
function frame(type, flags, id, payload) {
  const h = Buffer.allocUnsafe(HEAD);
  h[0] = type; h[1] = flags; h.writeUInt32BE(id, 2); h.writeUInt32BE(payload.length, 6);
  return Buffer.concat([h, payload]);
}

/** Frame parser: push bytes, get whole frames. */
export class Frames {
  constructor() { /** @type {Buffer} */ this.buf = Buffer.alloc(0); }
  /** @param {Buffer} chunk @returns {Array<{ type: number, more: boolean, id: number, payload: Buffer }>} */
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    for (;;) {
      if (this.buf.length < HEAD) break;
      const len = this.buf.readUInt32BE(6);
      if (len > MAX_FRAME) throw new Error("frame too big");
      if (this.buf.length < HEAD + len) break;
      out.push({ type: this.buf[0], more: (this.buf[1] & 1) === 1, id: this.buf.readUInt32BE(2), payload: this.buf.subarray(HEAD, HEAD + len) });
      this.buf = this.buf.subarray(HEAD + len);
    }
    return out;
  }
}

const err = (code, message) => Object.assign(new Error(message), { code });

/**
 * One session over a Pipe. Either side may call; `serve` (when given) answers calls from the other.
 * @param {Pipe} pipe
 * @param {{ serve?: (tool: string, input: any) => Promise<any>, first?: number, onframe?: (f: { type: number, id: number, payload: Buffer }) => boolean }} [o]
 *   `serve` resolves to the tool's data and throws {code,message}; `first` is the first call id (odd for the opener, even for the answerer);
 *   `onframe` sees control frames (auth) before the session does and returns true if it consumed one.
 */
export function peerSession(pipe, o = {}) {
  const w = new Writer(pipe);
  const frames = new Frames();
  let next = o.first || 1;
  let closed = false;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: any }>} */
  const calls = new Map();
  /** @type {Map<string, { resolve: (ms: number) => void, t0: number }>} */
  const pings = new Map();
  /** @type {Map<number, { type: number, parts: Buffer[], size: number }>} */
  const partial = new Map();
  /** @type {(why: string) => void} */
  let onclose = () => {};
  const session = {
    /** @param {(why: string) => void} f */
    set onclose(f) { onclose = f; },
    get closed() { return closed; },
    /** Call a registry tool on the other side. @param {string} tool @param {any} [input] @param {{ timeoutMs?: number }} [opt] */
    call(tool, input = {}, opt = {}) {
      if (closed) return Promise.reject(err("unreachable", "the connection is closed"));
      const id = next; next += 2;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { calls.delete(id); reject(err("timeout", `no answer to ${tool}`)); }, opt.timeoutMs ?? 30_000);
        timer.unref?.();
        calls.set(id, { resolve, reject, timer });
        w.send(T.call, id, Buffer.from(JSON.stringify({ tool, input })));
      });
    },
    /** Round trip in ms, or null when there is no answer in time. @param {number} [timeoutMs] */
    ping(timeoutMs = 2000) {
      if (closed) return Promise.resolve(null);
      const nonce = crypto.randomBytes(8);
      const key = nonce.toString("hex");
      return new Promise(resolve => {
        const timer = setTimeout(() => { pings.delete(key); resolve(null); }, timeoutMs);
        timer.unref?.();
        pings.set(key, { resolve: ms => { clearTimeout(timer); resolve(ms); }, t0: performance.now() });
        w.send(T.ping, 0, nonce);
      });
    },
    /** @param {number} type @param {any} json */
    sendControl(type, json) { w.send(type, 0, Buffer.from(JSON.stringify(json))); },
    close(why = "closed") { finish(why); try { pipe.end(); } catch {} setTimeout(() => pipe.destroy(), 200).unref?.(); },
  };

  function finish(why) {
    if (closed) return;
    closed = true;
    w.stop();
    for (const [, c] of calls) { clearTimeout(c.timer); c.reject(err("unreachable", `the connection closed: ${why}`)); }
    calls.clear();
    try { onclose(why); } catch { /* the reporter must not break the session */ }
  }

  /** @param {number} id @param {any} message */
  function answer(id, message) { w.send(T.result, id, Buffer.from(JSON.stringify(message))); }

  async function handle(/** @type {number} */ type, /** @type {number} */ id, /** @type {Buffer} */ payload) {
    let j;
    try { j = JSON.parse(payload.toString("utf8")); } catch { return finish("bad message"); }
    if (type === T.call) {
      if (!o.serve) return answer(id, { ok: false, error: { code: "denied", message: "this side does not answer calls" } });
      if (!j || typeof j.tool !== "string" || !/^[a-z][a-z0-9_.-]{0,80}$/i.test(j.tool)) return answer(id, { ok: false, error: { code: "bad_input", message: "a call names a tool" } });
      try { answer(id, { ok: true, data: await o.serve(j.tool, j.input ?? {}) }); }
      catch (e) { answer(id, { ok: false, error: { code: String(/** @type {any} */ (e)?.code || "internal"), message: String(/** @type {any} */ (e)?.message || e).slice(0, 500) } }); }
    } else if (type === T.result) {
      const c = calls.get(id);
      if (!c) return;
      calls.delete(id); clearTimeout(c.timer);
      if (j && j.ok) c.resolve(j.data);
      else c.reject(err(String(j?.error?.code || "internal"), String(j?.error?.message || "the call failed")));
    }
  }

  pipe.ondata = chunk => {
    let got;
    try { got = frames.push(chunk); } catch (e) { finish(String(/** @type {any} */ (e).message)); pipe.destroy(); return; }
    for (const f of got) {
      if (closed) return;
      if (f.type === T.ping) { w.send(T.pong, 0, Buffer.from(f.payload)); continue; }
      if (f.type === T.pong) { const k = f.payload.toString("hex"); const p = pings.get(k); if (p) { pings.delete(k); p.resolve(Math.round((performance.now() - p.t0) * 100) / 100); } continue; }
      if (f.type >= T.challenge) { if (!o.onframe || !o.onframe({ type: f.type, id: f.id, payload: f.payload })) { finish("unexpected frame"); pipe.destroy(); } continue; }
      let p = partial.get(f.id);
      if (f.type !== T.more) { p = { type: f.type, parts: [], size: 0 }; partial.set(f.id, p); }
      else if (!p) { finish("continuation without a start"); pipe.destroy(); return; }
      p.parts.push(f.payload); p.size += f.payload.length;
      if (p.size > MAX_MESSAGE) { finish("message too big"); pipe.destroy(); return; }
      if (!f.more) { partial.delete(f.id); handle(p.type, f.id, Buffer.concat(p.parts)); }
    }
  };
  pipe.onclose = why => finish(why);
  return session;
}

// ---- auth for a peer that arrived on a Wink node (5.1): the node key is bound, the device key is proven ----

export const AUTH_TAG = "vyre-wink-peer-v1";

/**
 * The proof a device sends: an HMAC under the static DH of the device key and the home's key, over
 * the home's nonce, the node key the forwarder named and the home's id. The home computes the same
 * from its side; a peer that holds a node but not the device key cannot make it.
 * @param {Buffer} shared dh(device private, home public) @param {string} nonce @param {string} nodeKey @param {string} box
 */
export function authProof(shared, nonce, nodeKey, box) {
  return crypto.createHmac("sha256", crypto.createHash("sha256").update(AUTH_TAG).update(shared).digest())
    .update(`${nonce}\n${nodeKey}\n${box}`).digest("base64url");
}

/**
 * The home's side of a peer that came through the forwarder: send a challenge, wait for a proof,
 * check it, and only then serve calls. Resolves with a session; rejects (and destroys the pipe)
 * when the proof is wrong, late, or the device is unknown or not enrolled for this node.
 * @param {Pipe} pipe
 * @param {{ id: { nodeKey: string }, box: string,
 *   shared: (deviceId: string, nodeKey: string) => Promise<Buffer | null> | Buffer | null,
 *   serve: (caller: string, tool: string, input: any) => Promise<any>, timeoutMs?: number }} o
 */
export function admitPeer(pipe, o) {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomBytes(16).toString("base64url");
    let settled = false;
    /** @type {any} */ let caller = null;
    const fail = (/** @type {string} */ why) => { if (settled) return; settled = true; clearTimeout(timer); try { pipe.destroy(); } catch {} reject(err("denied", why)); };
    const timer = setTimeout(() => fail("no proof in time"), o.timeoutMs ?? 5000);
    const session = peerSession(pipe, {
      first: 2,
      serve: (tool, input) => { if (!caller) throw err("denied", "not proven"); return o.serve(caller, tool, input); },
      onframe: f => {
        if (f.type !== T.proof || settled) return false;
        (async () => {
          let j; try { j = JSON.parse(f.payload.toString("utf8")); } catch { return fail("bad proof"); }
          if (!j || typeof j.device !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(j.device) || typeof j.proof !== "string") return fail("bad proof");
          const shared = await o.shared(j.device, o.id.nodeKey);
          if (!shared) return fail("unknown device");
          const want = Buffer.from(authProof(shared, nonce, o.id.nodeKey, o.box));
          const got = Buffer.from(j.proof);
          if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return fail("proof does not match");
          if (settled) return;
          settled = true; clearTimeout(timer);
          caller = `device:${j.device}`;
          session.sendControl(T.ready, { caller });
          resolve({ session, caller });
        })().catch(() => fail("proof failed"));
        return true;
      },
    });
    session.onclose = why => fail(why);
    session.sendControl(T.challenge, { nonce, box: o.box });
  });
}

/**
 * The peer's side of the same: wait for the challenge, answer it, wait for ready, and return the
 * session to call through.
 * @param {Pipe} pipe
 * @param {{ device: string, nodeKey: string, shared: (box: string) => Promise<Buffer> | Buffer, timeoutMs?: number,
 *   serve?: (tool: string, input: any) => Promise<any> }} o
 */
export function joinPeer(pipe, o) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (/** @type {string} */ why) => { if (settled) return; settled = true; clearTimeout(timer); try { pipe.destroy(); } catch {} reject(err("unreachable", why)); };
    const timer = setTimeout(() => fail("the home did not answer"), o.timeoutMs ?? 8000);
    const session = peerSession(pipe, {
      first: 1,
      ...(o.serve ? { serve: o.serve } : {}),
      onframe: f => {
        let j; try { j = JSON.parse(f.payload.toString("utf8")); } catch { fail("bad control frame"); return true; }
        if (f.type === T.challenge) {
          Promise.resolve(o.shared(String(j.box))).then(shared => session.sendControl(T.proof, { device: o.device, proof: authProof(shared, String(j.nonce), o.nodeKey, String(j.box)) })).catch(() => fail("no device key"));
          return true;
        }
        if (f.type === T.ready) { if (settled) return true; settled = true; clearTimeout(timer); resolve(session); return true; }
        return false;
      },
    });
    session.onclose = why => fail(why);
  });
}
