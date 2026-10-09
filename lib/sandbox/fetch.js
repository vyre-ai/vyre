// @ts-check
// fetch: the one way a sandboxed child reaches the network. The child has no network of its own
// (its uid is refused by the host firewall, lib/sandbox/identity.js); it asks its parent, and the
// parent runs this. GET and HEAD only, http(s) on ports 80 and 443 only, no credentials in the
// URL. The host name is resolved here, every address must be public, and the connection goes to
// that checked address, so a name cannot change its answer between the check and the connect.
// Each redirect is checked again from the start. A credential the parent attaches goes only to
// the host it was declared for and is dropped on any redirect to another host.

import dns from "node:dns";
import { isPublicAddress } from "../netguard.js";
import { requestOnce, HttpError } from "../http.js";

export const FETCH_LIMITS = { bytes: 1_000_000, timeoutMs: 20_000, redirects: 5 };
const PORTS = { "http:": "80", "https:": "443" };

export class FetchRefused extends Error {}

/**
 * @typedef {{ lookup?: (host: string) => Promise<string[]>,
 *   request?: (mod: typeof https, o: any, cb: (res: any) => void) => any,
 *   maxBytes?: number, timeoutMs?: number, maxRedirects?: number,
 *   auth?: { host: string, header: string, value: string },
 *   allowAddress?: (ip: string) => boolean, allowHost?: (url: URL) => boolean, plainAuth?: boolean, allowPort?: (port: string, protocol: string) => boolean }} FetchOptions
 */

const defaultLookup = async host => (await dns.promises.lookup(host, { all: true })).map(a => a.address);

/**
 * @param {string} rawUrl
 * @param {{ method?: string, headers?: Record<string, string> }} [init]
 * @param {FetchOptions} [opts]
 * @returns {Promise<{ status: number, url: string, headers: Record<string, string>, body: string, truncated: boolean }>}
 */
export async function mediatedFetch(rawUrl, init = {}, opts = {}) {
  const method = String(init.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") throw new FetchRefused(`${method} is not allowed from a watcher; only GET and HEAD, so a watcher reads and never writes`);
  const lookup = opts.lookup || defaultLookup;
  const maxBytes = opts.maxBytes ?? FETCH_LIMITS.bytes, timeoutMs = opts.timeoutMs ?? FETCH_LIMITS.timeoutMs;
  const maxRedirects = opts.maxRedirects ?? FETCH_LIMITS.redirects;
  const allowAddress = opts.allowAddress || isPublicAddress;
  const deadline = Date.now() + timeoutMs;
  const hostOk = u => { if (opts.allowHost && !opts.allowHost(u)) throw new FetchRefused(`${u.hostname} is not one of this watcher's declared hosts`); };
  let url = parse(rawUrl, opts.allowPort);
  hostOk(url);
  const first = url.origin;
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = (await import("node:net")).isIP(host) ? [host] : await lookup(host);
    if (!addrs.length) throw new FetchRefused(`${host} did not resolve`);
    const bad = addrs.find(a => !allowAddress(a));
    if (bad) throw new FetchRefused(`${host} resolves to ${bad}, which is not a public address`);
    const headers = { "user-agent": "vyre-watcher", accept: "*/*", ...lowerKeys(init.headers) };
    delete headers.host; delete headers.authorization; delete headers.cookie;
    if (opts.auth && opts.auth.host === url.hostname && (url.protocol === "https:" || opts.plainAuth)) headers[opts.auth.header.toLowerCase()] = opts.auth.value;
    const res = await once(url, addrs[0], method, headers, maxBytes, deadline, opts.request);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw new FetchRefused(`more than ${maxRedirects} redirects`);
      url = parse(new URL(res.headers.location, url).href, opts.allowPort);
      hostOk(url);                                   // a redirect may not leave the declared hosts
      if (url.origin !== first && opts.auth) opts = { ...opts, auth: undefined };   // nor keep a credential across an origin change
      continue;
    }
    return { status: res.status, url: url.href, headers: res.headers, body: res.body, truncated: res.truncated };
  }
}

/** @param {string} raw */
function parse(raw, allowPort) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new FetchRefused(`not a URL: ${String(raw).slice(0, 80)}`); }
  if (!(u.protocol in PORTS)) throw new FetchRefused(`${u.protocol} is not allowed; http and https only`);
  if (u.username || u.password) throw new FetchRefused("a URL with a user name or password is refused; credentials come from the vault");
  if ((u.port || PORTS[u.protocol]) !== PORTS[u.protocol] && !allowPort?.(u.port, u.protocol)) throw new FetchRefused(`port ${u.port} is not allowed; 80 and 443 only`);
  return u;
}

const lowerKeys = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));

/** One GET or HEAD to the checked address over the shared transport (lib/http.js requestOnce), cut at maxBytes and flagged, under one overall deadline. */
async function once(url, ip, method, headers, maxBytes, deadline, request) {
  const timeoutMs = Math.max(1, deadline - Date.now());
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);   // a ref'd timer: the deadline must keep a waiting parent alive
  const signal = ac.signal;
  const hs = new Headers(headers);
  try {
    const res = await requestOnce(url, { method, headers: hs, signal, address: ip, maxBytes, truncate: true, ...(request ? { request: (o, cb) => request(url.protocol === "https:" ? "https" : "http", o, cb) } : {}) });
    return { status: res.status, headers: lowerKeys(Object.fromEntries(res.headers.entries())), body: await res.text(), truncated: /** @type {any} */ (res).truncated === true };
  } catch (e) {
    if (e instanceof HttpError && e.code === "timeout") throw new FetchRefused(`took longer than ${Math.round(timeoutMs / 1000)}s`);
    throw e;
  } finally { clearTimeout(timer); }
}
