// @ts-check
// Which addresses a session's "internet" may reach (the egress proxy's internet mode): the public ones. Never loopback, a private or
// link-local or carrier-grade range, multicast, this machine's own addresses, or an IPv4-mapped form of any of those. The proxy resolves the
// name itself and connects to the address it checked, so a name cannot answer "public" to the check and "private" to the connection (rebinding).

import dns from "node:dns";
import net from "node:net";
import os from "node:os";

/** @param {string} ip */
function v4(ip) { const p = ip.split(".").map(Number); return p.length === 4 && p.every(n => n >= 0 && n <= 255) ? p : null; }

/** @param {string} ip @param {string[]} [own] */
export function isPublicAddress(ip, own = ownAddresses()) {
  let a = String(ip).toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a); if (mapped) a = mapped[1];
  if (own.includes(a)) return false;
  if (net.isIPv4(a)) {
    const p = /** @type {number[]} */ (v4(a));
    if (p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;           // carrier-grade NAT (includes tailnet addresses)
    if (p[0] === 169 && p[1] === 254) return false;                         // link-local, cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && (p[1] === 168 || (p[1] === 0 && p[2] === 0) || (p[1] === 0 && p[2] === 2))) return false;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
    return true;
  }
  if (net.isIPv6(a)) {
    if (a === "::" || a === "::1") return false;
    if (/^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)) return false;   // unique-local, link-local, multicast
    if (/^64:ff9b:/.test(a)) return false;
    return true;
  }
  return false;
}

/** This machine's own addresses. */
export function ownAddresses() { return Object.values(os.networkInterfaces()).flat().filter(Boolean).map(a => /** @type {any} */ (a).address.toLowerCase()); }

/**
 * Resolve a host name to ONE public address, or throw. A literal address is checked as it stands.
 * @param {string} host @param {{ lookup?: (h: string) => Promise<{ address: string }[]>, own?: string[] }} [o]
 */
export async function resolvePublic(host, o = {}) {
  const own = o.own || ownAddresses();
  const list = net.isIP(host) ? [{ address: host }] : await (o.lookup || (h => dns.promises.lookup(h, { all: true })))(host);
  if (!list.length) throw Object.assign(new Error("no address"), { code: "ENOTFOUND" });
  // Every answer must be public: a name with one private answer is refused whole, not "the public one".
  for (const r of list) if (!isPublicAddress(r.address, own)) throw Object.assign(new Error("not a public address"), { code: "NOT_PUBLIC" });
  return list[0].address;
}
