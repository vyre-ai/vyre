// @ts-check
// Where an API key may be sent. Loopback is "this machine" (a local model server); private, tailnet, link-local and cloud-metadata
// addresses are never a place a key goes, whether written as a literal or reached by a name that resolves to one.

import dns from "node:dns/promises";
import net from "node:net";

const LOOP = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
export const isLoopbackHost = (/** @type {string} */ h) => LOOP.has(String(h).toLowerCase());

/** Is this IP literal one a key must not be sent to? Loopback is allowed. @param {string} ip */
export function addressRefused(ip) {
  let a = String(ip).replace(/^\[|\]$/g, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  if (net.isIPv4(a)) {
    const [p, q] = a.split(".").map(Number);
    if (p === 127) return false;
    return p === 10 || p === 0 || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254)
      || a === "192.0.0.192" || a === "100.100.100.200" || p >= 224;
  }
  if (net.isIPv6(a)) {
    if (a === "::1") return false;
    return a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || a === "fd00:ec2::254";
  }
  return false;
}

/** Hostnames that are metadata services by name. @param {string} h */
export const metadataName = h => /^(?:metadata\.google\.internal|metadata\.goog|instance-data(?:\.ec2\.internal)?)$/i.test(String(h));

/**
 * Resolve the host of a base URL right now and refuse it if any answer is a refused address. Run on every turn that uses a key, so a name
 * that later points somewhere private gets nothing. (The fetch resolves again; a name that changes between the two is the one gap left.)
 * @param {string} base @param {(h: string) => Promise<{ address: string }[]>} [lookup]
 */
export async function hostSafe(base, lookup = h => dns.lookup(h, { all: true })) {
  const host = new URL(base).hostname;
  if (isLoopbackHost(host)) return true;
  if (metadataName(host)) return false;
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) return !addressRefused(host);
  try { return (await lookup(host)).every(r => !addressRefused(r.address)); } catch { return false; }
}
