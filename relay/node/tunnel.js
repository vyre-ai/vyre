// @ts-check
// The public front of the Publish tunnel (relay side; the box side is lib/publish/tunnel.js). The relay takes public TCP 443, reads one TLS ClientHello to learn the SNI name, asks the
// directory which Space's box serves that name, and pipes the visitor's bytes to that box over a data socket the box opens (relay/node/server.js, the same data-socket way a device
// connection takes). Nothing here terminates TLS or holds a certificate: certificates are made on the box by DNS-01 only (reviewer-3 PT-1), so the relay carries ciphertext it cannot read
// and cannot get a certificate for.
//
//   - Port 80 never reaches a box: it answers a fixed redirect to https for a name that looks like a host, or 400 (PT-1).
//   - The ClientHello is read with a bound: at most 16 KB, 5 seconds, one SNI name, no IP literal, no name over 253 bytes or a label over 63 (PT-4). Nothing is forwarded before the name is
//     known and the directory has said which box serves it.
//   - What a Space may serve comes from the directory only, re-read at most every 60 s, and a stream whose name stops resolving to its route is closed at the next re-check (PT-2).
//   - The visitor's address is given to the box in the open message (the relay's own authenticated control channel), never in the byte stream, so a visitor cannot forge one (PT-6).
//   - Limits: per address, per route, and overall, on streams open and on streams per minute; idle timeout, lifetime and a byte cap per direction (PT-5, PT-8).
// No dependency but node:net.
import net from "node:net";

const HELLO_MAX = 16 * 1024 + 5;
const HELLO_MS = 5000;
const NAME_MAX = 253;

/** A name a ClientHello may ask for: lowercase letters, digits, dots and hyphens; labels of 1 to 63; no IP literal; at most 253 bytes. @param {string} h */
export function validHost(h) {
  if (typeof h !== "string" || !h || h.length > NAME_MAX || h !== h.toLowerCase() || h.endsWith(".")) return false;
  if (net.isIP(h)) return false;
  const labels = h.split(".");
  if (labels.length < 2) return false;
  return labels.every(l => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l) && !/^xn--.*[^a-z0-9-]/.test(l));
}

/**
 * The server name in a TLS ClientHello. `incomplete` says more bytes may complete it; a null host that is not incomplete is a refusal, with the reason in `why`.
 * Stricter than the box end's parser: only a handshake record of version 3.x, one server_name extension, one host_name entry, the whole record within 16 KB, and no ECH-only hello.
 * @param {Uint8Array} buf @returns {{ host: string | null, incomplete: boolean, why?: string }}
 */
export function parseClientHello(buf) {
  const no = (/** @type {string} */ why) => ({ host: null, incomplete: false, why });
  const more = { host: null, incomplete: true };
  if (buf.length === 0) return more;
  if (buf[0] !== 0x16) return no("not_tls");
  if (buf.length < 5) return more;
  if (buf[1] !== 3 || buf[2] > 4) return no("not_tls");
  const recLen = (buf[3] << 8) | buf[4];
  if (recLen < 42 || recLen > 16384) return no("bad_record");
  if (buf.length < 5 + recLen) return more;
  const end = 5 + recLen;
  let p = 5;
  if (buf[p] !== 0x01) return no("not_hello");
  const hsLen = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
  if (4 + hsLen > recLen) return no("fragmented"); // a hello spread over several records is refused: no real client sends one
  p += 4 + 2 + 32;
  const need = (/** @type {number} */ n) => p + n <= end;
  if (!need(1)) return no("short");
  p += 1 + buf[p];
  if (!need(2)) return no("short");
  p += 2 + ((buf[p] << 8) | buf[p + 1]);
  if (!need(1)) return no("short");
  p += 1 + buf[p];
  if (!need(2)) return no("short");
  const extEnd = p + 2 + ((buf[p] << 8) | buf[p + 1]);
  if (extEnd > end) return no("short");
  p += 2;
  let host = null, seen = 0;
  while (p + 4 <= extEnd) {
    const type = (buf[p] << 8) | buf[p + 1], len = (buf[p + 2] << 8) | buf[p + 3];
    p += 4;
    if (p + len > extEnd) return no("short");
    if (type === 0) {
      if (++seen > 1) return no("two_names");
      if (len < 5) return no("bad_name");
      const listLen = (buf[p] << 8) | buf[p + 1];
      if (listLen + 2 !== len) return no("bad_name");
      let q = p + 2;
      const nt = buf[q], nl = (buf[q + 1] << 8) | buf[q + 2];
      q += 3;
      if (nt !== 0 || q + nl !== p + len) return no("bad_name");
      host = Buffer.from(buf.subarray(q, q + nl)).toString("latin1");
    }
    p += len;
  }
  if (host === null) return no("no_sni");
  return validHost(host) ? { host, incomplete: false } : no("bad_host");
}

