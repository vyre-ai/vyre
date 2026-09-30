// @ts-check
// background: the shell. It does four things and nothing else (ADR 0049):
//   1. holds the native-messaging connection to the host ("run.vyre.chrome") and says hello,
//   2. hands each {id, op, args} to the capability registry (caps/index.js),
//   3. redacts every result (shared/redact.js) before it leaves the browser,
//   4. answers {id, ok:true, result} or {id, ok:false, error:{code, message}}.
//
// Light by default (Vyre SPEC principle 8): while connected the open native port keeps the worker
// alive and nothing polls. While disconnected it retries no faster than every 5 s, backing off to
// a minute, and a once-a-minute alarm wakes a sleeping worker to try again. Idle cost is that alarm.
//
// The module tells us when the person presses stop: {event:"stop"} sets ctx.stopped() until
// {event:"resume"}. Acting ops are refused while it is set (caps/index.js) and a batch halts
// before its next step (caps/batch.js).
//
// Exported start() takes the chrome API and timers so tests can drive it with fakes; the file
// starts itself only inside a real extension.

import { proto, redact } from "./lib/shared.js";
import { createCtx } from "./lib/ctx.js";
import { dispatch, deliver, ready, loadReport, opNames } from "./caps/index.js";

export const MIN_RETRY_MS = 5000;
export const MAX_RETRY_MS = 60_000;
const ALARM = "vyre.keepalive";

/**
 * Redact a result. Screenshot pixels (an `image` object with base64 `data`) are exempt from the
 * text rules, which would corrupt them; they cannot be scrubbed by pattern and the floor already
 * refuses blind pages. Applies at the top level and inside batch results.
 * @param {any} res
 */
export function redactResult(res) {
  /** @type {any[]} */
  const kept = [];
  const strip = (/** @type {any} */ v) => {
    if (v && typeof v === "object" && v.image && typeof v.image.data === "string") { kept.push(v.image); return { ...v, image: { __kept: kept.length - 1 } }; }
    return v;
  };
  const top = strip(res);
  const shaped = top && Array.isArray(top.results) ? { ...top, results: top.results.map(strip) } : top;
  const clean = redact.value(shaped);
  const restore = (/** @type {any} */ v) => (v && typeof v === "object" && v.image && typeof v.image.__kept === "number") ? { ...v, image: kept[v.image.__kept] } : v;
  if (!clean || typeof clean !== "object") return clean;
  const r = restore(clean);
  return Array.isArray(r.results) ? { ...r, results: r.results.map(restore) } : r;
}

/**
 * @param {any} chrome
 * @param {{ setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, now?: () => number }} [opts]
 */
export function start(chrome, opts = {}) {
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const now = opts.now || Date.now;

  /** @type {any} */
  let port = null;
  let attempts = 0;
  let lastAttempt = -Infinity;
  /** @type {any} */
  let timer = null;

  /** @param {any} msg */
  function post(msg) {
    if (!port) return false;
    try { port.postMessage(msg); return true; } catch { return false; }
  }

  const emit = (/** @type {any} */ evt) => { post(redactResult(evt)); };
  const ctx = createCtx({ chrome, emit });

  /** @param {any} msg */
  async function onMessage(msg) {
    attempts = 0;
    if (!msg || typeof msg !== "object") return;
    if (typeof msg.event === "string") {
      if (msg.event === "stop") ctx.setStopped(true);
      else if (msg.event === "resume") ctx.setStopped(false);
      await deliver(msg, ctx);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const id = msg.id;
    try {
      if (typeof msg.op !== "string") throw Object.assign(new Error(proto.CODES.bad_request), { code: "bad_request" });
      const result = await dispatch(msg.op, msg.args, ctx);
      post({ id, ok: true, result: redactResult(result === undefined ? null : result) });
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      const known = typeof code === "string" && code in proto.CODES;
      post({ id, ok: false, error: proto.fail(known ? code : "error", redact.text(String(/** @type {any} */ (e)?.message || e))) });
    }
  }

  function scheduleReconnect() {
    if (timer) return;
    const wait = Math.min(MAX_RETRY_MS, MIN_RETRY_MS * 2 ** Math.min(attempts, 10));
    attempts++;
    timer = setT(() => { timer = null; connect(); }, wait);
  }

  function connect() {
    if (port) return;
    // A wake-up by the alarm must not shorten the wait the backoff already chose.
    if (now() - lastAttempt < MIN_RETRY_MS) { scheduleReconnect(); return; }
    lastAttempt = now();
    let p;
    try { p = chrome.runtime.connectNative(proto.HOST_NAME); } catch { scheduleReconnect(); return; }
    port = p;
    p.onMessage.addListener((/** @type {any} */ m) => { void onMessage(m); });
    p.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // read it so Chrome does not log an unchecked error
      if (port === p) port = null;
      scheduleReconnect();
    });
    void ready.then(() => post({
      event: "hello", protocol: proto.PROTOCOL,
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "0",
      ops: opNames(), caps: loadReport(),
    }));
  }

  if (chrome.alarms) {
    chrome.alarms.create(ALARM, { periodInMinutes: 1 });
    chrome.alarms.onAlarm.addListener((/** @type {any} */ a) => { if (a.name === ALARM && !port && !timer) connect(); });
  }

  connect();
  return { ctx, connect, onMessage, port: () => port, attempts: () => attempts, stop: () => { if (timer) clearT(timer); timer = null; } };
}

if (/** @type {any} */ (globalThis).chrome?.runtime?.id) start(/** @type {any} */ (globalThis).chrome);
