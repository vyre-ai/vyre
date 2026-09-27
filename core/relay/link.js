// @ts-check
// link: the box's outbound connection to the relay (ADR 0026, section 7). One control socket,
// signed with the route key, and one data socket per device connection the relay announces.
// Each data socket runs the box's side of the Noise handshake; `admit` decides who gets in.
//
// Light by default: a text "ping" every 60 s (the relay answers it without waking), and two
// unanswered pings end the socket. Reconnects back off from 1 s to 5 minutes. Nothing polls.

import { boxSide } from "./channel.js";
import { authMessage, signRoute, CLOSE } from "./wire.js";

const PING_MS = 60_000;
const BACKOFF_MIN = 1_000;
const BACKOFF_MAX = 5 * 60_000;

/** The WebSocket API accepts only 1000 and 3000 to 4999 from an application. */
const closeCode = code => code === 1000 || (code >= 3000 && code <= 4999) ? code : 4000;

/**
 * @param {{ url: string, route: string, routeKey: { priv: Buffer, pub: Buffer }, boxKey: { priv: Buffer, pub: Buffer },
 *   admit: (devicePub: Buffer, hello: any) => Promise<any>,
 *   onchannel: (channel: import("./channel.js").Channel, info: { hello: any, reply: any }) => void,
 *   onstate?: (state: "connected"|"disconnected", why?: string) => void,
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
  /** @type {Map<string, any>} */
  const data = new Map();

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
    ws.onmessage = e => {
      if (typeof e.data !== "string") return;
      if (e.data === "pong") { missed = 0; return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === "challenge") {
        const sig = signRoute(o.routeKey.priv, authMessage(o.route, Buffer.from(String(m.n), "base64url")));
        ws.send(JSON.stringify({ t: "auth", pub: o.routeKey.pub.toString("base64url"), sig: sig.toString("base64url") }));
      } else if (m.t === "ready") {
        ticket = String(m.ticket || "");
        backoff = BACKOFF_MIN;
        state("connected");
        clearInterval(pinger);
        pinger = setInterval(() => {
          if (++missed > 2) { log("relay: no answer to two pings; reconnecting"); try { ws.close(4000, "stale"); } catch {} return; }
          try { ws.send("ping"); } catch {}
        }, pingMs);
        pinger.unref?.();
        for (const c of Array.isArray(m.waiting) ? m.waiting : []) openData(String(c));
      } else if (m.t === "open") openData(String(m.c));
      else if (m.t === "close") { data.get(String(m.c))?.close(1000); data.delete(String(m.c)); }
    };
    ws.onclose = e => {
      if (control !== ws) return;
      control = null;
      clearInterval(pinger);
      state("disconnected", e && e.reason ? String(e.reason) : `closed ${e && e.code}`);
      if (stopped) return;
      // Replaced means another process holds this route key (a restored copy of the box, say).
      // Retrying fast would make the two take turns replacing each other, so wait the longest.
      if (e && e.code === CLOSE.replaced) { log("relay: another box took this route; retrying in 5 minutes"); backoff = BACKOFF_MAX; }
      retry = setTimeout(connect, backoff);
      retry.unref?.();
      backoff = Math.min(backoff * 2, BACKOFF_MAX);
    };
    ws.onerror = () => {};
  }

  function openData(c) {
    if (stopped || data.has(c) || !/^[A-Za-z0-9_-]{1,64}$/.test(c)) return;
    const ws = new WS(`${base}/v1/box?route=${o.route}&c=${encodeURIComponent(c)}&t=${encodeURIComponent(ticket)}`);
    ws.binaryType = "arraybuffer";
    data.set(c, ws);
    const side = boxSide({
      send: bytes => { try { ws.send(bytes); } catch {} },
      close: (code, reason) => { try { ws.close(closeCode(code), String(reason || "").slice(0, 120)); } catch {} },
    }, { s: o.boxKey, route: o.route, admit: o.admit });
    ws.onmessage = e => { if (typeof e.data !== "string") side.receive(Buffer.from(e.data)); };
    ws.onclose = e => { data.delete(c); side.gone(e && e.reason ? String(e.reason) : "relay closed the connection"); };
    ws.onerror = () => {};
    side.ready.then(({ channel, hello, reply }) => o.onchannel(channel, { hello, reply }), e => log(`relay: refused a device: ${e.message}`));
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
