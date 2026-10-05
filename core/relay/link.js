// @ts-check
// link: the box's outbound connection to the relay (ADR 0026, section 7). One control socket,
// signed with the route key, and one data socket per device connection the relay announces.
// Each data socket runs the box's side of the Noise handshake; `admit` decides who gets in.
//
// Light by default: a text "ping" every 60 s (the relay answers it without waking), and two
// unanswered pings end the socket. Reconnects back off from 1 s to 5 minutes. Nothing polls.

import { EventEmitter } from "node:events";
import { boxSide } from "./channel.js";
import { authMessage, signRoute, CLOSE } from "./wire.js";

const PING_MS = 60_000;
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 5 * 60_000;
/** A control socket not ready by then is abandoned and redialled. */
const DIAL_MS = 30_000;

/** The WebSocket API accepts only 1000 and 3000 to 4999 from an application. */
const closeCode = code => code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000;

/**
 * @param {{ url: string, route: string, routeKey: { pub: Buffer, priv?: Buffer, sign?: (msg: Buffer) => Promise<Buffer> },
 *   boxKey: { pub: Buffer, priv?: Buffer, dh?: (remotePub: Buffer) => Buffer | Promise<Buffer> },
 *   admit: (devicePub: Buffer, hello: any) => Promise<any>,
 *   onchannel: (channel: import("./channel.js").Channel, info: { hello: any, reply: any }) => void,
 *   onstate?: (state: "connected"|"disconnected", why?: string) => void,
 *   oncode?: (msg: { q: string, rv: string, s: string, n: number, m: string }) => void,
 *   ontunnel?: (stream: any, visitor: { host: string, ip: string, port: number }) => void,
 *   log?: (m: string) => void, WebSocket?: any, pingMs?: number }} o
 */
