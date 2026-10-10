// @ts-check
// reach: how a home server behind a router is reached without the relay (SPEC-wink-network C16, team/0.3/PLAN-built-in-network.md).
//
// The relay is always the first working path and the fallback: a server is reachable through it from the first second, and this module never takes it away. It tries,
// in the background and in this order, to make a DIRECT path as well:
//   1. IPv6   a global address on this machine (2000::/3). Reported as a candidate; the person's own firewall decides whether the port is open, and only the check below says so.
//   2. UPnP   ask the person's own router (SSDP, then SOAP) to forward a port to this machine, with a lease that is renewed and deleted on stop.
//   3. NAT-PMP the same ask in the router's other language (RFC 6886), Linux gateway discovery.
// Nothing is exposed that the person's router did not agree to, no rule is made on this machine, and a mapping is called "direct" only after `verify` reached it FROM OUTSIDE
// (default: the relay dials the address back, relay/node/server.js POST /v1/reach/check). Without a verifier, or when it cannot reach the port, the state stays "relay"
// and `tried` says why. A router that reports a private or carrier-grade external address (100.64.0.0/10) is not directly reachable and is said to be so.
//
//   const r = createReach({ log, ports: [{ port: 8443, proto: "tcp" }], verify });
//   await r.start();          // returns when the first round of attempts has finished (the relay already works)
//   r.status();               // { state: "direct" | "relay", public: { v4, v6, via }, mapped: [...], tried: [...] }
//   await r.stop();           // removes the mappings it made
//
// Every outside touch is a port so tests pass fakes: `dgram` (UDP), `fetch` (SOAP, the description), `interfaces` (os.networkInterfaces), `gateway` (the default gateway), `verify`.

import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import { isPublicAddress } from "../../lib/netguard.js";

const SSDP_ADDR = "239.255.255.250", SSDP_PORT = 1900;
const ST = ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", "urn:schemas-upnp-org:device:InternetGatewayDevice:2"];
const WAN = ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"];
const LEASE_S = 3600;
const DESCRIPTION = "Vyre";

const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const within = (/** @type {Promise<any>} */ p, /** @type {number} */ ms, /** @type {string} */ what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error(`${what} did not answer in ${ms} ms`), { code: "timeout" })), ms); })]).finally(() => clearTimeout(t)); };

/** A public IPv4 (lib/netguard.js decides: not private, loopback, link-local, carrier-grade, multicast, documentation or reserved). @param {string} ip */
export function isPublicV4(ip) { return net.isIPv4(String(ip)) && isPublicAddress(String(ip), []); }

/** A global unicast IPv6 (2000::/3), not a temporary privacy address when a stable one exists. @param {string} ip */
export function isGlobalV6(ip) { return /^[23][0-9a-f]{3}:/i.test(String(ip).split("%")[0]); }

/** This machine's global IPv6 addresses and its first private IPv4 (the address a router maps to). @param {() => any} [interfaces] */
export function localAddresses(interfaces = os.networkInterfaces) {
  /** @type {string[]} */ const v6 = [];
  /** @type {string | null} */ let v4 = null;
  for (const list of Object.values(interfaces() || {})) for (const a of /** @type {any[]} */ (list || [])) {
    if (a.internal) continue;
    if ((a.family === "IPv6" || a.family === 6) && isGlobalV6(a.address)) v6.push(a.address);
    if ((a.family === "IPv4" || a.family === 4) && !v4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) v4 = a.address;
  }
  return { v6, v4 };
}

/** The default gateway from /proc/net/route (Linux). Null elsewhere. @param {() => string} [read] */
export function defaultGateway(read = () => fs.readFileSync("/proc/net/route", "utf8")) {
  try {
    for (const line of read().split("\n").slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f[1] === "00000000" && f[2] && f[2] !== "00000000") { const n = parseInt(f[2], 16); return [n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >>> 24) & 255].join("."); }
    }
  } catch { /* no /proc */ }
  return null;
}

// ---- UPnP ----

const tag = (/** @type {string} */ xml, /** @type {string} */ name) => { const m = new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(xml); return m ? m[1].trim() : null; };
const xmlEsc = (/** @type {string} */ s) => String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] || c);

/** From a device description, the first WAN connection service's control URL and type. @param {string} xml @param {string} base */
export function parseDescription(xml, base) {
  for (const type of WAN) {
    const i = xml.indexOf(`<serviceType>${type}</serviceType>`);
    if (i < 0) continue;
    const rest = xml.slice(i), url = tag(rest, "controlURL");
    if (url) { try { return { type, controlUrl: new URL(url, base).href }; } catch { /* a bad url */ } }
  }
  return null;
}

const envelope = (/** @type {string} */ type, /** @type {string} */ action, /** @type {Record<string, string|number>} */ args) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${type}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(String(v))}</${k}>`).join("")}</u:${action}></s:Body></s:Envelope>`;

