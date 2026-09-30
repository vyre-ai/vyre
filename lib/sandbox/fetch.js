// @ts-check
// fetch: the one way a sandboxed child reaches the network. The child has no network of its own
// (its uid is refused by the host firewall, lib/sandbox/identity.js); it asks its parent, and the
// parent runs this. GET and HEAD only, http(s) on ports 80 and 443 only, no credentials in the
// URL. The host name is resolved here, every address must be public, and the connection goes to
// that checked address, so a name cannot change its answer between the check and the connect.
// Each redirect is checked again from the start. A credential the parent attaches goes only to
// the host it was declared for and is dropped on any redirect to another host.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isPublicAddress } from "./addr.js";

export const FETCH_LIMITS = { bytes: 1_000_000, timeoutMs: 20_000, redirects: 5 };
const PORTS = { "http:": "80", "https:": "443" };

export class FetchRefused extends Error {}

/**
 * @typedef {{ lookup?: (host: string) => Promise<string[]>,
 *   request?: (mod: typeof https, o: any, cb: (res: any) => void) => any,
 *   maxBytes?: number, timeoutMs?: number, maxRedirects?: number,
 *   auth?: { host: string, header: string, value: string },
 *   allowAddress?: (ip: string) => boolean, allowPort?: (port: string, protocol: string) => boolean }} FetchOptions
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
  let url = parse(rawUrl, opts.allowPort);
  const first = url.hostname;
  for (let hop = 0; ; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = (await import("node:net")).isIP(host) ? [host] : await lookup(host);
    if (!addrs.length) throw new FetchRefused(`${host} did not resolve`);
    const bad = addrs.find(a => !allowAddress(a));
    if (bad) throw new FetchRefused(`${host} resolves to ${bad}, which is not a public address`);
    const headers = { "user-agent": "vyre-watcher", accept: "*/*", ...lowerKeys(init.headers) };
    delete headers.host; delete headers.authorization; delete headers.cookie;
    if (opts.auth && opts.auth.host === url.hostname) headers[opts.auth.header.toLowerCase()] = opts.auth.value;
    const res = await once(url, addrs[0], method, headers, maxBytes, timeoutMs, opts.request);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      if (hop >= maxRedirects) throw new FetchRefused(`more than ${maxRedirects} redirects`);
      url = parse(new URL(res.headers.location, url).href, opts.allowPort);
      if (url.hostname !== first && opts.auth) opts = { ...opts, auth: undefined };
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

function once(url, ip, method, headers, maxBytes, timeoutMs, request) {
  const mod = url.protocol === "https:" ? https : http;
  const o = { host: ip, port: Number(url.port || PORTS[url.protocol]), method, path: url.pathname + url.search, headers: { ...headers, host: url.host }, servername: url.hostname, timeout: timeoutMs };
  return new Promise((resolve, reject) => {
    const go = request || ((m, opt, cb) => m.request(opt, cb));
    const req = go(/** @type {any} */ (mod), o, res => {
      const chunks = []; let size = 0, truncated = false;
      res.on("data", c => {
        if (truncated) return;
        size += c.length;
        if (size > maxBytes) { truncated = true; chunks.push(c.subarray(0, c.length - (size - maxBytes))); res.destroy(); return; }
        chunks.push(c);
      });
      const finish = () => resolve({ status: res.statusCode, headers: lowerKeys(res.headers), body: Buffer.concat(chunks).toString("utf8"), truncated });
      res.on("end", finish); res.on("close", finish);
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new FetchRefused(`took longer than ${Math.round(timeoutMs / 1000)}s`)); });
    req.on("error", reject);
    req.end();
  });
}
