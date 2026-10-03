// @ts-check
// client: the resumable end of a session stream (ADR 0052). No Node-only API: it runs in Node, a
// browser and React Native, given only open(), which returns a duplex of JSON messages. Over the
// relay it is the same call; the relay forwards bytes.
//
// The client's only state is `last`, the cursor of the newest frame it delivered. It drops anything
// at or below it, treats a frame that starts after last + 1 as a gap (and resubscribes from last),
// trims a merged frame it already holds the start of, and on `reset` calls snapshot(), adopts the
// snapshot's cursor, and resumes. A dropped connection reconnects at once the first time, then with
// capped exponential backoff and jitter. Nothing is acked: a frame is never retransmitted, the
// client just asks again from `last`.
//
// duplex: { send(obj), onMessage(cb), onClose(cb), close() }. wsDuplex() wraps a WebSocket
// (browser, React Native, Node 22+); sseDuplex() wraps an EventSource.

import { startOf, kindOf } from "./frame.js";

export const BACKOFF = Object.freeze({ base: 250, cap: 15_000, jitter: 0.4 });
/** A connection silent this long (the server's heartbeat is 25 s) is treated as dead. */
export const IDLE_MS = 70_000;

/**
 * @typedef {{ send(m: any): void, onMessage(cb: (m: any) => void): void, onClose(cb: () => void): void, close(): void }} Duplex
 * @typedef {"connecting"|"live"|"reconnecting"|"resetting"|"closed"} State
 * @typedef {{ open: (a: { from: number, attempt: number }) => Duplex | Promise<Duplex>,
 *   from?: number, snapshot?: () => ({ cur: number } | Promise<{ cur: number }>),
 *   onFrame: (f: any) => void, onState?: (s: State, info?: any) => void,
 *   backoff?: { base?: number, cap?: number, jitter?: number }, idleMs?: number, random?: () => number,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (t: any) => void } }} ConnectOptions
 */

/**
 * Cut the first `skip` pieces off a merged frame whose `parts` the client already holds.
 * @param {any} f @param {number} skip
 */
export function trim(f, skip) {
  const parts = f.data.parts.slice(skip);
  const lost = f.data.parts.slice(0, skip).reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0);
  const data = { ...f.data, parts };
  if (kindOf(f) === "text-delta") data.text = f.data.text.slice(lost);
  else if (kindOf(f) === "term-chunk") { data.b64 = toB64(b64Bytes(f.data.b64).subarray(lost)); data.offset = f.data.offset + lost; }
  const out = { ...f, data };
  if (parts.length > 1) out.span = parts.length; else delete out.span;
  if (parts.length <= 1) delete out.data.parts;
  return out;
}

