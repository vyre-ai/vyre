// @ts-check
// peerclient: the calling side of the Wink peer wire (core/wink/node/peer-wire.js) with no Node-only dependency: Uint8Array, DataView and TextEncoder only, so the browser and the iPhone app
// can use it. Same frames: [type u8][flags u8][id u32 BE][len u32 BE][payload]; 1 call {tool,input}, 2 result {ok,data|error}, 3 continuation, 4 ping, 5 pong. A call is sliced at 16 KB.
//
//   const stream = channel.open({ peer: "wink", space: "home" });  // after the server answered 200
//   const peer = peerClient(stream);                               // stream: { write(Uint8Array), ondata, onend, onreset, end, reset }
//   const data = await peer.call("records.me", {});               // the tool's data; rejects with Error { code }
//   peer.close();
//   const s = await peer.openStream(tool, input, { onframe(data, seq) {}, onend(why) {} });  // a call opens it (its result carries { stream: id }); frames then arrive here in order; s.close() ends it
//   A dropped peer stream calls onend("closed") on every open stream; the app reopens the peer and the stream, passing the last seq it saw to the ticket call.
// The server runs the call as this device (core/daemon/peer-door.js). `kernel.call` carries a kernel request (kernel/remote/wire.js).
const SLICE = 16 * 1024, HEAD = 10, MAX_MESSAGE = 32 * 1024 * 1024;
const T = { call: 1, result: 2, more: 3, ping: 4, pong: 5, stream: 9, streamEnd: 10 };
const enc = new TextEncoder(), dec = new TextDecoder();
const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });

