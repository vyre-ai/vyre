// @ts-check
// egress: Glass egress through the person's own Mac, over the Wink peer link (team/0.3 removal plan, decision D2).
//
// A bank or a court that sees a datacenter address asks questions, or refuses. With config glass.egress on, the listed sites leave an agent's Chrome (core/computers/egress.js
// writes the proxy script) from the person's Mac instead of the box. The Mac's own vyred holds one connection open to its home (core/wink/storage/hold.js: the device dials out, the
// home calls back down it), and this file is both ends of what runs over it:
//
//   Mac    createEgressAgent({ sites, ... }).serve    answers the four tunnel calls below on the Mac's own connection to the world. It dials ONLY a host the Mac's own list names
//                                                      (the person's word, not the home's), only at a public address it resolved itself and then connects to by address (so a name that
//                                                      later points at the Mac's LAN, loopback, a link-local or CGNAT address is refused), and never more than a handful of tunnels.
//   home   createEgressHome({ linkTo, device, ... })   `open(host, port)` makes a tunnel through the Mac as a duplex stream; `verdict()` says whether a listed site may leave right now.
//   home   createSocksGate({ home, ... })              the SOCKS5 server the computers' proxy script points at (egress:1055). CONNECT only, no other command, no auth.
//
// Fail closed, always: a listed site has no direct fallback. With the Mac asleep, away, not chosen, not holding a connection, or its list not naming the site, the answer is a
// refused CONNECT and the page fails to load rather than showing the datacenter's address. The gate never dials a site itself. Names are resolved on the Mac, so the box's resolver
// never sees which site a computer opened.
//
// The tunnel is four calls on the peer session (JSON, base64 data; the session cuts and queues big messages fairly, so a tunnel never starves a ping):
//   wink.egress.open   { host, port }      -> { id }
//   wink.egress.write  { id, data }        -> {}         answers when the bytes are handed to the socket (that is the backpressure)
//   wink.egress.read   { id, max?, waitMs? } -> { data, eof }   long poll: waits up to waitMs (at most 25 s) for bytes
//   wink.egress.end    { id }              -> {}         the client is done writing
//   wink.egress.close  { id }              -> {}
//   wink.egress.status { }                 -> { ok: true, sites: n, tunnels: n }

import net from "node:net";
import dns from "node:dns";
import { Duplex } from "node:stream";
import { isPublicAddress } from "../../lib/sandbox/addr.js";
import { holdDrive } from "./storage/hold.js";

export const EGRESS_TOOLS = Object.freeze(["wink.egress.open", "wink.egress.write", "wink.egress.read", "wink.egress.end", "wink.egress.close", "wink.egress.status"]);
export const MAX_TUNNELS = 32;
export const CHUNK = 32 * 1024;
const MAX_WRITE = 96 * 1024;
const READ_CAP = 25_000;
const BUFFER_CAP = 512 * 1024;

const err = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** Does a host match the person's list? Exact names and "*.name" (which also covers the name itself). @param {string} host @param {string[]} sites */
export function listed(host, sites) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  return sites.some(s => (s.startsWith("*.") ? h === s.slice(2) || h.endsWith(s.slice(1)) : h === s));
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the Mac's side
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * @param {{
 *   sites: () => string[],                                      the Mac owner's own list (config glass.egress.sites, already checked); empty refuses everything
 *   resolve?: (host: string) => Promise<{ address: string, family: number }[]>,
 *   connect?: (o: { host: string, port: number }) => net.Socket,
 *   allow?: (ip: string) => boolean,                            default: public addresses only (lib/sandbox/addr.js)
 *   maxTunnels?: number, idleMs?: number, connectMs?: number, log?: (m: string) => void,
 * }} o
 */
