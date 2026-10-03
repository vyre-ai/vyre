// kernel/modules/egress.js: the only way out for a module that is not first party (K6). The module has no socket; it sends a request to the supervisor,
// and this decides: https only, a host the module's manifest declared (and nothing else), never a private, loopback, link-local or metadata address
// (checked on the address the name resolves to, not the name), no redirect followed without checking the new host the same way, bounded size and time,
// no cookies, no ambient credentials (a service key comes from the vault at the point of use, never from the module). One event per request says who
// asked for which host and what came back; the body is never logged.
import net from "node:net";
import dns from "node:dns/promises";
import https from "node:https";
import { KernelError } from "../core/errors.js";

const MAX_BODY = 1 << 20, MAX_REDIRECTS = 3, TIMEOUT_MS = 15_000;
const BAD_HEADERS = new Set(["cookie", "authorization", "proxy-authorization", "host", "connection", "upgrade", "content-length", "transfer-encoding"]);

/** Parse an IPv4 or IPv6 address to its 4 or 16 bytes, or null. Every textual form (compressed, dotted tail, mapped) ends up as the same bytes. @param {string} ip */
export function ipBytes(ip) {
  const v = net.isIP(ip);
  if (v === 4) return Uint8Array.from(ip.split(".").map(Number));
  if (v !== 6) return null;
  let s = ip.toLowerCase().split("%")[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) { const p = dotted[1].split(".").map(Number); s = s.slice(0, -dotted[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16); }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [], t = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  groups.forEach((g, i) => { const n = parseInt(g || "0", 16); out[i * 2] = n >> 8; out[i * 2 + 1] = n & 255; });
  return out;
}

const V4_BLOCKED = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"].map(c => { const [a, bits] = c.split("/"); const p = a.split(".").map(Number); const base = ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0; const mask = (~0 << (32 - Number(bits))) >>> 0; return { base: (base & mask) >>> 0, mask }; });
const v4Private = (/** @type {Uint8Array} */ b) => { const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; return V4_BLOCKED.some(r => ((n & r.mask) >>> 0) === r.base); };

/** Is this address one a module must never reach? Checked on the bytes, so every form that carries a private IPv4 (mapped, compatible, NAT64, 6to4) is caught. */
export function privateAddress(/** @type {string} */ ip) {
  const b = ipBytes(ip);
  if (!b) return true;
  if (b.length === 4) return v4Private(b);
  const allZero = (/** @type {number} */ from, /** @type {number} */ to) => b.slice(from, to).every(x => x === 0);
  if (allZero(0, 10) && b[10] === 255 && b[11] === 255) return v4Private(b.slice(12));        // ::ffff:a.b.c.d (any textual form)
  if (allZero(0, 12)) return true;                                                              // ::, ::1 and the compatible form ::a.b.c.d
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) return v4Private(b.slice(12)) || true; // NAT64: never from a module
  if (b[0] === 0x20 && b[1] === 0x02) return true;                                              // 6to4 embeds an IPv4 anywhere: refused whole
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true;                  // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;            // documentation
  if (b[0] === 0x01 && b[1] === 0 && allZero(2, 8)) return true;                               // discard 100::/64
  if ((b[0] & 0xfe) === 0xfc) return true;                                                      // unique local fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;                                     // link local fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true;                                     // site local (deprecated)
  if (b[0] === 0xff) return true;                                                               // multicast
  return false;
}

/**
 * The default fetch: it connects to the address the proxy checked and nowhere else (a `lookup` that returns the pinned address, with the name kept for TLS and
 * Host), and looks at the connected socket's remote address once more before a byte of the request goes out. A name that resolves differently a moment later
 * (DNS rebinding) therefore changes nothing. `request` is injectable for tests.
 * @param {{ request?: typeof https.request }} [o]
 */