// base64 without Buffer where there is none (React Native): atob/btoa on binary strings.
/** @param {string} b64 @returns {Uint8Array} */
function b64Bytes(b64) {
  if (typeof Buffer !== "undefined") return Buffer.from(b64, "base64");
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
/** @param {Uint8Array} u */
function toB64(u) {
  if (typeof Buffer !== "undefined") return Buffer.from(u).toString("base64");
  let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}

/**
 * @param {ConnectOptions} o
 * @returns {{ readonly last: number, readonly state: State, close: () => void, reconnect: () => void }}
 */
export function connect(o) {
  const timers = o.timers || { setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => setTimeout(fn, ms), clearTimeout: (/** @type {any} */ t) => clearTimeout(t) };
  const random = o.random || Math.random;
  const bo = { ...BACKOFF, ...(o.backoff || {}) };
  const idleMs = o.idleMs ?? IDLE_MS;
  let last = Math.max(0, o.from ?? 0);
  /** @type {State} */ let state = "connecting";
  let stopped = false, attempt = 0, gen = 0;
  /** @type {Duplex|null} */ let dx = null;
  /** @type {any} */ let retry = null;
  /** @type {any} */ let idle = null;

  const setState = (/** @type {State} */ s, /** @type {any} */ info = undefined) => { if (s !== state) { state = s; try { o.onState?.(s, info); } catch {} } };
  const arm = () => { if (idle) timers.clearTimeout(idle); if (idleMs > 0) idle = timers.setTimeout(() => drop("idle"), idleMs); };
  /** Abandon the current connection and come back from `last`. @param {string} why @param {boolean} [now] */
  const drop = (why, now = false) => {
    if (stopped) return;
    const d = dx; dx = null; gen++;
    if (idle) { timers.clearTimeout(idle); idle = null; }
    if (d) { try { d.close(); } catch {} }
    schedule(now, why);
  };
  const schedule = (/** @type {boolean} */ now, /** @type {string} */ why) => {
    if (stopped || retry) return;
    setState("reconnecting", { why, attempt });
    // The first retry is immediate; after that, exponential from base, capped, with jitter.
    const wait = now || attempt === 0 ? 0 : Math.min(bo.cap, bo.base * 2 ** (attempt - 1)) * (1 - bo.jitter * random());
    attempt++;
    retry = timers.setTimeout(() => { retry = null; start(); }, wait);
  };

  const start = async () => {
    if (stopped) return;
    const my = ++gen;
    setState(state === "reconnecting" ? "reconnecting" : "connecting");
    let d;
    try { d = await o.open({ from: last, attempt }); } catch { if (my === gen) schedule(false, "open"); return; }
    if (stopped || my !== gen) { try { d.close(); } catch {} return; }
    dx = d;
    d.onClose(() => { if (dx === d && my === gen) { dx = null; gen++; if (idle) { timers.clearTimeout(idle); idle = null; } schedule(false, "closed"); } });
    d.onMessage(m => { if (my === gen) onMessage(m, d); });
    arm();
    try { d.send({ t: "subscribe", from: last }); } catch { drop("send"); return; }
    setState("live");
  };

  /** @param {any} m @param {Duplex} d */
  const onMessage = (m, d) => {
    if (!m || typeof m !== "object") return;
    arm();
    attempt = 0;
    const kind = kindOf(m);
    if (kind === "heartbeat") { if (m.data.head > last) drop("gap", true); return; }
    if (kind === "reset") { reset(d); return; }
    if (!kind || !Number.isInteger(m.cur) || m.cur < 1) return;
    if (m.cur <= last) return;
    const first = startOf(m);
    if (first > last + 1) { drop("gap", true); return; }
    let f = m;
    if (first <= last) {
      if (!m.data || !Array.isArray(m.data.parts)) return; // cannot be split: already held in full
      f = trim(m, last - first + 1);
    }
    last = m.cur;
    try { o.onFrame(f); } catch {}
  };

  /** The log no longer holds our cursor: take a snapshot, adopt its cursor, resume. @param {Duplex} d */
  const reset = async d => {
    const my = gen;
    setState("resetting");
    dx = null; gen++;
    if (idle) { timers.clearTimeout(idle); idle = null; }
    try { d.close(); } catch {}
    try {
      if (!o.snapshot) throw new Error("no snapshot");
      const s = await o.snapshot();
      if (stopped || my + 1 !== gen) return;
      if (s && Number.isInteger(s.cur) && s.cur >= 0) last = s.cur;
    } catch { if (!stopped) { schedule(false, "snapshot"); } return; }
    schedule(true, "reset");
  };

  start();
  return {
    get last() { return last; },
    get state() { return state; },
    reconnect() { if (!stopped) drop("manual", true); },
    close() {
      stopped = true; gen++;
      if (retry) { timers.clearTimeout(retry); retry = null; }
      if (idle) { timers.clearTimeout(idle); idle = null; }
      const d = dx; dx = null;
      if (d) { try { d.close(); } catch {} }
      setState("closed");
    },
  };
}

// ---- duplex helpers ---------------------------------------------------------------------------

/**
 * Open a WebSocket as a duplex. Resolves once it is open; rejects if it fails to open.
 * @param {string} url @param {any} [WS] the WebSocket constructor (global in browsers, React Native and Node 22+)
 * @returns {Promise<Duplex>}
 */
export function wsDuplex(url, WS = /** @type {any} */ (globalThis).WebSocket) {
  return new Promise((resolve, reject) => {
    const ws = new WS(url);
    /** @type {((m: any) => void)[]} */ const ms = [];
    /** @type {(() => void)[]} */ const cs = [];
    let opened = false;
    ws.onopen = () => { opened = true; resolve({
      send: m => ws.send(JSON.stringify(m)),
      onMessage: cb => { ms.push(cb); },
      onClose: cb => { cs.push(cb); },
      close: () => { try { ws.close(); } catch {} },
    }); };
    ws.onmessage = (/** @type {any} */ e) => { let j; try { j = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); } catch { return; } for (const m of ms) m(j); };
    ws.onclose = () => { if (!opened) reject(new Error("closed before open")); for (const c of cs) c(); };
    ws.onerror = () => { if (!opened) reject(new Error("could not open")); };
  });
}

/**
 * An EventSource as a duplex. The server reads `from` from the URL, so the URL is built from the
 * cursor each time (see the `url` function); send() is a no-op, the stream is one way.
 * @param {string} url @param {any} [ES]
 * @returns {Promise<Duplex>}
 */
export function sseDuplex(url, ES = /** @type {any} */ (globalThis).EventSource) {
  return new Promise((resolve, reject) => {
    const es = new ES(url);
    /** @type {((m: any) => void)[]} */ const ms = [];
    /** @type {(() => void)[]} */ const cs = [];
    let opened = false;
    es.onopen = () => { opened = true; resolve({
      send: () => {},
      onMessage: cb => { ms.push(cb); },
      onClose: cb => { cs.push(cb); },
      close: () => { try { es.close(); } catch {} },
    }); };
    es.onmessage = (/** @type {any} */ e) => { let j; try { j = JSON.parse(e.data); } catch { return; } for (const m of ms) m(j); };
    // An EventSource retries by itself; this client owns reconnection, so any error ends it.
    es.onerror = () => { try { es.close(); } catch {} if (!opened) reject(new Error("could not open")); for (const c of cs) c(); };
  });
}
