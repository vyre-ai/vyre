// kernel/modules/egress.js: the only way out for a module that is not first party (K6). The module has no socket; it sends a request to the supervisor,
// and this decides: https only, a host the module's manifest declared (and nothing else), never a private, loopback, link-local or metadata address
// (checked on the address the name resolves to, not the name), no redirect followed without checking the new host the same way, bounded size and time,
// no cookies, no ambient credentials (a service key comes from the vault at the point of use, never from the module). One event per request says who
// asked for which host and what came back; the body is never logged.
import net from "node:net";
import dns from "node:dns/promises";
import { KernelError } from "../core/errors.js";

const MAX_BODY = 1 << 20, MAX_REDIRECTS = 3, TIMEOUT_MS = 15_000;
const BAD_HEADERS = new Set(["cookie", "authorization", "proxy-authorization", "host", "connection", "upgrade", "content-length", "transfer-encoding"]);

/** Is this address one a module must never reach? */
export function privateAddress(/** @type {string} */ ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1" || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb") || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("ff")) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? privateAddress(m[1]) : false;
  }
  return true;
}

/**
 * @param {{ space: string, log?: any, chains?: any, hostsOf: (module: string) => readonly string[] | undefined,
 *   resolve?: (host: string) => Promise<string[]>, fetchImpl?: (url: string, init: any) => Promise<{ status: number, headers: Record<string, string>, body: Uint8Array }> }} cfg
 *   hostsOf: the hosts a module's manifest declared (exact names; `*.example.com` allows its subdomains)
 */
export function createEgress(cfg) {
  const resolve = cfg.resolve || (async (/** @type {string} */ h) => (await dns.lookup(h, { all: true })).map(a => a.address));
  const fetchImpl = cfg.fetchImpl || (async (/** @type {string} */ url, /** @type {any} */ init) => {
    const r = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, headers: Object.fromEntries(r.headers), body: buf };
  });
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
