// @ts-check
// identity — who is on the other end of a tailnet connection (ADR 0002).
//
// The TCP peer address of a packet that arrived over WireGuard is the one thing a local,
// unprivileged process cannot forge, so it is the only thing trusted. No header is read. The
// address is looked up with `tailscale whois`, and a connection is served only when it comes
// from a tailnet address, from a node other than this box, and is one of three kinds:
//
// - owner: an untagged node whose login is the owner (`tailnet:<login>`), as ever;
// - guest: an untagged node of another person, while network.guests.enabled is on, whose login
//   the owner listed or whom the tailnet policy granted vyre.run/cap/guest (`tailnet-guest:<login>`);
// - agent: a node carrying the agent tag while computers.tailnet.enabled is on, that the
//   computers module says is one of its agents (`tailnet:agent:<name>`). The daemon still wants
//   that agent's key beside it.
//
// Everything else is refused, for the same reasons as before.

import net from "node:net";
import { isGuest } from "./guests.js";

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

const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Build the identify function a listener calls once per connection. Only whois is cached (60 s);
 * the owner, the guest list and the agent switch are read on every connection, so a change to
 * them counts at once.
 * @param {{ whois: (ip: string) => Promise<{ login: string|null, tagged: boolean, node: string, stableId?: string, tags?: string[], caps?: Record<string, any[]> } | null>,
 *   selfIps: () => string[], selfId?: () => string|null, owner: () => string|null,
 *   network?: () => any, agentNodes?: () => { enabled?: boolean, tag?: string } | null | undefined,
 *   agentOf?: (stableId: string) => Promise<string|null>, ttl?: number, now?: () => number }} deps
 *   network: the live network config (for network.guests); agentNodes: computers.tailnet; agentOf:
 *   which agent a tagged node belongs to, or null (production asks computers.node.agent).
 * @returns {(ip: string) => Promise<Identity>}
 */
export function identifier({ whois, selfIps, selfId = () => null, owner, network = () => ({}), agentNodes = () => null, agentOf = async () => null, deviceOf = null, ttl = 60_000, now = Date.now }) {
  /** @type {Map<string, { at: number, who: any }>} */
  const cache = new Map();
  return async raw => {
    const ip = normalize(raw);
    if (!isTailnet(ip)) return refused(null, null, "not a tailnet address");
    if (selfIps().map(normalize).includes(ip)) return refused(null, null, "from this box itself");
    let hit = cache.get(ip);
    if (!hit || now() - hit.at > ttl) {
      hit = { at: now(), who: await whois(ip) };
      cache.set(ip, hit);
      if (cache.size > 1000) cache.delete(/** @type {string} */ (cache.keys().next().value));
    }
    const who = hit.who;
    if (!who) return refused(null, null, "tailscale does not know this address");
    // A second check in case the address list was stale: whois naming this very node.
    const me = selfId();
    if (me && who.stableId === me) return refused(null, who.node, "from this box itself");
    return classify(who, { owner: owner(), network: network(), agentNodes: agentNodes(), agentOf, deviceOf });
  };
}

/**
 * @typedef {{ ok: boolean, kind: "owner"|"guest"|"agent"|"device"|null, login: string|null, node: string|null, stableId?: string|null,
 *   tags?: string[], caps?: Record<string, any[]>, agent?: string, device?: string, bindable?: boolean, why: string }} Identity
 */

const refused = (login, node, why) => ({ ok: false, kind: null, login, node, why });
/** ADR 0046's tag for a desktop that joined through a Wink pairing. */
export const DEVICE_TAG = "tag:vyre-device";

/**
 * Which kind of caller one whois answer is. Pure but for agentOf, so network.guests.check reports
 * exactly what the listener would do.
 * @param {any} who a parseWhois answer
 * @param {{ owner: string|null, network?: any, agentNodes?: { enabled?: boolean, tag?: string } | null, agentOf?: (stableId: string) => Promise<string|null>,
 *   deviceOf?: ((stableId: string) => Promise<string|null>) | null }} o
 * @returns {Promise<Identity>}
 */
export async function classify(who, { owner, network = {}, agentNodes = null, agentOf = async () => null, deviceOf = null }) {
  const base = { node: who.node, stableId: who.stableId || null, tags: who.tags || [], caps: who.caps || {} };
  // A desktop that joined with a tag:vyre-device key (ADR 0046) is only ever the paired device
  // its stable id was bound to, found through the relay's own table, never the tag itself: a tag
  // says which ACL bucket a node is in, not who it is. Unbound, it may only present its bind code.
  if (deviceOf && (who.tagged || !who.login) && (who.tags || []).includes(DEVICE_TAG) && who.stableId) {
    const device = await deviceOf(String(who.stableId)).catch(() => null);
    if (typeof device === "string" && /^[a-z2-7]{16}$/.test(device)) return { ok: true, kind: "device", login: null, ...base, device, why: "device" };
    return { ...refused(null, who.node, "a Vyre device node not bound to a paired device yet"), stableId: who.stableId, bindable: true };
  }
  if (who.tagged || !who.login) {
    const tag = (agentNodes && agentNodes.tag) || "tag:vyre-agent";
    if (agentNodes && agentNodes.enabled === true && owner && (who.tags || []).includes(tag) && who.stableId) {
      const agent = await agentOf(String(who.stableId)).catch(() => null);
      if (agent && AGENT_NAME.test(agent)) return { ok: true, kind: "agent", login: null, ...base, agent, why: "agent" };
    }
    return refused(null, who.node, "a tagged node, not a person");
  }
  if (owner && who.login.toLowerCase() === owner.toLowerCase()) return { ok: true, kind: "owner", login: who.login, ...base, why: "owner" };
  if (owner && isGuest(network, who)) return { ok: true, kind: "guest", login: who.login, ...base, why: "guest" };
  return refused(who.login, who.node, owner ? "not the owner" : "no owner yet");
}
