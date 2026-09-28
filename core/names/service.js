// @ts-check
// The names service: `<you>.vyre.run`, its certificate, and the tailnet listener (ADR 0002).
//
// Everything that touches the outside world comes in as an adapter (tailscale, Cloudflare, ACME,
// the certificate store), so the whole claim flow runs in tests against fakes. index.js wires
// the real ones.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { identifier } from "./identity.js";
import { hostedOrigins } from "../config/index.js";

const NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$/;
const RESERVED = new Set(["www", "api", "app", "admin", "mail", "docs", "status", "blog", "help", "support", "deck", "vyre",
  "root", "ns1", "ns2", "dev", "staging", "test", "download", "install", "login", "auth", "directory"]);
const HSTS = "max-age=31536000";

export { HOSTED_ORIGINS } from "../config/index.js";
/** What the hosted app may send. Anything else fails its preflight. */
const CORS_METHODS = "GET, POST";
const CORS_HEADERS = "content-type, authorization, x-vyre-proof, x-vyre-presence, idempotency-key, last-event-id";
const DAY = 86_400_000;

/** Is this a name someone can have? Pure, so the Deck's check and the claim agree. */
export function checkName(name) {
  const n = String(name || "").trim().toLowerCase();
  if (!NAME.test(n)) return { name: n, valid: false, why: "2 to 32 letters, digits or dashes, starting with a letter" };
  if (n.includes("--")) return { name: n, valid: false, why: "no double dashes" };
  if (RESERVED.has(n)) return { name: n, valid: false, why: "that name is reserved" };
  return { name: n, valid: true, why: null };
}

const sha = s => crypto.createHash("sha256").update(s).digest("hex");

/**
 * @param {{ ctx: any, save: (patch: any) => void,
 *   ts: { status(): Promise<any>, whois(ip: string): Promise<any>, up(o?: any): Promise<any>, cert(d: string, c: string, k: string): Promise<void>, operator(u: string): Promise<any>, installCommand(): string },
 *   dns: (zone: string) => Promise<{ available(f: string, ip: string): Promise<any>, upsertA(f: string, ip: string): Promise<any>, find(f: string, t?: string): Promise<any[]>, remove(id: string): Promise<void>, set(f: string, v: string): Promise<any>, clear(h: any): Promise<void> }>,
 *   issue: (o: { names: string[], dns: any }) => Promise<{ cert: string, key: string, expires: number }>,
 *   certs: { load(dir: string, name: string): any, save(dir: string, name: string, c: any): void },
 *   agentOf?: (stableId: string) => Promise<string|null>,
 *   listen?: (server: import("node:https").Server, where: { fd?: number, host?: string, port?: number }) => Promise<void>,
 *   now?: () => number }} deps
 */
