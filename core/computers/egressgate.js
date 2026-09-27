// @ts-check
// egressgate: the door in front of the egress sidecar, so a listed site never leaves from the box.
//
// The sidecar (box/compose.egress.yml, service egress-node) is a userspace tailscaled using the
// user's Mac as its exit node, with a SOCKS5 server. When the Mac is off the tailnet, a
// connection through it fails, which is what we want. But when the Mac stops offering itself as
// an exit node, or its route is not approved, tailscaled has no exit route and dials the site
// directly from the box: the site sees the datacenter's address after all. This gate closes
// that hole. It runs in the vyre image (`node core/computers/egressgate.js`), answers as
// `egress:1055` on the computers network, and for every SOCKS5 CONNECT asks the sidecar's
// tailscaled, over its LocalAPI socket, whether the exit node is in use right now:
//
//   - yes: the connection is relayed byte for byte to the sidecar's own SOCKS5 server (the
//     greeting and the request are replayed to it, then both directions are piped);
//   - no, or any doubt: the client gets "connection not allowed by ruleset" (REP 0x02) and the
//     connection closes. The gate never dials a site itself.
//
// The verdict is kept for at most 2 s, so a page's burst of connections reads the status once.
// There is no timer while idle: status is read on demand only. A refusal is logged once each
// time the reason changes, not once per connection, so the owner can see why a listed site
// fails without the log filling up.
//
// A tiny HTTP server on a second port answers GET /status with the same verdict, for
// computers.egress.status. It says why, never which Mac or which address.
//
// Only node built-ins. Every port and path comes from the env, with the defaults the compose
// file uses, so tests bind ephemeral ports and a fake LocalAPI socket.

import net from "node:net";
import http from "node:http";
import { pathToFileURL } from "node:url";

/** The defaults, as box/compose.egress.yml runs it. */
export const DEFAULTS = Object.freeze({
  host: "0.0.0.0",
  port: 1055,
  statusPort: 1057,
  upstream: "egress-node:1056",
  socket: "/var/run/egress-node/tailscaled.sock",
  cacheMs: 2000,
});

/** How long a LocalAPI status read may take before it counts as a refusal. */
const STATUS_TIMEOUT = 2000;
/** A status body larger than this is not one we trust (a big tailnet is well under it). */
const STATUS_MAX = 8 * 1024 * 1024;
/** How long a client may take to finish the SOCKS5 greeting and request. */
const HANDSHAKE_TIMEOUT = 10_000;

/**
 * @typedef {{ allowed: boolean, reason: string }} Verdict
 */

/**
 * Whether a tailscaled status says the exit node is in use right now. Pure. Every field is
 * checked for its exact value, so a missing or odd field is a refusal, never a pass.
 * @param {any} st the JSON of GET /localapi/v0/status
 * @returns {Verdict}
 */
export function verdict(st) {
  if (!st || typeof st !== "object" || Array.isArray(st)) return { allowed: false, reason: "tailscaled's status is not an object" };
  if (st.BackendState !== "Running") return { allowed: false, reason: `tailscaled is not running (BackendState ${JSON.stringify(String(st.BackendState ?? "missing")).slice(0, 40)})` };
  const peers = st.Peer && typeof st.Peer === "object" ? Object.values(st.Peer) : [];
  const exits = peers.filter(p => p && typeof p === "object" && p.ExitNode === true);
  if (exits.length !== 1) return { allowed: false, reason: exits.length ? "more than one peer is marked as the exit node" : "no peer is in use as the exit node (is the exit node name right?)" };
  const exit = exits[0];
  if (exit.Online !== true) return { allowed: false, reason: "the exit node is offline" };
  if (exit.ExitNodeOption !== true) return { allowed: false, reason: "the exit node is not offering itself, or its route is not approved (ExitNodeOption is false)" };
  if ("ExitNodeStatus" in st) {
    const s = st.ExitNodeStatus;
    if (!s || typeof s !== "object" || s.Online !== true) return { allowed: false, reason: "tailscaled reports the exit node as not online (ExitNodeStatus)" };
  }
  return { allowed: true, reason: "the exit node is online and offering itself" };
}

/**
 * GET /localapi/v0/status over tailscaled's unix socket.
 * @param {string} socketPath
 * @returns {Promise<any>}
 */