/** A fixed window per key: true while under it. @param {number} max @param {number} windowMs @param {() => number} now */
function windowLimit(max, windowMs, now) {
  /** @type {Map<string, { n: number, resetAt: number }>} */
  const hits = new Map();
  return (/** @type {string} */ key) => {
    const t = now();
    let h = hits.get(key);
    if (!h || h.resetAt <= t) { h = { n: 0, resetAt: t + windowMs }; hits.set(key, h); }
    h.n++;
    if (hits.size > 10_000) for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    return h.n <= max;
  };
}

/**
 * @typedef {{ route: string }} Resolved
 * @typedef {{ write(b: Buffer): boolean | void, close(): void }} BoxEnd what the transport gives for one visitor: write bytes to the box, and end it
 * @param {{
 *   resolve: (host: string) => Promise<Resolved | null>,
 *   open: (route: string, visitor: { host: string, ip: string, port: number }, sink: { data: (b: Buffer) => boolean | void, end: () => void, resume: () => void, whenDrained: (f: () => void) => void }) => Promise<BoxEnd | null>,
 *   log?: (what: string, x?: any) => void, now?: () => number,
 *   limits?: { perIp?: number, perIpPerMin?: number, perRoute?: number, total?: number, idleMs?: number, lifeMs?: number, bytes?: number, openMs?: number, ttlMs?: number, recheckMs?: number },
 * }} o
 */
