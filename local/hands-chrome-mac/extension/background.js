// @ts-check
// background: the shell. It does four things and nothing else (ADR 0049):
//   1. holds the native-messaging connection to the host ("run.vyre.chrome") and says hello,
//   2. hands each {id, op, args} to the capability registry (caps/index.js),
//   3. redacts every result (shared/redact.js) before it leaves the browser,
//   4. answers {id, ok:true, result} or {id, ok:false, error:{code, message}}.
//
// Light by default (Vyre SPEC principle 8): while connected the open native port keeps the worker
// alive and nothing polls. While disconnected it retries every few seconds for the first two minutes of
// a failure (a person who has just installed is watching for it), then backs off to a minute, and a
// once-a-minute alarm wakes a sleeping worker to try again. Idle cost is that alarm.
//
// Nothing is swallowed: every attempt, Chrome's own error for a failure, and the moment it connected are
// kept in chrome.storage.session ("vyre.conn"), and the popup and the toolbar badge say what is wrong.
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
import { explain } from "./shared/diag.js";

export const MIN_RETRY_MS = 2500;
export const FAST_RETRY_MS = 3000;
export const FAST_WINDOW_MS = 120_000;
export const BACKOFF_START_MS = 5000;
export const MAX_RETRY_MS = 60_000;
/** After this long failing, the toolbar badge shows "!" so the person notices without opening anything. */
export const BADGE_AFTER_MS = 20_000;
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
  /** The record the popup reads. @type {import("./shared/diag.js").Conn} */
  const conn = { startedAt: now(), attempts: 0, lastAttemptAt: null, lastError: null, lastErrorAt: null, connectedAt: null, everConnected: false, failingSince: null };
  /** Attempts since the failure streak began (the backoff's own counter). */
  let streak = 0;
  const persist = () => {
    try {
      const p = chrome.storage && chrome.storage.session && chrome.storage.session.set({ "vyre.conn": { ...conn } });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch { /* storage may be gone with the worker */ }
    try {
      if (chrome.action && chrome.action.setBadgeText) {
        const failingFor = conn.failingSince == null ? 0 : now() - conn.failingSince;
        const bad = !conn.connectedAt || conn.failingSince != null ? failingFor >= BADGE_AFTER_MS : false;
        chrome.action.setBadgeText({ text: bad ? "!" : "" });
        if (bad && chrome.action.setBadgeBackgroundColor) chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
        if (chrome.action.setTitle) chrome.action.setTitle({ title: `Vyre for Chrome: ${explain(conn, now()).headline}` });
      }
    } catch { /* no action API in this browser */ }
  };
  /** A failed attempt: keep Chrome's own words and when the streak began. @param {string} why */
  const failed = why => {
    conn.lastError = String(why || "the connector closed the connection").slice(0, 300);
    conn.lastErrorAt = now();
    if (conn.failingSince == null) conn.failingSince = now();
    persist();
  };

  /** @param {any} msg */
  function post(msg) {
    if (!port) return false;
    try { port.postMessage(msg); return true; } catch { return false; }
  }

  const emit = (/** @type {any} */ evt) => { post(redactResult(evt)); };
  const ctx = createCtx({ chrome, emit });

  /** @param {any} msg */
  async function onMessage(msg) {
    attempts = 0; streak = 0;
    if (!conn.connectedAt || conn.failingSince != null) { conn.connectedAt = now(); conn.everConnected = true; conn.failingSince = null; conn.lastError = null; persist(); }
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
      // A capability's structured detail (a trace, a redacted page snippet) rides in error.detail; the bridge and the module pass it on.
      const detail = /** @type {any} */ (e)?.detail;
      post({ id, ok: false, error: { ...proto.fail(known ? code : "error", redact.text(String(/** @type {any} */ (e)?.message || e))), ...(detail !== undefined && typeof detail === "object" ? { detail: redactResult(detail) } : {}) } });
    }
  }

  function scheduleReconnect() {
    if (timer) return;
    // Fast for the first two minutes of a failure, then backing off to a minute.
    const failingFor = conn.failingSince == null ? 0 : now() - conn.failingSince;
    const wait = failingFor < FAST_WINDOW_MS ? FAST_RETRY_MS : Math.min(MAX_RETRY_MS, BACKOFF_START_MS * 2 ** Math.min(streak++, 10));
    attempts++;
    timer = setT(() => { timer = null; connect(); }, wait);
  }

  function connect() {
    if (port) return;
    // A wake-up by the alarm must not shorten the wait the backoff already chose.
    if (now() - lastAttempt < MIN_RETRY_MS) { scheduleReconnect(); return; }
    lastAttempt = now();
    conn.attempts++; conn.lastAttemptAt = now();
    let p;
    try { p = chrome.runtime.connectNative(proto.HOST_NAME); } catch (e) { failed(/** @type {any} */ (e) && /** @type {any} */ (e).message || String(e)); scheduleReconnect(); return; }
    port = p;
    persist();
    p.onMessage.addListener((/** @type {any} */ m) => { void onMessage(m); });
    p.onDisconnect.addListener(() => {
      // Chrome's own reason ("Specified native messaging host not found.", "...forbidden.", "Native host has exited."): kept, never dropped.
      const le = chrome.runtime.lastError;
      if (port === p) port = null;
      failed(le && le.message ? le.message : conn.connectedAt ? "the connector closed the connection" : "the connector closed the connection before saying anything");
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
  return { ctx, connect, onMessage, port: () => port, attempts: () => attempts, conn: () => ({ ...conn }), stop: () => { if (timer) clearT(timer); timer = null; } };
}

if (/** @type {any} */ (globalThis).chrome?.runtime?.id) start(/** @type {any} */ (globalThis).chrome);