export function createEgressAgent(o) {
  const log = o.log || (() => {});
  const resolve = o.resolve || (h => dns.promises.lookup(h, { all: true, verbatim: true }));
  const connect = o.connect || (a => net.connect({ host: a.host, port: a.port }));
  const allow = o.allow || isPublicAddress;
  const maxTunnels = o.maxTunnels ?? MAX_TUNNELS, idleMs = o.idleMs ?? 120_000, connectMs = o.connectMs ?? 10_000;
  /** @type {Map<string, { sock: net.Socket, chunks: Buffer[], size: number, eof: boolean, waiter: (() => void) | null, timer: any, host: string }>} */
  const tunnels = new Map();
  let n = 0;

  const drop = (/** @type {string} */ id) => {
    const t = tunnels.get(id);
    if (!t) return;
    tunnels.delete(id); clearTimeout(t.timer);
    try { t.sock.destroy(); } catch { /* gone */ }
    if (t.waiter) { const w = t.waiter; t.waiter = null; w(); }
  };
  const touch = (/** @type {any} */ t, /** @type {string} */ id) => { clearTimeout(t.timer); t.timer = setTimeout(() => { log(`wink egress: a tunnel to ${t.host} was idle too long, closing it`); drop(id); }, idleMs); t.timer.unref?.(); };
  const get = (/** @type {any} */ i) => { const id = String(i && i.id); const t = tunnels.get(id); if (!t) throw err("not_found", "no such tunnel"); touch(t, id); return { id, t }; };

  /** Dial a listed host at a public address the Mac resolved itself; connect by that address. @param {string} host @param {number} port */
  async function open(host, port) {
    host = String(host || "").toLowerCase().replace(/\.$/, "");
    if (!HOST.test(host) || host.length > 253) throw err("denied", "that is not a site this Mac sends");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw err("bad_input", "port");
    if (!listed(host, o.sites())) throw err("denied", "that site is not on this Mac's list");
    if (tunnels.size >= maxTunnels) throw err("busy", "this Mac has as many tunnels open as it allows");
    /** @type {{ address: string, family: number }[]} */ let all;
    try { all = await resolve(host); } catch { throw err("unreachable", "this Mac could not find that site"); }
    const ok = all.filter(a => allow(a.address));
    if (!ok.length) throw err("denied", "that name does not lead to a public address, so this Mac will not dial it");
    const to = ok[0].address;
    const sock = connect({ host: to, port });
    await new Promise((res, rej) => {
      const t = setTimeout(() => { sock.destroy(); rej(err("timeout", "no answer from that site")); }, connectMs); t.unref?.();
      sock.once("connect", () => { clearTimeout(t); res(undefined); });
      sock.once("error", e => { clearTimeout(t); rej(err(/** @type {any} */ (e).code === "ECONNREFUSED" ? "refused" : "unreachable", "that site did not accept the connection")); });
    });
    const id = `t${++n}`;
    /** @type {any} */
    const t = { sock, chunks: [], size: 0, eof: false, waiter: null, timer: null, host };
    tunnels.set(id, t); touch(t, id);
    const wake = () => { if (t.waiter) { const w = t.waiter; t.waiter = null; w(); } };
    sock.on("data", d => { t.chunks.push(d); t.size += d.length; if (t.size > BUFFER_CAP) sock.pause(); wake(); });
    sock.on("end", () => { t.eof = true; wake(); });
    sock.on("close", () => { t.eof = true; wake(); });
    sock.on("error", () => { t.eof = true; wake(); });
    return { id };
  }

  return {
    /** Answers the tunnel calls; hand it to the held connection as its `serve`. @param {string} tool @param {any} input */
    async serve(tool, input = {}) {
      if (tool === "wink.egress.status") return { ok: true, sites: o.sites().length, tunnels: tunnels.size };
      if (tool === "wink.egress.open") return open(input.host, Number(input.port));
      if (tool === "wink.egress.write") {
        const { t } = get(input);
        const b = Buffer.from(String(input.data || ""), "base64");
        if (b.length > MAX_WRITE) throw err("bad_input", "too much in one write");
        if (!t.sock.writable) throw err("closed", "the tunnel is closed");
        await new Promise((res, rej) => t.sock.write(b, e => (e ? rej(err("closed", "the tunnel is closed")) : res(undefined))));
        return {};
      }
      if (tool === "wink.egress.read") {
        const { t } = get(input);
        const max = Math.min(Math.max(1, Number(input.max) || CHUNK), CHUNK), wait = Math.min(Math.max(0, Number(input.waitMs) || 0), READ_CAP);
        if (!t.chunks.length && !t.eof && wait > 0) {
          await new Promise(res => { const timer = setTimeout(() => { t.waiter = null; res(undefined); }, wait); timer.unref?.(); t.waiter = () => { clearTimeout(timer); res(undefined); }; });
        }
        if (!t.chunks.length) return { data: "", eof: Boolean(t.eof) };
        let buf = Buffer.concat(t.chunks);
        if (buf.length > max) { t.chunks = [buf.subarray(max)]; buf = buf.subarray(0, max); } else t.chunks = [];
        t.size = t.chunks.reduce((s, c) => s + c.length, 0);
        if (t.size < BUFFER_CAP / 2) t.sock.resume();
        return { data: buf.toString("base64"), eof: false };
      }
      if (tool === "wink.egress.end") { const { t } = get(input); try { t.sock.end(); } catch { /* gone */ } return {}; }
      if (tool === "wink.egress.close") { drop(String(input && input.id)); return {}; }
      throw err("denied", "this connection answers only the egress calls");
    },
    tunnels: () => tunnels.size,
    close() { for (const id of [...tunnels.keys()]) drop(id); },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the home's side
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** One tunnel as a duplex stream: writes are calls, reads are long polls. */
class Tunnel extends Duplex {
  /** @param {{ call: (tool: string, input?: any, opt?: any) => Promise<any> }} link @param {string} id @param {number} pollMs */
  constructor(link, id, pollMs) {
    super({ allowHalfOpen: true, highWaterMark: CHUNK * 2 });
    this.link = link; this.id = id; this.pollMs = pollMs;
    this.polling = false; this.done = false;
  }
  _read() { if (!this.polling && !this.done) this.#poll(); }
  async #poll() {
    this.polling = true;
    try {
      while (!this.destroyed && !this.done) {
        const r = await this.link.call("wink.egress.read", { id: this.id, max: CHUNK, waitMs: this.pollMs }, { timeoutMs: this.pollMs + 15_000 });
        if (this.destroyed) return;
        if (r && r.data) { if (!this.push(Buffer.from(String(r.data), "base64"))) { this.polling = false; return; } }
        else if (r && r.eof) { this.done = true; this.push(null); return; }
      }
    } catch (e) { this.done = true; if (!this.destroyed) this.destroy(/** @type {Error} */ (e)); }
    this.polling = false;
  }
  _write(/** @type {Buffer} */ chunk, _enc, /** @type {(e?: Error | null) => void} */ cb) {
    // cut to the size one call takes; each slice is answered before the next goes (that is the flow control)
    (async () => { for (let i = 0; i < chunk.length; i += CHUNK) await this.link.call("wink.egress.write", { id: this.id, data: chunk.subarray(i, i + CHUNK).toString("base64") }, { timeoutMs: 30_000 }); })().then(() => cb(), e => cb(e));
  }
  _final(/** @type {(e?: Error | null) => void} */ cb) { this.link.call("wink.egress.end", { id: this.id }).then(() => cb(), () => cb()); }
  _destroy(/** @type {Error | null} */ e, /** @type {(e?: Error | null) => void} */ cb) { this.done = true; this.link.call("wink.egress.close", { id: this.id }, { timeoutMs: 5000 }).catch(() => {}); cb(e); }
}

/**
 * @param {{
 *   linkTo: (device: string) => { call: (tool: string, input?: any, opt?: any) => Promise<any> },   the held connections (core/wink/storage/hold.js createHolds().linkTo)
 *   has?: (device: string) => boolean,                          is the device connected right now (holds.has)
 *   device: () => string | null,                                the Mac chosen for egress (config glass.egress.device), or null
 *   enabled: () => boolean,                                     config glass.egress.enabled
 *   cacheMs?: number, pollMs?: number, now?: () => number, log?: (m: string) => void,
 * }} o
 */
export function createEgressHome(o) {
  const log = o.log || (() => {});
  const now = o.now || Date.now, cacheMs = o.cacheMs ?? 2000, pollMs = o.pollMs ?? 20_000;
  /** @type {{ at: number, v: { allowed: boolean, reason: string, sites?: number, tunnels?: number } } | null} */ let cached = null;
  let lastLogged = "";
  let open = 0;

  /** Whether a listed site may leave right now, and why not. Kept for 2 s so a page's burst of connections asks once. Any doubt is a no. */
  async function verdict() {
    if (cached && now() - cached.at < cacheMs) return cached.v;
    /** @type {{ allowed: boolean, reason: string, sites?: number, tunnels?: number }} */ let v;
    const d = o.device();
    if (!o.enabled()) v = { allowed: false, reason: "Mac egress is off" };
    else if (!d) v = { allowed: false, reason: "no Mac is chosen for egress yet" };
    else if (o.has && !o.has(d)) v = { allowed: false, reason: "your Mac is not connected to this server right now" };
    else {
      try {
        const s = await o.linkTo(d).call("wink.egress.status", {}, { timeoutMs: 4000 });
        v = s && s.ok === true ? (s.sites > 0 ? { allowed: true, reason: "your Mac is connected and sending its listed sites", sites: s.sites, tunnels: s.tunnels } : { allowed: false, reason: "your Mac is connected but its own list names no sites" }) : { allowed: false, reason: "your Mac did not answer as an egress" };
      } catch (e) { v = { allowed: false, reason: `your Mac did not answer (${String((/** @type {any} */ (e)).code || "failed")})` }; }
    }
    cached = { at: now(), v };
    const key = v.allowed ? "allowed" : v.reason;
    if (key !== lastLogged) { log(v.allowed ? "wink egress: allowing: your Mac is connected" : `wink egress: refusing every listed site: ${v.reason}`); lastLogged = key; }
    return v;
  }

  return {
    verdict,
    /** A tunnel through the Mac to host:port. Throws {code} the gate turns into a SOCKS reply. @param {string} host @param {number} port @returns {Promise<Duplex>} */
    async open(host, port) {
      const v = await verdict();
      if (!v.allowed) throw err("denied", v.reason);
      const link = o.linkTo(/** @type {string} */ (o.device()));
      const r = await link.call("wink.egress.open", { host, port }, { timeoutMs: 20_000 });
      if (!r || !r.id) throw err("unreachable", "your Mac did not open the tunnel");
      open++;
      const t = new Tunnel(link, String(r.id), pollMs);
      t.once("close", () => { open--; });
      return t;
    },
    async status() { const v = await verdict(); return { enabled: o.enabled(), device: o.device() || null, allowed: v.allowed, reason: v.reason, tunnels: open }; },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the SOCKS5 gate the computers' proxy script points at
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------

const METHOD_OK = Buffer.from([5, 0]);
const METHOD_NONE = Buffer.from([5, 0xff]);
const reply = (/** @type {number} */ rep) => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
export const REP = Object.freeze({ OK: 0, FAILURE: 1, NOT_ALLOWED: 2, UNREACHABLE: 4, REFUSED: 5, BAD_COMMAND: 7, BAD_ADDRESS: 8 });

/** The request at the head of buf: its length (0: more bytes needed, -1: not an address type we serve). @param {Buffer} buf */
function requestLength(buf) {
  if (buf.length < 5) return 0;
  const atyp = buf[3];
  const len = atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 4 + 1 + buf[4] + 2 : -1;
  if (len < 0) return -1;
  return buf.length >= len ? len : 0;
}
/** @param {Buffer} req @returns {{ host: string, port: number }} */
function target(req) {
  const atyp = req[3];
  if (atyp === 1) return { host: [...req.subarray(4, 8)].join("."), port: req.readUInt16BE(8) };
  if (atyp === 4) { const g = []; for (let i = 0; i < 8; i++) g.push(req.readUInt16BE(4 + i * 2).toString(16)); return { host: g.join(":"), port: req.readUInt16BE(20) }; }
  const n = req[4];
  return { host: req.subarray(5, 5 + n).toString("latin1"), port: req.readUInt16BE(5 + n) };
}

/**
 * @param {{ home: { verdict: () => Promise<any>, open: (host: string, port: number) => Promise<Duplex> }, host?: string, port?: number, handshakeMs?: number, maxClients?: number, log?: (m: string) => void }} o
 *   port 0 binds an ephemeral port.
 */
export function createSocksGate(o) {
  const handshakeMs = o.handshakeMs ?? 10_000, maxClients = o.maxClients ?? 256;
  /** @type {Set<net.Socket>} */ const sockets = new Set();
  const server = net.createServer(client => {
    if (sockets.size >= maxClients) { client.destroy(); return; }
    sockets.add(client); client.once("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(handshakeMs, () => client.destroy());
    let buf = Buffer.alloc(0), greeted = false, done = false;
    const fail = (/** @type {number} */ rep) => { done = true; client.resume(); client.end(reply(rep)); };
    const onData = (/** @type {Buffer} */ chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) { done = true; client.destroy(); return; }
      if (!greeted) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) { done = true; client.destroy(); return; }
        const n = 2 + buf[1];
        if (buf.length < n) return;
        const methods = buf.subarray(2, n); buf = buf.subarray(n); greeted = true;
        if (!methods.includes(0)) { done = true; client.resume(); client.end(METHOD_NONE); return; }
        client.write(METHOD_OK);
      }
      const len = requestLength(buf);
      if (len === 0) return;
      if (len < 0 || buf[0] !== 5) return fail(REP.BAD_ADDRESS);
      if (buf[1] !== 1) return fail(REP.BAD_COMMAND);
      done = true; client.off("data", onData); client.pause();
      const t = target(buf.subarray(0, len)), rest = Buffer.from(buf.subarray(len));
      (async () => {
        const v = await o.home.verdict();
        if (client.destroyed) return;
        if (!v.allowed) return fail(REP.NOT_ALLOWED);
        let tun;
        try { tun = await o.home.open(t.host, t.port); }
        catch (e) { const c = /** @type {any} */ (e).code; return fail(c === "denied" ? REP.NOT_ALLOWED : c === "refused" ? REP.REFUSED : c === "unreachable" || c === "timeout" ? REP.UNREACHABLE : REP.FAILURE); }
        if (client.destroyed) { tun.destroy(); return; }
        client.setTimeout(0);
        client.write(reply(REP.OK));
        if (rest.length) tun.write(rest);
        tun.on("error", () => client.destroy()); client.on("close", () => tun.destroy()); tun.on("close", () => client.destroy());
        client.pipe(tun); tun.pipe(client);
        client.resume();
      })().catch(() => { try { client.destroy(); } catch { /* gone */ } });
    };
    client.on("data", onData);
  });
  return {
    /** @returns {Promise<{ port: number }>} */
    async listen() { await new Promise((res, rej) => { server.once("error", rej); server.listen(o.port ?? 1055, o.host || "0.0.0.0", () => res(undefined)); }); return { port: /** @type {any} */ (server.address()).port }; },
    async close() { for (const s of sockets) s.destroy(); await new Promise(r => (server.listening ? server.close(() => r(undefined)) : r(undefined))); },
  };
}

// ------------------------------------------------------------------------------------------------------------------------------------------------------------------
// the Mac's side, started: the connection it holds to its home, answering the tunnel calls
// ------------------------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Hold a connection to the home and answer its egress calls (and, through `otherServe`, whatever else this device already answers on the same connection, such as a drive's frames:
 * a held session has one `serve`). `connect` is the node host's (`host.connect(space, { serve })`). Nothing is dialed until the home asks, and only for a host `sites()` names.
 * @param {{ connect: (space: string, o: { serve: (tool: string, input: any) => Promise<any> }) => any, space: string, sites: () => string[], otherServe?: (tool: string, input: any) => Promise<any>,
 *   agent?: Parameters<typeof createEgressAgent>[0], log?: (m: string) => void }} o
 */
export function startEgressAgent(o) {
  const agent = createEgressAgent({ sites: o.sites, ...(o.log ? { log: o.log } : {}), ...(o.agent || {}) });
  const serve = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (EGRESS_TOOLS.includes(tool)) return agent.serve(tool, input);
    if (o.otherServe) return o.otherServe(tool, input);
    throw err("denied", "this connection answers only the egress calls");
  };
  const hold = holdDrive({ connect: o.connect, serve, space: o.space, ...(o.log ? { log: o.log } : {}) });
  return { status: () => ({ ...hold.status(), tunnels: agent.tunnels() }), ready: (/** @type {number} */ ms) => hold.ready(ms), serve, stop() { hold.stop(); agent.close(); } };
}