export function relayLink(o) {
  const WS = o.WebSocket || globalThis.WebSocket;
  const log = o.log || (() => {});
  const pingMs = o.pingMs || PING_MS;
  const base = o.url.replace(/\/+$/, "");
  let stopped = false;
  /** @type {any} */
  let control = null;
  let ticket = "";
  let backoff = BACKOFF_MIN;
  /** @type {any} */
  let retry = null;
  /** @type {any} */
  let pinger = null;
  let connected = false;
  let upSince = Date.now();
  /** @type {Map<string, any>} */
  const data = new Map();
  /** Ticket registrations (ADR 0045) waiting for a connected control socket to carry them; sent
   * once, best effort, since each is single-use and short-lived on the relay anyway. */
  /** @type {Array<{ loc: string, record: string, mac: string, exp: number }>} */
  const pendingRegs = [];
  /** @type {string[]} */
  let relayFeatures = [];
  /** Setup offers (tailnet plan 3.6) stand until dropped: each reconnect sends them again, which
   * the relay answers 200 for the identical record and mac, so a box never locks itself out. */
  /** @type {Map<string, { loc: string, record: string, mac: string, exp: number }>} */
  const standing = new Map();
  /** The relay's answers to registrations, by locator: 200, or 409 when another server got there first. */
  /** @type {Map<string, Array<(status: number|null) => void>>} */
  const answers = new Map();
  /** The relay's answers to withdrawals, by locator: 200, or 404 when it holds no ticket of this box's under that locator. @type {Map<string, Array<(status: number|null) => void>>} */
  const revokeAnswers = new Map();
  const expectRevoke = (loc, ms = 5000) => new Promise(resolve => {
    const list = revokeAnswers.get(loc) || [];
    revokeAnswers.set(loc, list);
    const t = setTimeout(() => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); resolve(null); }, ms);
    const fn = status => { clearTimeout(t); resolve(status); };
    list.push(fn);
  });
  const expect = (loc, ms = 5000) => new Promise(resolve => {
    const list = answers.get(loc) || [];
    answers.set(loc, list);
    const t = setTimeout(() => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); resolve(null); }, ms);
    t.unref?.();
    const fn = status => { clearTimeout(t); resolve(status); };
    list.push(fn);
  });
  /** Waiters for the relay's answer to a typed-code allocation (spec 6.5). @type {Array<(a: { rv: string, exp: number } | null) => void>} */
  let codeWaiters = [];
  const flushRegs = () => {
    if (!control) return;
    for (const r of pendingRegs.splice(0)) { try { control.send(JSON.stringify({ t: "ticket", ...r })); } catch {} }
    for (const r of standing.values()) { try { control.send(JSON.stringify({ t: "setup", ...r })); } catch {} }
  };

  /** @type {Array<(ok: boolean) => void>} */
  let waiters = [];
  const state = (s, why) => {
    if ((s === "connected") === connected) return;
    connected = s === "connected";
    if (connected) waiters.splice(0).forEach(f => f(true));
    o.onstate?.(s, why);
  };

  function connect() {
    if (stopped) return;
    const ws = new WS(`${base}/v1/box?route=${o.route}`);
    control = ws;
    let missed = 0;
    // On Node 22 a refused WebSocket fires only `error`, never `close`, and can sit connecting:
    // either way counts as a failed dial, handled once.
    let settled = false;
    const dial = setTimeout(() => { log("relay: no answer from the relay; redialling"); gone({ code: 1006, reason: "dial timed out" }); }, DIAL_MS);
    dial.unref?.();
    ws.onmessage = async e => {
      if (typeof e.data !== "string") return;
      if (e.data === "pong") { missed = 0; return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "challenge") {
        const msg = authMessage(o.route, Buffer.from(String(m.n), "base64url"));
        let sig;
        try { sig = o.routeKey.sign ? await o.routeKey.sign(msg) : signRoute(/** @type {Buffer} */ (o.routeKey.priv), msg); } catch (err) { log(`relay: could not sign the challenge: ${/** @type {Error} */ (err).message}`); return; }
        if (ws !== control) return;
        ws.send(JSON.stringify({ t: "auth", pub: o.routeKey.pub.toString("base64url"), sig: sig.toString("base64url") }));
      } else if (m.t === "ready") {
        clearTimeout(dial);
        ticket = String(m.ticket || "");
        // What this relay says it does (an older one says nothing): whether it answers a registration, so silence can mean "older" or "failed".
        relayFeatures = Array.isArray(m.features) ? m.features.map(String) : [];
        backoff = BACKOFF_MIN;
        upSince = Date.now();
        state("connected");
        flushRegs();
        clearInterval(pinger);
        pinger = setInterval(() => {
          if (++missed > 2) { log("relay: no answer to two pings; reconnecting"); try { ws.close(4000, "stale"); } catch {} return; }
          try { ws.send("ping"); } catch {}
        }, pingMs);
        pinger.unref?.();
        for (const c of Array.isArray(m.waiting) ? m.waiting : []) openData(String(c));
      } else if (m.t === "revoked") { for (const f of revokeAnswers.get(String(m.loc)) || []) f(Number(m.status)); revokeAnswers.delete(String(m.loc)); }
      else if (m.t === "registered") { for (const f of answers.get(String(m.loc)) || []) f(Number(m.status)); answers.delete(String(m.loc)); }
      else if (m.t === "code.allocated") { const a = m.error ? null : { rv: String(m.rv), exp: Number(m.exp) }; for (const f of codeWaiters.splice(0)) f(a); }
      else if (m.t === "code.msg") { try { o.oncode?.({ q: String(m.q), rv: String(m.rv), s: String(m.s), n: Number(m.n), m: String(m.m) }); } catch (err) { log(`relay: code handler failed: ${/** @type {Error} */ (err).message}`); } }
      else if (m.t === "open") openData(String(m.c));
      else if (m.t === "tunnel") openTunnel(m);
      else if (m.t === "close") { data.get(String(m.c))?.close(1000); data.delete(String(m.c)); }
    };
    const gone = e => {
      if (settled) return;
      settled = true;
      clearTimeout(dial);
      try { ws.close(); } catch {}
      if (control !== ws) return;
      control = null;
      clearInterval(pinger);
      // one line that says how long the link had been up and what the relay (or the network) said, so a flap shows its own cause in the log the next time it happens
      if (!stopped && connected) log(`relay: control link closed after ${Math.round((Date.now() - upSince) / 1000)} s up (code ${e && e.code}${e && e.reason ? `, "${String(e.reason).slice(0, 80)}"` : ""})`);
      state("disconnected", e && e.reason ? String(e.reason) : `closed ${e && e.code}`);
      if (stopped) return;
      // Replaced means another process holds this route key (a restored copy of the box, say).
      // Retrying fast would make the two take turns replacing each other, so wait the longest.
      if (e && e.code === CLOSE.replaced) { log("relay: another box took this route; retrying in 5 minutes"); backoff = BACKOFF_MAX; }
      retry = setTimeout(connect, backoff);
      retry.unref?.();
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    };
    ws.onclose = gone;
    ws.onerror = () => gone({ code: 1006, reason: "could not reach the relay" });
  }

  function openData(c) {
    if (stopped || data.has(c) || !/^[A-Za-z0-9_-]{1,64}$/.test(c)) return;
    const ws = new WS(`${base}/v1/box?route=${o.route}&c=${encodeURIComponent(c)}&t=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    data.set(c, ws);
    const side = boxSide({
      get bufferedAmount() { return ws.bufferedAmount; },
      send: bytes => { try { ws.send(bytes); } catch {} },
      close: (code, reason) => { try { ws.close(closeCode(code), String(reason || "").slice(0, 120)); } catch {} },
    }, { s: o.boxKey, route: o.route, admit: o.admit });
    ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
    let ended = false;
    const end = why => { if (ended) return; ended = true; if (data.get(c) === ws) data.delete(c); try { ws.close(); } catch {} side.gone(why); };
    ws.onclose = e => end(e && e.reason ? String(e.reason) : "relay closed the connection");
    ws.onerror = () => end("could not reach the relay");
    side.ready.then(({ channel, hello, reply }) => o.onchannel(channel, { hello, reply }), e => log(`relay: refused a device: ${e.message}`));
  }

  /** A Publish tunnel stream (relay/node/tunnel.js): the relay names a visitor on its control channel and the box opens a data socket for the raw bytes, which go to `ontunnel` as a duplex.
   * The name and address come from the relay's authenticated control message; the box end (lib/publish/tunnel.js) still checks the name against its own Space. @param {any} m */
  function openTunnel(m) {
    const c = String(m.c);
    if (stopped || !o.ontunnel || data.has(c) || !/^[A-Za-z0-9_-]{1,64}$/.test(c)) return;
    const ip = String(m.ip || ""), port = Number(m.port) || 0;
    if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return;
    const ws = new WS(`${base}/v1/box?route=${o.route}&c=${encodeURIComponent(c)}&t=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    data.set(c, ws);
    const stream = new EventEmitter();
    let ended = false;
    const end = why => { if (ended) return; ended = true; if (data.get(c) === ws) data.delete(c); try { ws.close(); } catch {} stream.emit("close", why); };
    Object.assign(stream, {
      // Bytes to the visitor. A relay that stops reading for good leaves a growing buffer: past 4 MB the stream ends rather than hold it.
      write: (/** @type {Buffer} */ b) => { if (ended) return false; try { ws.send(b); } catch { end("send"); return false; } if (ws.bufferedAmount > 4 * 1024 * 1024) { end("stalled"); return false; } return true; },
      end: () => end("ended"), destroy: () => end("destroyed"), pause() {}, resume() {},
    });
    ws.onmessage = e => { if (typeof e.data !== "string") stream.emit("data", Buffer.from(e.data)); };
    ws.onclose = () => end("closed");
    ws.onerror = () => end("error");
    ws.onopen = () => { try { o.ontunnel?.(stream, { host: String(m.host || ""), ip, port }); } catch (err) { log(`relay: tunnel handler failed: ${/** @type {Error} */ (err).message}`); end("handler"); } };
  }

  connect();
  return {
    get connected() { return connected; },
    /** Resolves true once connected, or false after `ms`. */
    ready(ms = 5000) {
      if (connected) return Promise.resolve(true);
      return new Promise(resolve => {
        const t = setTimeout(() => { waiters = waiters.filter(f => f !== done); resolve(false); }, ms);
        t.unref?.();
        const done = ok => { clearTimeout(t); resolve(ok); };
        waiters.push(done);
      });
    },
    /** How many device connections are open through the relay. */
    get open() { return data.size; },
    /** Whether the relay this link is on promises an answer to every registration (so a missing one is a failure, not an older relay). */
    acknowledges() { return relayFeatures.includes("registered"); },
    /** Register a pairing ticket's locator/record/mac with the relay (ADR 0045), best effort:
     * queued if not connected yet, sent once the control socket is, never retried afterward
     * since each ticket is short-lived and single-use on the relay regardless. Resolves with the
     * relay's answer (200, or 409 when the locator was already taken with another record), or null
     * when it did not answer in 5 seconds.
     * @param {{ loc: string, record: string, mac: string, exp: number }} reg @returns {Promise<number|null>} */
    registerTicket(reg) { const a = expect(reg.loc); pendingRegs.push(reg); flushRegs(); return a; },
    /** Whether the relay this link is on can withdraw a ticket (a renewal replaces the previous one). */
    revokes() { return relayFeatures.includes("revoke"); },
    /** Withdraw a ticket this box registered. Resolves with the relay's answer (200, or 404 when it held none), or null on no answer.
     * @param {string} loc @returns {Promise<number|null>} */
    revokeTicket(loc) {
      if (!control) return Promise.resolve(null);
      const a = expectRevoke(loc);
      try { control.send(JSON.stringify({ t: "revoke", loc })); } catch {}
      return a;
    },
    /** Whether the relay this link is on has the typed-code rendezvous. */
    codes() { return relayFeatures.includes("code"); },
    /** Ask the relay for a free typed-code rendezvous (5 minutes; this box holds at most one, a new ask replaces it).
     * Resolves { rv, exp }, or null when the relay is busy, does not answer in 5 seconds, or the link is down.
     * @returns {Promise<{ rv: string, exp: number } | null>} */
    codeAlloc() {
      if (!control || !connected) return Promise.resolve(null);
      return new Promise(resolve => {
        const t = setTimeout(() => { codeWaiters = codeWaiters.filter(f => f !== fn); resolve(null); }, 5000);
        t.unref?.();
        const fn = a => { clearTimeout(t); resolve(a); };
        codeWaiters.push(fn);
        try { control.send(JSON.stringify({ t: "code.alloc" })); } catch {}
      });
    },
    /** Give the rendezvous back. */
    codeRelease() { try { control?.send(JSON.stringify({ t: "code.release" })); } catch {} },
    /** Answer a message `oncode` delivered: `m` (base64url) is the reply; null refuses it. The relay gives the typing device one generic answer for a refusal.
     * @param {string} q @param {string|null} m */
    codeReply(q, m) { try { control?.send(JSON.stringify(m ? { t: "code.reply", q, m } : { t: "code.reply", q })); } catch {} },
    /** Register a setup offer's locator (tailnet plan 3.6): same fields, kept until dropSetup and
     * sent again after every reconnect. Resolves as registerTicket does; 409 means another server
     * used this code first, and the offer is dropped here so it is never re-sent.
     * @param {{ loc: string, record: string, mac: string, exp: number }} reg @returns {Promise<number|null>} */
    registerSetup(reg) {
      standing.set(reg.loc, reg);
      const a = expect(reg.loc).then(status => { if (status === 409) standing.delete(reg.loc); return status; });
      flushRegs();
      return a;
    },
    /** @param {string} loc */
    dropSetup(loc) { standing.delete(loc); },
    stop() {
      stopped = true;
      clearTimeout(retry);
      clearInterval(pinger);
      for (const ws of data.values()) { try { ws.close(1000, "box stopping"); } catch {} }
      data.clear();
      try { control?.close(1000, "box stopping"); } catch {}
      control = null;
      state("disconnected", "stopped");
    },
  };
}