export function pinnedFetch(o = {}) {
  const request = o.request || https.request;
  return (/** @type {string} */ url, /** @type {any} */ init) => new Promise((resolve, reject) => {
    const u = new URL(url), pinned = String(init.pinned), family = net.isIP(pinned);
    const lookup = (/** @type {string} */ _h, /** @type {any} */ opts, /** @type {any} */ cb) => (opts && opts.all ? cb(null, [{ address: pinned, family }]) : cb(null, pinned, family));
    const req = request({ protocol: "https:", hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: init.method, headers: init.headers, servername: net.isIP(u.hostname) ? undefined : u.hostname, lookup, agent: false, timeout: TIMEOUT_MS }, res => {
      const chunks = []; let n = 0;
      res.on("data", (/** @type {Buffer} */ c) => { n += c.length; if (n > MAX_BODY + 1) { req.destroy(new Error("too large")); } else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode || 0, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v)])), body: new Uint8Array(Buffer.concat(chunks)) }));
    });
    // The socket that actually connected must be the pinned address, whatever resolved it: checked again before the request is written.
    req.on("socket", (/** @type {any} */ sock) => { const check = () => { if (sock.remoteAddress && (sock.remoteAddress !== pinned && sock.remoteAddress.replace(/^::ffff:/, "") !== pinned || privateAddress(sock.remoteAddress))) req.destroy(new Error("connected to an address that was not checked")); }; if (sock.connecting) sock.once("connect", check); else check(); });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * @param {{ space: string, log?: any, chains?: any, hostsOf: (module: string) => readonly string[] | undefined,
 *   resolve?: (host: string) => Promise<string[]>, fetchImpl?: (url: string, init: any) => Promise<{ status: number, headers: Record<string, string>, body: Uint8Array }> }} cfg
 *   hostsOf: the hosts a module's manifest declared (exact names; `*.example.com` allows its subdomains)
 */
export function createEgress(cfg) {
  const resolve = cfg.resolve || (async (/** @type {string} */ h) => (await dns.lookup(h, { all: true })).map(a => a.address));
  const fetchImpl = cfg.fetchImpl || pinnedFetch();
  const note = (/** @type {string} */ module, /** @type {string} */ type, /** @type {any} */ data) => {
    if (!cfg.log || !cfg.chains) return;
    try { cfg.log.append(cfg.chains.fromFacts({ kind: "module", module: "egress", first_party: true }), { type, sv: 1, subject: `vyre://${cfg.space}/module/${module}`, data: { module, ...data }, vis: "space", red: "internal" }); } catch { /* a note never opens the door */ }
  };
  const allowedHost = (/** @type {readonly string[]} */ hosts, /** @type {string} */ h) => hosts.some(x => x === h || (x.startsWith("*.") && h.endsWith(x.slice(1)) && h.length > x.length - 1));

  /** @param {string} module @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: string }} [init] */
  async function request(module, url, init = {}) {
    const hosts = cfg.hostsOf(module);
    let current = url, hops = 0;
    for (;;) {
      let u;
      try { u = new URL(current); } catch { note(module, "egress.refused", { why: "bad_url" }); throw new KernelError("bad_input", "not a URL"); }
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      const refuse = (/** @type {string} */ why, /** @type {string} */ code = "egress_refused") => { note(module, "egress.refused", { host, why }); throw new KernelError(code, "that address is not open to this module"); };
      if (u.protocol !== "https:") refuse("not_https");
      if (u.username || u.password) refuse("credentials_in_url");
      if (!hosts || !hosts.length || !allowedHost(hosts, host)) refuse("host_not_declared");
      const addrs = net.isIP(host) ? [host] : await resolve(host).catch(() => []);
      if (!addrs.length || addrs.some(privateAddress)) refuse("private_address");
      const method = String(init.method || "GET").toUpperCase();
      if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) refuse("bad_method");
      const body = init.body === undefined ? undefined : String(init.body);
      if (body !== undefined && body.length > MAX_BODY) refuse("body_too_large");
      const headers = Object.fromEntries(Object.entries(init.headers || {}).filter(([k]) => !BAD_HEADERS.has(k.toLowerCase())).map(([k, v]) => [k, String(v)]));
      let r;
      try { r = await fetchImpl(u.toString(), { method, headers, ...(body !== undefined && method !== "GET" && method !== "HEAD" ? { body } : {}), pinned: addrs[0] }); }
      catch { note(module, "egress.failed", { host, method }); throw new KernelError("unavailable", "the request could not be made"); }
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        if (++hops > MAX_REDIRECTS) refuse("too_many_redirects");
        current = new URL(r.headers.location, u).toString();
        continue;
      }
      if (r.body.length > MAX_BODY) refuse("response_too_large");
      note(module, "egress.requested", { host, method, status: r.status, bytes: r.body.length });
      return { status: r.status, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => !["set-cookie", "set-cookie2"].includes(k.toLowerCase()))), body: Buffer.from(r.body).toString("utf8") };
    }
  }
  return Object.freeze({ request, allowedHost });
}