export function readStatus(socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: "/localapi/v0/status", method: "GET", headers: { host: "local-tailscaled.sock" }, timeout: STATUS_TIMEOUT }, res => {
      /** @type {Buffer[]} */
      const parts = [];
      let size = 0;
      res.on("data", c => {
        size += c.length;
        if (size > STATUS_MAX) { req.destroy(new Error("the status is too large")); return; }
        parts.push(c);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error(`LocalAPI answered ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8"))); }
        catch { reject(new Error("the status is not JSON")); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`no status within ${STATUS_TIMEOUT} ms`)));
    req.on("error", reject);
    req.end();
  });
}

/** SOCKS5 replies the gate sends itself: the method choice, and a CONNECT failure. */
const METHOD_OK = Buffer.from([5, 0]);
const METHOD_NONE = Buffer.from([5, 0xff]);
/** @param {number} rep */
const reply = rep => Buffer.from([5, rep, 0, 1, 0, 0, 0, 0, 0, 0]);
export const REP = Object.freeze({ FAILURE: 1, NOT_ALLOWED: 2, BAD_COMMAND: 7, BAD_ADDRESS: 8 });

/**
 * How many bytes the request at the head of buf takes, 0 if more are needed, or -1 for an
 * address type that is not IPv4, a domain or IPv6.
 * @param {Buffer} buf
 */
function requestLength(buf) {
  if (buf.length < 5) return 0;
  const atyp = buf[3];
  const len = atyp === 1 ? 4 + 4 + 2 : atyp === 4 ? 4 + 16 + 2 : atyp === 3 ? 4 + 1 + buf[4] + 2 : -1;
  if (len < 0) return -1;
  return buf.length >= len ? len : 0;
}

/**
 * @param {string} hostport
 * @returns {{ host: string, port: number }}
 */
function split(hostport) {
  const i = hostport.lastIndexOf(":");
  const port = Number(hostport.slice(i + 1));
  if (i < 1 || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${hostport}" is not a host:port`);
  return { host: hostport.slice(0, i).replace(/^\[|\]$/g, ""), port };
}

/**
 * The gate. Nothing runs until listen(); close() leaves nothing behind.
 * @param {{ host?: string, port?: number, statusPort?: number, upstream?: string, socket?: string,
 *   cacheMs?: number, now?: () => number, log?: (m: string) => void }} [opts]
 *   port or statusPort 0 binds an ephemeral port; statusPort -1 turns the status server off.
 */
export function createGate(opts = {}) {
  const o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  const up = split(String(o.upstream));
  const now = opts.now || Date.now;
  const log = opts.log || (m => process.stderr.write(`egressgate: ${m}\n`));

  /** @type {{ at: number, v: Verdict } | null} */
  let cached = null;
  /** @type {Promise<Verdict> | null} */
  let reading = null;
  /** The last state logged, so each change is logged once. */
  let lastLogged = "";
  let reads = 0;

  /** The verdict, read from tailscaled at most once per cacheMs; concurrent callers share a read. */
  function check() {
    if (cached && now() - cached.at < o.cacheMs) return Promise.resolve(cached.v);
    if (reading) return reading;
    reads++;
    reading = readStatus(String(o.socket))
      .then(verdict, e => ({ allowed: false, reason: `cannot read tailscaled's status: ${/** @type {any} */ (e).code || /** @type {Error} */ (e).message}` }))
      .then(v => {
        cached = { at: now(), v };
        reading = null;
        const key = v.allowed ? "allowed" : v.reason;
        if (key !== lastLogged) {
          log(v.allowed ? "allowing: the exit node is in use again" : `refusing every listed site: ${v.reason}`);
          lastLogged = key;
        }
        return v;
      });
    return reading;
  }

  /** @type {Set<net.Socket>} */
  const open = new Set();
  const track = s => { open.add(s); s.once("close", () => open.delete(s)); return s; };

  /** @param {net.Socket} client */
  function serve(client) {
    track(client);
    client.on("error", () => client.destroy());
    client.setTimeout(HANDSHAKE_TIMEOUT, () => client.destroy());
    let buf = Buffer.alloc(0);
    /** @type {Buffer | null} */
    let greeting = null;
    let done = false;
    // A refusal drains whatever else the client sends, so the reply is not lost to a reset.
    const fail = rep => { done = true; client.resume(); client.end(reply(rep)); };

    const onData = chunk => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 600) { done = true; client.destroy(); return; }
      if (!greeting) {
        if (buf.length < 2) return;
        if (buf[0] !== 5) { done = true; client.destroy(); return; }
        const n = 2 + buf[1];
        if (buf.length < n) return;
        const methods = buf.subarray(2, n);
        greeting = Buffer.from(buf.subarray(0, n));
        buf = buf.subarray(n);
        if (!methods.includes(0)) { done = true; client.resume(); client.end(METHOD_NONE); return; }
        client.write(METHOD_OK);
      }
      const len = requestLength(buf);
      if (len === 0) return;
      if (len < 0 || buf[0] !== 5) return fail(REP.BAD_ADDRESS);
      if (buf[1] !== 1) return fail(REP.BAD_COMMAND);
      done = true;
      client.off("data", onData);
      client.pause();
      const request = Buffer.from(buf.subarray(0, len));
      const rest = Buffer.from(buf.subarray(len));
      check().then(v => {
        if (client.destroyed) return;
        if (!v.allowed) return fail(REP.NOT_ALLOWED);
        relay(client, request, rest, fail);
      });
    };
    client.on("data", onData);
  }

  /**
   * Hand the connection to the sidecar: our own no-auth greeting, its method reply swallowed
   * (the client already has ours), then the client's request verbatim and a pipe both ways.
   * @param {net.Socket} client @param {Buffer} request @param {Buffer} rest
   * @param {(rep: number) => void} fail
   */
  function relay(client, request, rest, fail) {
    const side = track(net.connect(up));
    let stage = 0;
    let got = Buffer.alloc(0);
    const bail = () => { if (stage < 2 && !client.destroyed) fail(REP.FAILURE); else client.destroy(); side.destroy(); };
    side.on("error", bail);
    side.once("connect", () => side.write(Buffer.from([5, 1, 0])));
    const onSide = chunk => {
      got = Buffer.concat([got, chunk]);
      if (got.length < 2) return;
      if (got[0] !== 5 || got[1] !== 0) return bail();
      stage = 2;
      side.off("data", onSide);
      side.pause();
      const extra = got.subarray(2);
      side.write(request);
      if (rest.length) side.write(rest);
      if (extra.length) client.write(extra);
      client.setTimeout(0);
      client.on("close", () => side.destroy());
      side.on("close", () => client.destroy());
      client.pipe(side);
      side.pipe(client);
      client.resume();
    };
    side.on("data", onSide);
  }

  const socks = net.createServer(serve);
  const status = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/status") { res.writeHead(404, { connection: "close" }).end(); return; }
    check().then(v => {
      // No keep-alive: an idle kept-alive socket would hold a timer.
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(v));
    });
  });
  status.on("connection", s => track(s));

  return {
    check,
    /** How many times the status was read from tailscaled (tests). */
    get reads() { return reads; },
    /** @returns {Promise<{ port: number, statusPort: number | null }>} */
    async listen() {
      await new Promise((res, rej) => { socks.once("error", rej); socks.listen(o.port, o.host, () => res(undefined)); });
      let statusPort = null;
      if (Number(o.statusPort) >= 0) {
        await new Promise((res, rej) => { status.once("error", rej); status.listen(o.statusPort, o.host, () => res(undefined)); });
        statusPort = /** @type {any} */ (status.address()).port;
      }
      return { port: /** @type {any} */ (socks.address()).port, statusPort };
    },
    /** Stop listening and drop every open connection. */
    async close() {
      for (const s of open) s.destroy();
      await Promise.all([socks, status].map(srv => new Promise(r => (srv.listening ? srv.close(() => r(undefined)) : r(undefined)))));
    },
  };
}

/** The gate as the compose file runs it, from the env. */
export function fromEnv(env = process.env) {
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  return createGate({
    host: env.VYRE_EGRESS_GATE_HOST || DEFAULTS.host,
    port: num(env.VYRE_EGRESS_GATE_PORT, DEFAULTS.port),
    statusPort: num(env.VYRE_EGRESS_GATE_STATUS_PORT, DEFAULTS.statusPort),
    upstream: env.VYRE_EGRESS_UPSTREAM || DEFAULTS.upstream,
    socket: env.VYRE_EGRESS_SOCKET || DEFAULTS.socket,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gate = fromEnv();
  const a = await gate.listen();
  process.stderr.write(`egressgate: SOCKS5 on ${a.port}, status on ${a.statusPort ?? "off"}; status is read on demand only\n`);
  for (const sig of ["SIGTERM", "SIGINT"]) process.once(sig, () => gate.close().then(() => process.exit(0)));
}