export function createTunnelFront(o) {
  const log = o.log || (() => {});
  const now = o.now || Date.now;
  const L = { perIp: 64, perIpPerMin: 300, perRoute: 512, total: 4096, idleMs: 120_000, lifeMs: 3_600_000, bytes: 2 * 1024 ** 3, openMs: 8000, ttlMs: 60_000, recheckMs: 30_000, ...(o.limits || {}) };
  const rate = windowLimit(L.perIpPerMin, 60_000, now);
  /** @type {Map<string, number>} */ const byIp = new Map();
  /** @type {Map<string, number>} */ const byRoute = new Map();
  /** @type {Set<{ route: string, host: string, end: (why: string) => void }>} */ const live = new Set();
  /** @type {Map<string, { at: number, v: Resolved | null }>} */ const cache = new Map();
  const stats = { accepted: 0, refused: /** @type {Record<string, number>} */ ({}), closedByRecheck: 0 };
  const refused = (/** @type {string} */ why) => { stats.refused[why] = (stats.refused[why] || 0) + 1; };
  const bump = (/** @type {Map<string, number>} */ m, /** @type {string} */ k, /** @type {number} */ d) => { const n = (m.get(k) || 0) + d; if (n <= 0) m.delete(k); else m.set(k, n); };

  /** The directory's answer for a name, kept for ttlMs; a failed lookup is no answer (the name is refused), never a stale yes. @param {string} host @param {boolean} [fresh] */
  async function lookup(host, fresh = false) {
    const c = cache.get(host);
    if (!fresh && c && now() - c.at < L.ttlMs) return c.v;
    /** @type {Resolved | null} */ let v = null;
    try { v = await o.resolve(host); } catch { v = null; }
    if (cache.size > 5000) cache.clear();
    cache.set(host, { at: now(), v });
    return v;
  }

  /** One public TLS connection. @param {net.Socket} s */
  function tls(s) {
    const ip = String(s.remoteAddress || "").replace(/^::ffff:/, "");
    const port = s.remotePort || 0;
    s.setNoDelay(true);
    const drop = (/** @type {string} */ why) => { refused(why); s.destroy(); };
    s.on("error", () => {});
    if (live.size >= L.total) return drop("busy");
    if (!rate(ip)) return drop("rate");
    if ((byIp.get(ip) || 0) >= L.perIp) return drop("per_ip");
    bump(byIp, ip, 1);
    let counted = true;
    const uncount = () => { if (counted) { counted = false; bump(byIp, ip, -1); } };
    s.on("close", uncount);
    /** @type {Buffer[]} */ let held = [];
    let heldLen = 0, done = false;
    const hello = setTimeout(() => { if (!done) { done = true; drop("no_hello"); } }, HELLO_MS);
    hello.unref?.();
    const onData = async (/** @type {Buffer} */ chunk) => {
      if (done) return;
      held.push(chunk); heldLen += chunk.length;
      if (heldLen > HELLO_MAX) { done = true; clearTimeout(hello); return drop("too_big"); }
      const r = parseClientHello(Buffer.concat(held, heldLen));
      if (r.host === null && r.incomplete) return;
      done = true;
      clearTimeout(hello);
      s.off("data", onData);
      s.pause();
      if (r.host === null) return drop(r.why || "bad_hello");
      const first = Buffer.concat(held, heldLen);
      held = [];
      const found = await lookup(r.host);
      if (!found || s.destroyed) return drop(found ? "gone" : "unknown_name");
      const route = found.route;
      if ((byRoute.get(route) || 0) >= L.perRoute) return drop("per_route");
      bump(byRoute, route, 1);
      let ended = false;
      /** @type {BoxEnd | null} */ let box = null;
      /** @type {any} */ let idle = null, life = null;
      let up = 0, down = 0;
      const entry = { route, host: r.host, end: (/** @type {string} */ why) => end(why) };
      live.add(entry);
      const end = (/** @type {string} */ why) => {
        if (ended) return; ended = true;
        clearTimeout(idle); clearTimeout(life);
        live.delete(entry); bump(byRoute, route, -1);
        try { box && box.close(); } catch { /* gone */ }
        s.destroy();
        log("tunnel.closed", { route, host: r.host, why, up, down });
      };
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => end("idle"), L.idleMs); idle.unref?.(); };
      life = setTimeout(() => end("lifetime"), L.lifeMs); life.unref?.();
      touch();
      s.on("close", () => end("visitor_closed"));
      // What the transport calls: bytes from the box, the box ending, and room again in its buffer after a write said false.
      const sink = {
        data: (/** @type {Buffer} */ b) => { if (ended) return true; touch(); down += b.length; if (down > L.bytes) { end("bytes"); return true; } return s.write(b); },
        end: () => end("box_closed"),
        resume: () => { if (!ended) s.resume(); },
        whenDrained: (/** @type {() => void} */ f) => { s.once("drain", f); },
      };
      try { box = await Promise.race([o.open(route, { host: r.host, ip, port }, sink), new Promise(res => { const t = setTimeout(() => res(null), L.openMs); t.unref?.(); })]); } catch { box = null; }
      if (!box || ended) { if (!ended) { refused("box_unreachable"); end("box_unreachable"); } else { try { box && box.close(); } catch { /* gone */ } } return; }
      stats.accepted++;
      const push = (/** @type {Buffer} */ b) => { touch(); up += b.length; if (up > L.bytes) return end("bytes"); if (box && box.write(b) === false) { s.pause(); } };
      push(first);
      s.on("data", push);
      s.resume();
    };
    s.on("data", onData);
  }

  /** Port 80: a fixed redirect, never a connection to a box. @param {net.Socket} s */
  function http(s) {
    s.on("error", () => {});
    s.setTimeout(5000, () => s.destroy());
    let buf = "";
    s.on("data", chunk => {
      buf += chunk.toString("latin1");
      if (buf.length > 4096) { s.destroy(); return; }
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      s.removeAllListeners("data");
      const m = /^host:[ \t]*([^\r\n:]+)(?::\d+)?[ \t]*$/im.exec(buf.slice(0, end));
      const host = m ? m[1].trim().toLowerCase() : "";
      if (!validHost(host)) { s.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n"); return; }
      s.end(`HTTP/1.1 308 Permanent Redirect\r\nlocation: https://${host}/\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    });
  }

  /** Re-ask the directory about every name in use; a stream whose name no longer resolves to its route is closed (PT-2: within a minute). */
  async function recheck() {
    const names = new Map();
    for (const e of live) names.set(e.host, null);
    for (const host of names.keys()) names.set(host, await lookup(host, true));
    for (const e of [...live]) {
      const v = names.get(e.host);
      if (!v || v.route !== e.route) { stats.closedByRecheck++; e.end("claim_gone"); }
    }
  }
  const timer = setInterval(() => { recheck().catch(() => {}); }, L.recheckMs);
  timer.unref?.();

  return { tls, http, recheck, stats, open: () => live.size, close() { clearInterval(timer); for (const e of [...live]) e.end("stopping"); } };
}
