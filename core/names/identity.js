// @ts-check
// identity — who is on the other end of a tailnet connection (ADR 0002).
//
// The TCP peer address of a packet that arrived over WireGuard is the one thing a local,
// unprivileged process cannot forge, so it is the only thing trusted. No header is read. The
// address is looked up with `tailscale whois`, and a connection is served only when it comes
// from a tailnet address, from a node other than this box, that is not tagged, and whose login
// is the owner.

import net from "node:net";

const V4 = new net.BlockList();
V4.addSubnet("100.64.0.0", 10, "ipv4");
const V6 = new net.BlockList();
V6.addSubnet("fd7a:115c:a1e0::", 48, "ipv6");

/** An IPv4-mapped IPv6 address ("::ffff:100.1.2.3") is the IPv4 address. */
export function normalize(ip) {
  const s = String(ip || "");
  return s.startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

/** Is this a Tailscale address at all? Everything else is refused before any lookup. */
export function isTailnet(ip) {
  const a = normalize(ip);
  if (net.isIPv4(a)) return V4.check(a, "ipv4");
  if (net.isIPv6(a)) return V6.check(a, "ipv6");
  return false;
}

/**
 * Build the identify function a listener calls once per connection.
 * @param {{ whois: (ip: string) => Promise<{ login: string|null, tagged: boolean, node: string } | null>,
 *   selfIps: () => string[], selfId?: () => string|null, owner: () => string|null, ttl?: number, now?: () => number }} deps
 * @returns {(ip: string) => Promise<{ ok: boolean, login: string|null, node: string|null, why: string }>}
 */
export function identifier({ whois, selfIps, selfId = () => null, owner, ttl = 60_000, now = Date.now }) {
  /** @type {Map<string, { at: number, who: any }>} */
  const cache = new Map();
  return async raw => {
    const ip = normalize(raw);
    if (!isTailnet(ip)) return { ok: false, login: null, node: null, why: "not a tailnet address" };
    if (selfIps().map(normalize).includes(ip)) return { ok: false, login: null, node: null, why: "from this box itself" };
    let hit = cache.get(ip);
    if (!hit || now() - hit.at > ttl) {
      hit = { at: now(), who: await whois(ip) };
      cache.set(ip, hit);
      if (cache.size > 1000) cache.delete(/** @type {string} */ (cache.keys().next().value));
    }
    const who = hit.who;
    if (!who) return { ok: false, login: null, node: null, why: "tailscale does not know this address" };
    // A second check in case the address list was stale: whois naming this very node.
    const me = selfId();
    if (me && who.stableId === me) return { ok: false, login: null, node: who.node, why: "from this box itself" };
    if (who.tagged || !who.login) return { ok: false, login: null, node: who.node, why: "a tagged node, not a person" };
    const o = owner();
    if (o && who.login.toLowerCase() === o.toLowerCase()) return { ok: true, login: who.login, node: who.node, why: "owner" };
    return { ok: false, login: who.login, node: who.node, why: o ? "not the owner" : "no owner yet" };
  };
}
