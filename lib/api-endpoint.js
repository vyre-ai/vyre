// @ts-check
// Where an API key may be sent. Private, tailnet, link-local and cloud-metadata addresses are never a place a key goes, whether written as a literal (in any
// IPv4 or IPv6 spelling) or reached by a name that resolves to one. Loopback is "this machine" (a local model server) on a Mac or PC; on a box its ports
// are Vyre's own services, so it is refused there, and everywhere Vyre's own loopback ports (onboarding, 7300 and the next few) are refused.
// The address a name resolves to is looked up once and the request is made to that address (pinnedFetch), so a name that changes between the check and the call gets nothing.

import dns from "node:dns/promises";
import net from "node:net";
import { classifyAddress, isLoopbackHost } from "./netguard.js";
import { requestOnce } from "./http.js";

const onBox = () => Boolean(process.env.VYRE_SUPERVISOR);

/**
 * What an IP literal is, whatever its spelling: "loopback", "refused" (private, tailnet, link-local, metadata, unspecified, multicast, unique-local, special), "ok", or null when it is not an IP.
 * The decision is lib/netguard.js classifyAddress (bytes, not text); this only renames "public" to "ok" for the callers here.
 * @param {string} ip @returns {"loopback"|"refused"|"ok"|null}
 */
export function classify(ip) {
  const c = classifyAddress(ip);
  return c === "public" ? "ok" : c;
}

export { isLoopbackHost };

/** Is this IP literal one a key must not be sent to? Loopback is allowed here. @param {string} ip */
export const addressRefused = ip => classify(ip) === "refused";

/** Hostnames that are metadata services by name. @param {string} h */
export const metadataName = h => /^(?:metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)$/i.test(String(h));

/** Ports on this machine that are Vyre's own (onboarding's loopback page starts at 7300). @param {string|number} port */
export const vyrePort = port => { const n = Number(port); return n >= 7300 && n <= 7310; };

/** May a key go to this loopback address and port? Not on a box, and never to Vyre's own ports. @param {URL} u */
export const loopbackRefused = u => isLoopbackHost(u.hostname) && (onBox() || vyrePort(u.port));

/**
 * Resolve the host of a base URL right now. Returns the address to use (pinned), or null when it is refused: any answer private, tailnet, metadata or
 * loopback where loopback is not allowed. Run on every turn that uses a key.
 * @param {string} base @param {(h: string) => Promise<{ address: string }[]>} [lookup]
 * @returns {Promise<{ address: string, family: number } | null>}
 */
export async function resolveSafe(base, lookup = h => dns.lookup(h, { all: true })) {
  const u = new URL(base);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isLoopbackHost(host)) return loopbackRefused(u) ? null : host.toLowerCase() === "localhost" ? { address: "127.0.0.1", family: 4 } : { address: host.replace(/%.*$/, ""), family: net.isIP(host.replace(/%.*$/, "")) };
  if (metadataName(host)) return null;
  if (net.isIP(host)) return addressRefused(host) ? null : { address: host, family: net.isIP(host) };
  try {
    const answers = await lookup(host);
    // A name is never a way to reach this machine: any answer that is refused or loopback, in any spelling, refuses the name.
    if (!answers.length || answers.some(r => classify(r.address) !== "ok")) return null;
    return { address: answers[0].address.replace(/%.*$/, ""), family: net.isIP(answers[0].address.replace(/%.*$/, "")) };
  } catch { return null; }
}

/** The check without the address. @param {string} base @param {(h: string) => Promise<{ address: string }[]>} [lookup] */
export const hostSafe = async (base, lookup) => Boolean(await resolveSafe(base, lookup));

/**
 * fetch to a pinned address: the connection goes to `pin.address` with the URL's own host name for TLS and the Host header, and redirects are never followed.
 * @param {string} url @param {{ method?: string, headers?: Record<string, string>, body?: any, signal?: AbortSignal }} init @param {{ address: string, family: number }} pin
 * @returns {Promise<Response>}
 */
export async function pinnedFetch(url, init, pin) {
  const res = await requestOnce(new URL(url), { method: init.method || "GET", headers: new Headers(init.headers || {}), ...(init.body !== undefined && init.body !== null ? { body: Buffer.from(init.body) } : {}), signal: init.signal || new AbortController().signal, address: pin.address, maxBytes: Infinity, stream: true });
  if (res.status >= 300 && res.status < 400) { res.body?.cancel().catch(() => {}); throw new Error("redirect refused"); }
  return res;
}