/** @param {number} type @param {number} flags @param {number} id @param {Uint8Array} payload */
function frame(type, flags, id, payload) {
  const out = new Uint8Array(HEAD + payload.length);
  const v = new DataView(out.buffer);
  out[0] = type; out[1] = flags; v.setUint32(2, id); v.setUint32(6, payload.length);
  out.set(payload, HEAD);
  return out;
}
/** @param {Uint8Array} a @param {Uint8Array} b */
function join(a, b) { if (!a.length) return b; const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

/**
 * @param {{ write(b: Uint8Array): void, end(): void, reset?(why: string): void, ondata: any, onend: any, onreset: any }} stream
 * @param {{ timeoutMs?: number }} [o]
 */
export function peerClient(stream, o = {}) {
  let next = 1, closed = false, buf = new Uint8Array(0);
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: any }>} */ const calls = new Map();
  /** @type {Map<number, { type: number, parts: Uint8Array[], size: number }>} */ const partial = new Map();
  /** @type {Map<string, { onframe: (data: any, seq: number) => void, onend: (why: string) => void }>} */ const streams = new Map();
  /** @type {Map<string, { frames: any[], ended: string | null, at: number }>} frames that arrive before their stream's handlers (the open call's answer is still on its way) */ const early = new Map();
  const finish = (/** @type {string} */ why) => { if (closed) return; closed = true; for (const [sid, h] of [...streams]) { streams.delete(sid); try { h.onend("closed"); } catch { /* the app's handler */ } } for (const [, c] of calls) { clearTimeout(c.timer); c.reject(err("unreachable", `the connection closed: ${why}`)); } calls.clear(); };
  /** @param {number} type @param {number} id @param {Uint8Array} payload */
  const send = (type, id, payload) => {
    for (let off = 0; off === 0 || off < payload.length; off += SLICE) {
      const end = Math.min(off + SLICE, payload.length);
      stream.write(frame(off === 0 ? type : T.more, end < payload.length ? 1 : 0, id, payload.subarray(off, end)));
      if (end >= payload.length) break;
    }
  };
  stream.ondata = (/** @type {Uint8Array} */ chunk) => {
    buf = join(buf, chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    for (;;) {
      if (buf.length < HEAD) break;
      const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const len = v.getUint32(6);
      if (len > 64 * 1024) { finish("frame too big"); try { stream.reset && stream.reset("bad frame"); } catch { /* gone */ } return; }
      if (buf.length < HEAD + len) break;
      const type = buf[0], more = (buf[1] & 1) === 1, id = v.getUint32(2), payload = buf.slice(HEAD, HEAD + len);
      buf = buf.subarray(HEAD + len);
      if (type === T.ping) { send(T.pong, 0, payload); continue; }
      if (type === T.pong) continue;
      if (type === T.stream || type === T.streamEnd) {
        let j = null; try { j = JSON.parse(dec.decode(payload)); } catch { /* bad frame */ }
        if (!j || typeof j.id !== "string") continue;
        const h = streams.get(j.id);
        if (type === T.stream) {
          if (h) { try { h.onframe(j.data, Number(j.seq)); } catch { /* the app's handler */ } }
          else { const e = early.get(j.id) || { frames: [], ended: null, at: Date.now() }; if (e.frames.length < 100) e.frames.push({ data: j.data, seq: Number(j.seq) }); early.set(j.id, e); setTimeout(() => early.delete(j.id), 5000); }
        } else if (h) { streams.delete(j.id); try { h.onend(String(j.why || "done")); } catch { /* the app's handler */ } }
        else { const e = early.get(j.id) || { frames: [], ended: null, at: Date.now() }; e.ended = String(j.why || "done"); early.set(j.id, e); }
        continue;
      }
      let p = partial.get(id);
      if (type !== T.more) { p = { type, parts: [], size: 0 }; partial.set(id, p); } else if (!p) { finish("continuation without a start"); return; }
      p.parts.push(payload); p.size += payload.length;
      if (p.size > MAX_MESSAGE) { finish("message too big"); return; }
      if (more) continue;
      partial.delete(id);
      if (p.type !== T.result) continue;
      const all = new Uint8Array(p.size); let at = 0; for (const x of p.parts) { all.set(x, at); at += x.length; }
      const c = calls.get(id);
      if (!c) continue;
      calls.delete(id); clearTimeout(c.timer);
      let j = null; try { j = JSON.parse(dec.decode(all)); } catch { /* bad */ }
      if (j && j.ok) c.resolve(j.data); else c.reject(err(String(j && j.error && j.error.code || "internal"), String(j && j.error && j.error.message || "the call failed")));
    }
  };
  stream.onend = () => finish("ended");
  stream.onreset = (/** @type {any} */ why) => finish(String(why || "reset"));
  /** @type {any} */ const api = {
    get closed() { return closed; },
    /** @param {string} tool @param {any} [input] @param {{ timeoutMs?: number }} [opt] */
    call(tool, input = {}, opt = {}) {
      if (closed) return Promise.reject(err("unreachable", "the connection is closed"));
      const id = next; next += 2;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { calls.delete(id); reject(err("timeout", `no answer to ${tool}`)); }, opt.timeoutMs ?? o.timeoutMs ?? 30_000);
        calls.set(id, { resolve, reject, timer });
        send(T.call, id, enc.encode(JSON.stringify({ tool, input })));
      });
    },
    close() { finish("done"); try { stream.end(); } catch { /* gone */ } },
    /**
     * Open a stream by calling the tool that makes one: its result carries `{ stream: "<id>" }` and the server then sends frames for that id. Frames that beat the answer are kept (100, 5 s) and handed over in order.
     * @param {string} tool @param {any} input @param {{ onframe: (data: any, seq: number) => void, onend?: (why: string) => void }} handlers
     * @returns {Promise<{ id: string, result: any, close: () => void }>}
     */
    async openStream(tool, input, handlers) {
      const result = await api.call(tool, input);
      const sid = result && typeof result.stream === "string" ? result.stream : "";
      if (!sid) throw err("bad_input", "that call did not open a stream");
      const h = { onframe: handlers.onframe, onend: handlers.onend || (() => {}) };
      streams.set(sid, h);
      const e = early.get(sid);
      if (e) { early.delete(sid); for (const f of e.frames) { try { h.onframe(f.data, f.seq); } catch { /* the app's handler */ } } if (e.ended !== null) { streams.delete(sid); try { h.onend(e.ended); } catch { /* the app's handler */ } } }
      return { id: sid, result, close: () => { if (streams.delete(sid) && !closed) send(T.streamEnd, 0, enc.encode(JSON.stringify({ id: sid, why: "client" }))); } };
    },
  };
  return api;
}

/**
 * Opens a peer stream to the paired server on a relay `connect()` connection and returns the calling side. Rejects with { code: "denied" | "rate_limited" | "unreachable" }.
 * @param {{ ready(): Promise<any> }} conn @param {{ space?: string, timeoutMs?: number }} [o]
 */
export async function openServerPeer(conn, o = {}) {
  const ch = await conn.ready();
  const s = ch.open({ peer: "wink", space: o.space || "home" });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { s.reset("no answer"); reject(err("unreachable", "the server did not accept the peer stream")); }, o.timeoutMs ?? 10_000);
    s.onhead = (/** @type {any} */ h) => { clearTimeout(timer); h && h.status === 200 ? resolve(undefined) : reject(err(h && h.status === 429 ? "rate_limited" : "denied", `the server refused the peer stream (${h && h.status})`)); };
    s.onreset = (/** @type {any} */ why) => { clearTimeout(timer); reject(err("unreachable", String(why || "reset"))); };
  });
  return peerClient(s);
}