/** @param {{ fetch: typeof fetch, controlUrl: string, type: string, timeoutMs: number }} g @param {string} action @param {Record<string, string|number>} args */
async function soap(g, action, args) {
  const r = await within(g.fetch(g.controlUrl, { method: "POST", headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${g.type}#${action}"` }, body: envelope(g.type, action, args) }), g.timeoutMs, `router ${action}`);
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(tag(text, "errorDescription") || `router said ${r.status}`), { code: tag(text, "errorCode") || String(r.status) });
  return text;
}

/** SSDP search: the first answer's LOCATION. @param {{ dgram: typeof dgram, timeoutMs: number, addr?: string, port?: number }} o @returns {Promise<string[]>} */
function search(o) {
  return new Promise(resolve => {
    const sock = o.dgram.createSocket({ type: "udp4", reuseAddr: true });
    /** @type {Set<string>} */ const found = new Set();
    const done = () => { clearTimeout(t); try { sock.close(); } catch { /* closed */ } resolve([...found]); };
    const t = setTimeout(done, o.timeoutMs);
    sock.on("error", done);
    sock.on("message", msg => { const m = /^location:\s*(\S+)/im.exec(msg.toString("utf8")); if (m) { found.add(m[1]); if (found.size >= 3) done(); } });
    sock.bind(0, () => {
      for (const st of ST) {
        const q = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP_ADDR}:${SSDP_PORT}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ${st}\r\n\r\n`);
        sock.send(q, o.port ?? SSDP_PORT, o.addr ?? SSDP_ADDR, () => {});
      }
    });
  });
}

// ---- NAT-PMP (RFC 6886) ----

/** One request/response with the gateway on UDP 5351. @param {{ dgram: typeof dgram, gateway: string, port?: number, timeoutMs: number }} o @param {Buffer} req @returns {Promise<Buffer>} */
function pmp(o, req) {
  return new Promise((resolve, reject) => {
    const sock = o.dgram.createSocket("udp4");
    const t = setTimeout(() => { try { sock.close(); } catch { /* closed */ } reject(Object.assign(new Error("the router did not answer NAT-PMP"), { code: "timeout" })); }, o.timeoutMs);
    sock.on("error", e => { clearTimeout(t); reject(e); });
    sock.on("message", msg => { clearTimeout(t); try { sock.close(); } catch { /* closed */ } resolve(msg); });
    sock.send(req, o.port ?? 5351, o.gateway, e => { if (e) { clearTimeout(t); reject(e); } });
  });
}

/**
 * @typedef {{ port: number, proto: "tcp" | "udp" }} PortSpec
 * @typedef {{ proto: string, port: number, externalPort: number, via: "upnp" | "natpmp", verified: boolean, expires: number, address: string | null }} Mapping
 * @typedef {{ via: string, ok: boolean, why?: string }} Tried
 * @typedef {{ addr: string, port: number, proto: string, via: string }} Candidate
 */

/**
 * @param {{
 *   log?: (m: string) => void,
 *   ports: PortSpec[],
 *   verify?: (c: Candidate) => Promise<boolean>,
 *   onchange?: (s: ReturnType<ReturnType<typeof createReach>["status"]>) => void,
 *   dgram?: typeof dgram, fetch?: typeof fetch, interfaces?: () => any, gateway?: () => string | null,
 *   ssdp?: { addr?: string, port?: number }, pmpPort?: number,
 *   timeoutMs?: number, leaseS?: number, now?: () => number, disable?: Array<"ipv6" | "upnp" | "natpmp">,
 * }} o
 */
export function createReach(o) {
  const log = o.log || (() => {});
  const ports = o.ports || [];
  const d = o.dgram || dgram, f = o.fetch || fetch;
  const timeoutMs = o.timeoutMs ?? 2500;
  const leaseS = o.leaseS ?? LEASE_S;
  const now = o.now || Date.now;
  const off = new Set(o.disable || []);
  /** @type {Mapping[]} */ let mapped = [];
  /** @type {Tried[]} */ let tried = [];
  /** @type {{ v4: string | null, v6: string | null, via: string | null }} */ let pub = { v4: null, v6: null, via: null };
  /** @type {{ controlUrl: string, type: string, fetch: typeof fetch, timeoutMs: number } | null} */ let igd = null;
  /** @type {string | null} */ let gw = null;
  /** @type {NodeJS.Timeout | null} */ let timer = null;
  let stopped = false;
  let verified = false;

  const state = () => (mapped.some(m => m.verified) ? "direct" : "relay");
  const status = () => ({ state: /** @type {"direct" | "relay"} */ (state()), public: { ...pub }, mapped: mapped.map(m => ({ ...m })), tried: tried.map(t => ({ ...t })) });
  const changed = () => { try { o.onchange && o.onchange(status()); } catch { /* a listener's fault */ } };
  const note = (/** @type {string} */ via, /** @type {boolean} */ ok, /** @type {string} */ [why] = [""]) => { tried.push({ via, ok, ...(why ? { why } : {}) }); };

  /** @param {Candidate} c */
  async function check(c) {
    if (!o.verify) return false;
    try { return (await within(o.verify(c), 8000, "the outside check")) === true; } catch (e) { log(`reach: outside check failed: ${/** @type {Error} */ (e).message}`); return false; }
  }

  async function tryIpv6() {
    const { v6 } = localAddresses(o.interfaces);
    if (!v6.length) { note("ipv6", false, ["no global IPv6 address on this machine"]); return; }
    pub.v6 = v6[0];
    let ok = false;
    for (const p of ports) if (await check({ addr: v6[0], port: p.port, proto: p.proto, via: "ipv6" })) {
      ok = true;
      mapped.push({ proto: p.proto, port: p.port, externalPort: p.port, via: /** @type {any} */ ("ipv6"), verified: true, expires: 0, address: v6[0] });
    }
    note("ipv6", ok, [ok ? "" : o.verify ? "the port is not open from outside (a firewall)" : "no outside check to prove it"]);
    if (ok && !pub.via) pub.via = "ipv6";
  }

  async function discoverIgd() {
    const locations = await search({ dgram: d, timeoutMs, ...(o.ssdp || {}) });
    if (!locations.length) throw Object.assign(new Error("no router answered UPnP"), { code: "none" });
    for (const loc of locations) {
      try {
        const r = await within(f(loc), timeoutMs, "the router's description");
        const svc = parseDescription(await r.text(), loc);
        if (svc) return { ...svc, fetch: f, timeoutMs };
      } catch { /* try the next one */ }
    }
    throw Object.assign(new Error("the router has no port-forwarding service"), { code: "none" });
  }

  /** @param {PortSpec} p @param {string} local */
  async function upnpMap(p, local) {
    if (!igd) throw new Error("no router");
    const proto = p.proto.toUpperCase();
    let ext = p.port, lease = leaseS;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await soap(igd, "AddPortMapping", { NewRemoteHost: "", NewExternalPort: ext, NewProtocol: proto, NewInternalPort: p.port, NewInternalClient: local, NewEnabled: 1, NewPortMappingDescription: DESCRIPTION, NewLeaseDuration: lease });
        return { externalPort: ext, lease };
      } catch (e) {
        const code = /** @type {any} */ (e).code;
        if (code === "725") { lease = 0; continue; }                                  // only permanent leases: ask for one, and delete it on stop
        if (code === "718" || code === "727") { ext = 20000 + Math.floor(Math.random() * 40000); continue; }   // the port is taken: another one
        throw e;
      }
    }
    throw new Error("the router would not forward the port");
  }

  async function tryUpnp() {
    const { v4: local } = localAddresses(o.interfaces);
    if (!local) { note("upnp", false, ["no private IPv4 address to forward to"]); return; }
    try { igd = await discoverIgd(); } catch (e) { note("upnp", false, [/** @type {Error} */ (e).message]); return; }
    let ext = null;
    try { ext = tag(await soap(igd, "GetExternalIPAddress", {}), "NewExternalIPAddress"); } catch { /* some routers refuse; the outside check still decides */ }
    if (ext && !isPublicV4(ext)) { note("upnp", false, [`the router's own address is ${/^100\./.test(ext) ? "carrier-grade (CGNAT)" : "private"}, so nothing can reach it from outside`]); return; }
    let any = false;
    for (const p of ports) {
      try {
        const m = await upnpMap(p, local);
        const ok = ext ? await check({ addr: ext, port: m.externalPort, proto: p.proto, via: "upnp" }) : false;
        mapped.push({ proto: p.proto, port: p.port, externalPort: m.externalPort, via: "upnp", verified: ok, expires: m.lease ? now() + m.lease * 1000 : 0, address: ext });
        any = any || ok;
        if (ok) { pub.v4 = ext; pub.via = pub.via || "upnp"; }
      } catch (e) { note("upnp", false, [`${p.proto} ${p.port}: ${/** @type {Error} */ (e).message}`]); }
    }
    note("upnp", any, [any ? "" : o.verify ? "mapped, but not reachable from outside" : "mapped, no outside check to prove it"]);
  }

  async function tryNatPmp() {
    gw = (o.gateway || defaultGateway)();
    if (!gw) { note("natpmp", false, ["no default gateway found"]); return; }
    const po = { dgram: d, gateway: gw, timeoutMs, ...(o.pmpPort ? { port: o.pmpPort } : {}) };
    let ext;
    try {
      const a = await pmp(po, Buffer.from([0, 0]));
      if (a.length < 12 || a.readUInt16BE(2) !== 0) throw new Error(`the router said result ${a.length >= 4 ? a.readUInt16BE(2) : "?"}`);
      ext = [a[8], a[9], a[10], a[11]].join(".");
    } catch (e) { note("natpmp", false, [/** @type {Error} */ (e).message]); return; }
    if (!isPublicV4(ext)) { note("natpmp", false, [`the router's own address is ${/^100\./.test(ext) ? "carrier-grade (CGNAT)" : "private"}, so nothing can reach it from outside`]); return; }
    let any = false;
    for (const p of ports) {
      const req = Buffer.alloc(12);
      req.writeUInt8(0, 0); req.writeUInt8(p.proto === "udp" ? 1 : 2, 1); req.writeUInt16BE(p.port, 4); req.writeUInt16BE(p.port, 6); req.writeUInt32BE(leaseS, 8);
      try {
        const a = await pmp(po, req);
        if (a.length < 16 || a.readUInt16BE(2) !== 0) throw new Error("the router refused the mapping");
        const externalPort = a.readUInt16BE(10), life = a.readUInt32BE(12);
        const ok = await check({ addr: ext, port: externalPort, proto: p.proto, via: "natpmp" });
        mapped.push({ proto: p.proto, port: p.port, externalPort, via: "natpmp", verified: ok, expires: now() + life * 1000, address: ext });
        any = any || ok;
        if (ok) { pub.v4 = ext; pub.via = pub.via || "natpmp"; }
      } catch (e) { note("natpmp", false, [`${p.proto} ${p.port}: ${/** @type {Error} */ (e).message}`]); }
    }
    note("natpmp", any, [any ? "" : o.verify ? "mapped, but not reachable from outside" : "mapped, no outside check to prove it"]);
  }

  /** One full round: the methods in order, stopping at the first one that is proven from outside (the relay carries the work meanwhile). */
  async function round() {
    mapped = [];
    tried = [];
    for (const [name, run] of /** @type {[string, () => Promise<void>][]} */ ([["ipv6", tryIpv6], ["upnp", tryUpnp], ["natpmp", tryNatPmp]])) {
      if (stopped) return;
      if (off.has(/** @type {any} */ (name))) { note(name, false, ["turned off"]); continue; }
      try { await run(); } catch (e) { note(name, false, [/** @type {Error} */ (e).message]); }
      if (state() === "direct") break;
    }
    verified = state() === "direct";
    log(`reach: ${state()}${pub.via ? ` via ${pub.via}` : ""}; ${tried.map(t => `${t.via} ${t.ok ? "ok" : "no"}`).join(", ")}`);
    changed();
  }

  /** Renew leases before they end, and re-check that a direct path still is one. */
  function schedule() {
    if (stopped) return;
    const next = mapped.filter(m => m.expires).map(m => m.expires - now()).reduce((a, b) => Math.min(a, b), leaseS * 500);
    timer = setTimeout(async () => { try { await round(); } catch (e) { log(`reach: ${/** @type {Error} */ (e).message}`); } schedule(); }, Math.max(1000, Math.min(leaseS * 500, next / 2)));
    timer.unref?.();
  }

  async function removeMappings() {
    for (const m of mapped) {
      try {
        if (m.via === "upnp" && igd) await soap(igd, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: m.externalPort, NewProtocol: m.proto.toUpperCase() });
        if (m.via === "natpmp" && gw) { const req = Buffer.alloc(12); req.writeUInt8(m.proto === "udp" ? 1 : 2, 1); req.writeUInt16BE(m.port, 4); await pmp({ dgram: d, gateway: gw, timeoutMs: 1500, ...(o.pmpPort ? { port: o.pmpPort } : {}) }, req); }
      } catch { /* the lease ends by itself */ }
    }
    mapped = [];
  }

  return {
    /** Run the first round; resolves when it has finished (never throws: a router that says nothing leaves the relay as the path). */
    async start() { stopped = false; await round().catch(e => log(`reach: ${e.message}`)); schedule(); return status(); },
    status,
    /** Take the mappings this made off the router. */
    async stop() { stopped = true; if (timer) clearTimeout(timer); await removeMappings(); changed(); },
    get verified() { return verified; },
  };
}

/** The outside check against a relay you run: it dials this machine's own observed address at the port and says whether the port answered (relay/node/server.js POST /v1/reach/check). @param {string} relayHttp @param {typeof fetch} [f] */
export function relayVerifier(relayHttp, f = fetch) {
  return async (/** @type {Candidate} */ c) => {
    const r = await f(`${relayHttp.replace(/\/$/, "")}/v1/reach/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ port: c.port, addr: c.addr }) });
    if (!r.ok) return false;
    const j = /** @type {any} */ (await r.json());
    return Boolean(j && j.reachable === true);
  };
}