export function names(deps) {
  const { ctx, ts } = deps;
  const now = deps.now || Date.now;
  const net = () => ctx.config.network || {};
  const domain = () => net().domain || "vyre.run";
  const port = () => Number(net().port ?? 443);
  /** @type {{ phase: "idle"|"dns"|"certificate"|"serving"|"failed", why: string|null, certificate: any }} */
  const state = { phase: "idle", why: null, certificate: null };
  /** @type {https.Server[]} */
  let servers = [];
  /** @type {string[]} */
  let selfIps = [];
  let working = null;
  let last = null;
  /** @type {Map<string, number>} claim code hash -> expiry */
  const codes = new Map();

  let selfId = null;
  // Which agent a tagged node is: the computers module knows (computers.node.agent). Until that
  // tool exists, or when it says nobody, the node is refused as any tagged node is.
  const agentOf = deps.agentOf || (async stableId => {
    const r = await ctx.call("computers.node.agent", { stableId });
    return r && !r.error && r.data && typeof r.data.agent === "string" ? r.data.agent : null;
  });
  const agentNodes = () => (ctx.config.computers && ctx.config.computers.tailnet) || null;
  // Which paired desktop a tag:vyre-device node was bound to (ADR 0046): the relay knows.
  const deviceOf = deps.deviceOf || (async stableId => {
    const r = await ctx.call("relay.devices.tailnet", { stableId });
    return r && !r.error && r.data && typeof r.data.device === "string" ? r.data.device : null;
  });
  const identify = identifier({ whois: ip => ts.whois(ip), selfIps: () => selfIps, selfId: () => selfId, owner: () => net().owner || null,
    network: net, agentNodes, agentOf, deviceOf });

  async function tailscale() {
    const s = await ts.status();
    if (s.node) { selfIps = s.node.ips; selfId = s.node.stableId || null; }
    // The login that owns this node is the box's owner, unless one was already set or claimed.
    if (s.running && s.owner && !net().owner) setOwner(s.owner);
    last = s;
    return s;
  }

  function setOwner(login) {
    deps.save({ network: { owner: login, ownerSeen: null } });
    ctx.events.emit("owner.changed", { owner: login });
  }

  const certName = () => net().via === "ts.net" ? (last && last.node ? last.node.dnsName : null) : ctx.config.name ? `${ctx.config.name}.${domain()}` : null;
  // The port actually bound, so a test's port 0 or a Mac's high port shows up in the address.
  const bound = () => { const a = servers[0] && servers[0].address(); return a && typeof a === "object" ? a.port : port(); };
  const address = host => `https://${host}${bound() === 443 ? "" : ":" + bound()}`;

  function status() {
    return {
      name: ctx.config.name || null,
      address: net().address || null,
      via: net().via || null,
      owner: net().owner || null,
      phase: servers.length && state.phase === "idle" ? "serving" : state.phase,
      why: state.why,
      certificate: state.certificate,
      listening: servers.length > 0,
    };
  }

  async function check(raw) {
    const c = checkName(raw);
    const out = { name: c.name, valid: c.valid, available: false, why: c.why, address: c.valid ? address(`${c.name}.${domain()}`) : null };
    if (!c.valid) return out;
    const s = await tailscale();
    const ip = s.node && s.node.ips.find(a => a.includes("."));
    try {
      const a = await (await deps.dns(domain())).available(`${c.name}.${domain()}`, ip || "0.0.0.0");
      return { ...out, available: a.available, why: a.available ? null : "someone else has that name" };
    } catch (e) {
      return { ...out, why: "could not check: " + /** @type {Error} */ (e).message };
    }
  }

  const fail = e => { state.phase = "failed"; state.why = /** @type {Error} */ (e).message; ctx.log("names: " + state.why); };

  /** Reserve the name, point it at this box, get its certificate, start serving. In the background. */
  function claim(raw) {
    const c = checkName(raw || ctx.config.name);
    if (!c.valid) throw new Error(c.why || "no name");
    if (working) return status();
    state.phase = "dns"; state.why = null;
    working = (async () => {
      const s = await tailscale();
      const ip = s.node && s.node.ips.find(a => a.includes("."));
      if (!ip) throw new Error("this machine is not on a tailnet yet");
      if (!s.tun) throw new Error("Tailscale is in userspace networking mode, so there is no tailnet address to serve on");
      const fqdn = `${c.name}.${domain()}`;
      const dns = await deps.dns(domain());
      const a = await dns.available(fqdn, ip);
      if (!a.available) throw new Error("someone else has that name");
      await dns.upsertA(fqdn, ip);
      deps.save({ name: c.name, network: { via: "vyre.run" } });
      ctx.events.emit("name.claimed", { name: fqdn });
      state.phase = "certificate";
      const got = await deps.issue({ names: [fqdn], dns });
      deps.certs.save(ctx.paths.certs, fqdn, got);
      ctx.events.emit("certificate.issued", { name: fqdn, expires: got.expires });
      await serve();
      deps.save({ network: { address: address(fqdn) } });
      state.phase = "serving";
    })().catch(fail).finally(() => { working = null; });
    return status();
  }

  /** The tailnet's own name, with `tailscale cert`, when there is no vyre.run name. */
  function fallback() {
    if (working) return status();
    state.phase = "certificate"; state.why = null;
    working = (async () => {
      const s = await tailscale();
      if (!s.node) throw new Error("this machine is not on a tailnet yet");
      const host = s.node.dnsName;
      if (!s.certDomains.includes(host)) throw new Error("HTTPS certificates are off for this tailnet. Turn them on at https://login.tailscale.com/admin/dns");
      fs.mkdirSync(ctx.paths.certs, { recursive: true, mode: 0o700 });
      const crt = path.join(ctx.paths.certs, `${host}.crt`), key = path.join(ctx.paths.certs, `${host}.key`);
      await ts.cert(host, crt, key);
      fs.chmodSync(key, 0o600);
      deps.save({ network: { via: "ts.net" } });
      ctx.events.emit("certificate.issued", { name: host, expires: (deps.certs.load(ctx.paths.certs, host) || {}).expires || null });
      await serve();
      deps.save({ network: { address: address(host) } });
      state.phase = "serving";
    })().catch(fail).finally(() => { working = null; });
    return status();
  }

  async function release() {
    const name = ctx.config.name;
    if (name && net().via === "vyre.run") {
      const dns = await deps.dns(domain());
      for (const r of await dns.find(`${name}.${domain()}`, "A")) await dns.remove(r.id);
      ctx.events.emit("name.released", { name: `${name}.${domain()}` });
    }
    await close();
    deps.save({ network: { address: null, via: null } });
    state.phase = "idle";
    return status();
  }

  /** A one-time code for a tagged box: the first tailnet login to open the link becomes the owner. */
  function claimCode() {
    const code = crypto.randomBytes(18).toString("base64url");
    codes.set(sha(code), now() + 3_600_000);
    return { code, path: `/onboard/claim?c=${code}` };
  }

  // ---- the tailnet listener ----

  let handle = null;
  /** Who a peer is to vyred's router. A guest and an agent's node never get the owner's caller. */
  const callerOf = who => who.kind === "guest" ? `tailnet-guest:${who.login}` : who.kind === "agent" ? `tailnet:agent:${who.agent}`
    : who.kind === "device" ? `device:${who.device}` : `tailnet:${who.login}`;
  /** The peer beside the caller. A bound desktop reads as it does over the relay (stableId is its device id), plus the transport. */
  const peerOf = who => who.kind === "device"
    ? { node: who.node, stableId: who.device, nodeId: who.stableId || null, login: null, tags: who.tags || [], caps: {}, kind: "device", via: "tailnet" }
    : { node: who.node, stableId: who.stableId || null, login: who.login, tags: who.tags || [], caps: who.caps || {}, kind: who.kind, ...(who.kind === "agent" ? { agent: who.agent } : {}) };

  /**
   * GET /v1/whoami: the join flow's reachability probe. A device adding itself as a second
   * device, or a laptop moving to a server, hits this once it thinks Tailscale (or the relay) has
   * it on the tailnet, to learn whether IT ALSO sees itself reaching the box, and as whom. Never
   * for an agent's node (a computer has no join flow of its own) and rate-limited per node, since
   * it needs no proof beyond whois and must not become a way to probe the box from a captured
   * tailnet login. The answer stays minimal: kind, and the box's own name only for the owner —
   * never a login, tag or capability, which callerOf/peer already carry to the router for tools
   * that want them.
   */
  const whoamiHits = new Map(); // node or stableId -> recent call times, this minute
  function whoamiAllowed(who) {
    const key = who.stableId || who.node || who.login || "?";
    const cut = now() - 60_000;
    const hits = (whoamiHits.get(key) || []).filter(t => t > cut);
    hits.push(now());
    whoamiHits.set(key, hits);
    if (whoamiHits.size > 1000) whoamiHits.delete(/** @type {string} */ (whoamiHits.keys().next().value));
    return hits.length <= 10;
  }
  function whoami(res, who) {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (who.kind === "agent") return json(403, { error: { code: "denied", message: "not for an agent node" } });
    if (!whoamiAllowed(who)) return json(429, { error: { code: "rate_limited", message: "slow down and try again" } });
    return json(200, { data: { kind: who.kind, name: who.kind === "owner" ? (ctx.config.name || null) : null } });
  }
  async function onRequest(req, res) {
    res.setHeader("strict-transport-security", HSTS);
    const url = new URL(req.url || "/", "https://vyred");
    const who = await identify(String(req.socket.remoteAddress || ""));
    if (!who.ok && who.bindable && req.method === "POST" && url.pathname === "/v1/tailnet/bind") return bindNode(req, res, who);
    if (!who.ok) {
      if (!net().owner && who.login && req.method === "GET" && url.pathname === "/onboard/claim") {
        const h = sha(url.searchParams.get("c") || "");
        const exp = codes.get(h);
        if (exp && exp > now()) {
          codes.delete(h);
          setOwner(who.login);
          res.writeHead(302, { location: "/onboard" });
          return res.end();
        }
      }
      ctx.log(`names: refused ${who.node || "an address"}: ${who.why}`);
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "not_owner", message: "This Vyre serves only its owner." } }));
    }
    // The owner's browser also visits other sites. A cross-site page can send a "simple" POST
    // (form or text/plain, no preflight) that the browser attaches nothing to but still delivers,
    // and the source address would be the owner's. So a POST must be JSON (which forces a CORS
    // preflight we never answer), and a browser's Origin must be this box's own address.
    const host = String(req.headers.host || "").toLowerCase();
    const mine = [certName(), ...selfIps].filter(Boolean).map(h => String(h).toLowerCase());
    if (!mine.some(h => host === h || host === `${h}:${bound()}` || host === `[${h}]:${bound()}`)) {
      res.writeHead(421, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { code: "misdirected", message: "not this box's address" } }));
    }
    if (req.method === "GET" && url.pathname === "/v1/whoami") return whoami(res, who);
    // Vyre's hosted app (app.vyre.run) is another site that may call in, with CORS, from the
    // owner's own browser. Whois must still say owner, and vyred's router wants a person session
    // for every call from it (core/presence/person.js).
    const origin = String(req.headers.origin || "").toLowerCase();
    if (origin && origin !== `https://${host}` && hosted(origin)) return crossOrigin(req, res, url, who, origin);
    if (req.method !== "GET" && req.method !== "HEAD") {
      const json = /^application\/json\b/.test(String(req.headers["content-type"] || ""));
      if (!json || (origin && origin !== `https://${host}`)) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "denied", message: "cross-site request" } }));
      }
    }
    if (who.kind === "owner" && !net().ownerSeen) {
      deps.save({ network: { ownerSeen: new Date(now()).toISOString() } });
      ctx.events.emit("owner.seen", {});
    }
    if (!handle) handle = ctx.handler({});
    // The peer rides beside the caller, for tools that bind to a device (link.pair); never in input or events.
    // A guest and an agent's node each get a caller class of their own, never the owner's; the
    // router limits a guest to its tools and wants an agent's key beside `tailnet:agent:<name>`.
    return handle(req, res, callerOf(who), peerOf(who));
  }

  /**
   * A new tag:vyre-device node presents the bind code its paired desktop got inside its own Noise
   * channel with the key (ADR 0046 section 3, step 4). The node id is whois's, never the body's.
   */
  async function bindNode(req, res, who) {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!/^application\/json\b/.test(String(req.headers["content-type"] || ""))) return json(403, { error: { code: "denied", message: "cross-site request" } });
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 2048) return json(413, { error: { code: "bad_input", message: "too large" } }); }
    let body = null;
    try { body = JSON.parse(raw); } catch {}
    if (!body || typeof body.device !== "string" || typeof body.code !== "string") return json(400, { error: { code: "bad_input", message: "a bind needs the device id and its bind code" } });
    const r = await ctx.call("relay.devices.bind", { stableId: String(who.stableId), node: String(who.node || ""), device: body.device, code: body.code });
    if (r.error) { ctx.log(`names: refused a bind from ${who.node || "a node"}: ${r.error.message}`); return json(403, { error: { code: "denied", message: r.error.message } }); }
    return json(200, { data: r.data });
  }

  /** Is this origin one of the hosted app's (network.origins, default HOSTED_ORIGINS)? */
  const hosted = origin => hostedOrigins(net()).includes(origin);

  /**
   * A request from the hosted app's origin. Only the owner gets CORS headers at all; a guest or an
   * agent's node gets the same 403 as any other site. The preflight carries no credentials and is
   * answered here. GET /v1/health answers only that the box is reachable (the app's probe for the
   * tailnet path), without asking vyred. Everything else goes to the router untouched (the body
   * unread, since the session's proof signs its hash), with the origin beside the caller, never in
   * the input; the router refuses it without a person session.
   */
  async function crossOrigin(req, res, url, who, origin) {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (who.kind !== "owner") return json(403, { error: { code: "denied", message: "cross-site request" } });
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "Origin");
    if (req.method === "OPTIONS") {
      const method = String(req.headers["access-control-request-method"] || "").toUpperCase();
      const asked = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(h => h.trim()).filter(Boolean);
      const allowed = CORS_HEADERS.split(", ");
      if (!CORS_METHODS.split(", ").includes(method) || asked.some(h => !allowed.includes(h))) return json(403, { error: { code: "denied", message: "not an allowed method or header" } });
      const headers = { "access-control-allow-methods": CORS_METHODS, "access-control-allow-headers": CORS_HEADERS, "access-control-max-age": "600" };
      // Chrome's Private Network Access: a public page calling a 100.64/10 address asks first.
      if (String(req.headers["access-control-request-private-network"] || "") === "true") headers["access-control-allow-private-network"] = "true";
      res.writeHead(204, headers);
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/v1/health") return json(200, { data: { reachable: true } });
    if (req.method !== "GET" && req.method !== "HEAD" && !/^application\/json\b/.test(String(req.headers["content-type"] || ""))) return json(403, { error: { code: "denied", message: "cross-site request" } });
    if (!handle) handle = ctx.handler({});
    const peer = { node: who.node, stableId: who.stableId || null, login: who.login, tags: who.tags || [], caps: who.caps || {},
      kind: who.kind, origin };
    return handle(req, res, callerOf(who), peer);
  }

  // WebSockets (Glass's screen, /v1/streams/...): the same owner, host and origin rules as a
  // request, then vyred's stream router with the caller this listener established. Without an
  // upgrade listener Node passed each one to the request router, which answered 404, so Glass's
  // screen never connected over the tailnet.
  let upgrade = null;
  async function onUpgrade(req, socket, head) {
    const refuse = (status, text) => { try { socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\n\r\n`); } catch {} };
    socket.on("error", () => {});
    const who = await identify(String(req.socket.remoteAddress || ""));
    if (!who.ok) { ctx.log(`names: refused a stream from ${who.node || "an address"}: ${who.why}`); return refuse(403, "Forbidden"); }
    // A stream is the owner's alone (the terminal, Glass's screen): a guest and an agent's node
    // get none, whatever tools they hold, as a tool that reaches the terminal would refuse them.
    // A bound desktop (ADR 0046) is the owner's own device, as it already is through the relay.
    if (who.kind !== "owner" && who.kind !== "device") { ctx.log(`names: refused a stream from ${who.node || "a node"}: streams are the owner's (${who.kind})`); return refuse(403, "Forbidden"); }
    const host = String(req.headers.host || "").toLowerCase();
    const mine = [certName(), ...selfIps].filter(Boolean).map(h => String(h).toLowerCase());
    if (!mine.some(h => host === h || host === `${h}:${bound()}` || host === `[${h}]:${bound()}`)) return refuse(421, "Misdirected Request");
    // A browser sends Origin on every WebSocket, and a page on another site could open one with
    // the owner's address: only this box's own page may.
    // The hosted app's page may too: every stream opens with a ticket a tool minted, and minting
    // one already needed the person session.
    const origin = String(req.headers.origin || "").toLowerCase();
    if (origin && origin !== `https://${host}` && !hosted(origin)) return refuse(403, "Forbidden");
    if (!upgrade) upgrade = ctx.upgrader({});
    upgrade(req, socket, head, callerOf(who));
  }

  async function serve() {
    // A ts.net name comes from Tailscale, and a freshly started vyred has not asked yet.
    if (net().via === "ts.net" && !(last && last.node)) await tailscale();
    const name = certName();
    const c = name && deps.certs.load(ctx.paths.certs, name);
    if (!c) return false;
    state.certificate = { name, issuer: issuerOf(c.cert), expires: c.expires };
    if (servers.length) { for (const s of servers) s.setSecureContext({ cert: c.cert, key: c.key }); return true; }
    const make = () => {
      const s = https.createServer({ cert: c.cert, key: c.key, minVersion: "TLSv1.2" }, (req, res) => {
        onRequest(req, res).catch(e => { if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: { code: "internal", message: e.message } })); } });
      });
      s.on("upgrade", (req, socket, head) => { onUpgrade(req, socket, head).catch(() => socket.destroy()); });
      s.keepAliveTimeout = 30_000;
      return s;
    };
    const listen = deps.listen || defaultListen;
    // Know this box's own addresses before the first connection, on every path (fd 3 included).
    await tailscale();
    // Under systemd the socket unit hands over port 443 on the tailnet interface as fd 3.
    if (process.env.LISTEN_FDS && Number(process.env.LISTEN_PID) === process.pid) {
      const s = make(); await listen(s, { fd: 3 }); servers.push(s);
    } else {
      for (const host of selfIps) { const s = make(); await listen(s, { host, port: port() }); servers.push(s); }
    }
    ctx.log(`names: serving ${name} on ${servers.length} listener(s)`);
    return servers.length > 0;
  }

  async function close() {
    for (const s of servers) { s.closeAllConnections(); await new Promise(r => s.close(() => r(undefined))); }
    servers = [];
  }

  /** Daily: renew at 30 days left; say so once fewer than 14 remain and renewal keeps failing. */
  async function renew() {
    if (net().via === "ts.net" && !(last && last.node)) await tailscale().catch(() => null);
    const name = certName();
    const c = name && deps.certs.load(ctx.paths.certs, name);
    if (!c || c.expires - now() > 30 * DAY || working) return false;
    try {
      if (net().via === "ts.net") await ts.cert(name, path.join(ctx.paths.certs, `${name}.crt`), path.join(ctx.paths.certs, `${name}.key`));
      else deps.certs.save(ctx.paths.certs, name, await deps.issue({ names: [name], dns: await deps.dns(domain()) }));
      const fresh = deps.certs.load(ctx.paths.certs, name);
      ctx.events.emit("certificate.issued", { name, expires: fresh && fresh.expires, renewed: true });
      await serve();
      return true;
    } catch (e) {
      ctx.log("names: renewal failed: " + /** @type {Error} */ (e).message);
      if (c.expires - now() < 14 * DAY) ctx.events.emit("certificate.failed", { name, expires: c.expires, why: /** @type {Error} */ (e).message });
      return false;
    }
  }

  return { status, check, claim, fallback, release, claimCode, tailscale, setOwner, serve, close, renew,
    connect: () => ts.up(), wait: () => working, onRequest, onUpgrade };
}

function issuerOf(pem) {
  try { return new crypto.X509Certificate(pem).issuer.split("\n").find(l => l.startsWith("O="))?.slice(2) || "unknown"; }
  catch { return "unknown"; }
}

function defaultListen(server, where) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(where.fd !== undefined ? { fd: where.fd } : { host: where.host, port: where.port }, () => { server.off("error", reject); resolve(undefined); });
  });
}
