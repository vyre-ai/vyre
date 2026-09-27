// @ts-check
// health: how the connection to one tailnet peer is doing. Direct or relayed, how fast, and when
// the two last shook hands.
//
// Two reads of the tailscale CLI answer it: `status --json` for the peer's path and handshake,
// and one `ping` for latency (and for the path the ping took, which is the truer answer when the
// two differ). Both are cheap, but a surface that asks on every repaint would still run them
// constantly, so each peer's answer is kept for a minute and callers that ask at the same moment
// share one check. There are no timers: nothing runs unless a tool asks (SPEC principle 8).

import { run as tsRun } from "../names/tailscale.js";

const ZERO = "0001-01-01T00:00:00Z";

/**
 * @typedef {"direct"|"relay"|"peer-relay"|"unknown"} Path
 * @typedef {{ path: Path, relay: string|null, latencyMs: number|null, lastHandshake: number|null, online: boolean,
 *   checkedAt: number, cached: boolean, why?: string }} Health
 */

/**
 * One `tailscale ping` output, reduced. The lines look like
 *   pong from box (100.64.0.5) via 203.0.113.7:41641 in 23ms        (direct)
 *   pong from box (100.64.0.5) via DERP(fra) in 81ms                (relayed by a DERP server)
 *   pong from box (100.64.0.5) via peer-relay(198.51.100.4:7777:vni:3) in 30ms
 * Anything else (a timeout, an error) is an unknown path with no latency.
 * @param {string} text
 * @returns {{ path: Path, relay: string|null, endpoint: string|null, latencyMs: number|null }}
 */
export function parsePing(text) {
  const none = { path: /** @type {Path} */ ("unknown"), relay: null, endpoint: null, latencyMs: null };
  const line = String(text || "").split("\n").find(l => /^\s*pong from /.test(l));
  if (!line) return none;
  const m = /\svia\s+(\S+)\s+in\s+([\d.]+)\s*(ms|s|µs|us)\b/.exec(line);
  if (!m) return none;
  const n = Number(m[2]);
  const latencyMs = !Number.isFinite(n) ? null : m[3] === "s" ? Math.round(n * 1000) : m[3] === "ms" ? Math.round(n) : Math.max(0, Math.round(n / 1000));
  const derp = /^DERP\(([^)]*)\)$/i.exec(m[1]);
  if (derp) return { path: "relay", relay: derp[1] || null, endpoint: null, latencyMs };
  const pr = /^peer-?relay\(([^)]*)\)$/i.exec(m[1]);
  if (pr) return { path: "peer-relay", relay: null, endpoint: pr[1].replace(/:vni:\d+$/, "") || null, latencyMs };
  return { path: "direct", relay: null, endpoint: m[1], latencyMs };
}

/** RFC3339 to ms since epoch; the zero time (never) and anything unparseable are null. */
const when = s => {
  if (!s || String(s).startsWith("0001-") || s === ZERO) return null;
  const t = Date.parse(String(s));
  return Number.isFinite(t) && t > 0 ? t : null;
};

/**
 * One peer from `tailscale status --json`, by stable ID or by tailnet address. Null when the
 * status does not list it.
 * @param {any} status @param {{ stableId?: string|null, ip?: string|null }} which
 * @returns {{ online: boolean, path: Path, relay: string|null, endpoint: string|null, ip: string|null,
 *   lastHandshake: number|null, rx: number, tx: number } | null}
 */
export function peerFromStatus(status, { stableId, ip } = {}) {
  if (!status || (!stableId && !ip)) return null;
  const peers = Object.values((status && status.Peer) || {});
  const p = /** @type {any} */ (peers.find(x => x && ((stableId && x.ID === stableId) || (ip && (x.TailscaleIPs || []).includes(ip))))) || null;
  if (!p) return null;
  const cur = String(p.CurAddr || ""), peerRelay = String(p.PeerRelay || ""), relay = String(p.Relay || "");
  // CurAddr is set only while the two talk directly. Otherwise traffic goes through a peer relay
  // when one is named, else through the DERP region the peer calls home.
  const path = cur ? "direct" : peerRelay ? "peer-relay" : relay ? "relay" : "unknown";
  const ips = (p.TailscaleIPs || []).map(String);
  return {
    online: Boolean(p.Online),
    path,
    relay: path === "relay" ? relay : null,
    endpoint: cur || peerRelay || null,
    ip: ips.find(a => a.includes(".")) || ips[0] || null,
    lastHandshake: when(p.LastHandshake),
    rx: Number(p.RxBytes) || 0,
    tx: Number(p.TxBytes) || 0,
  };
}

/**
 * The answer for a node Vyre cannot check, in the contract's shape.
 * @param {string} why @param {number} at @returns {Health}
 */
export const unknown = (why, at) => ({ path: "unknown", relay: null, latencyMs: null, lastHandshake: null, online: false, checkedAt: at, cached: false, why });

/**
 * A checker with a per-peer cache. `run` is names/tailscale.js run (tests pass a fake).
 * @param {{ run?: (args: string[], opts?: { timeout?: number }) => Promise<{ code: number, out: string, err: string }>,
 *   now?: () => number, ttl?: number }} [opts]
 */
export function createHealth({ run = tsRun, now = Date.now, ttl = 60_000 } = {}) {
  /** @type {Map<string, { at: number, value: Health }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<Health>>} */
  const flying = new Map();

  /** @param {{ ip?: string|null, stableId?: string|null }} which @returns {Promise<Health>} */
  async function fresh({ ip, stableId }) {
    const s = await run(["status", "--json"], { timeout: 5000 });
    if (s.code === 127) return unknown("Tailscale is not installed here", now());
    let status;
    try { status = JSON.parse(s.out); } catch { return unknown((s.err || s.out).trim().split("\n")[0] || "tailscale status failed", now()); }
    if (status.BackendState && status.BackendState !== "Running") return unknown(`Tailscale is ${status.BackendState} here`, now());
    const peer = peerFromStatus(status, { stableId, ip });
    if (!peer) return unknown("that node is not on this tailnet", now());
    const base = { path: peer.path, relay: peer.relay, latencyMs: null, lastHandshake: peer.lastHandshake, online: peer.online };
    // An offline node has no path, whatever region it last called home.
    if (!peer.online) return { ...base, path: "unknown", relay: null, checkedAt: now(), cached: false, why: "the node is offline" };
    const addr = ip || peer.ip;
    if (!addr) return { ...base, checkedAt: now(), cached: false, why: "the node has no tailnet address" };
    const p = await run(["ping", "--c", "1", "--until-direct=false", "--timeout", "3s", addr], { timeout: 8000 });
    const pong = parsePing(`${p.out}\n${p.err}`);
    if (pong.latencyMs === null) return { ...base, checkedAt: now(), cached: false, why: "no answer to a ping in 3 s" };
    const path = pong.path !== "unknown" ? pong.path : peer.path;
    return { path, relay: path === "relay" ? pong.relay || peer.relay : null, latencyMs: pong.latencyMs,
      lastHandshake: peer.lastHandshake, online: true, checkedAt: now(), cached: false };
  }

  return {
    /**
     * The peer's health, at most one real check per peer per `ttl` however often it is asked.
     * @param {{ ip?: string|null, stableId?: string|null }} which @returns {Promise<Health>}
     */
    async check({ ip = null, stableId = null } = {}) {
      const key = String(stableId || ip || "");
      if (!key) return unknown("no node was named", now());
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return { ...hit.value, cached: true };
      const going = flying.get(key);
      if (going) return { ...(await going), cached: true };
      const p = fresh({ ip, stableId }).catch(e => unknown(String((e && e.message) || e), now()));
      flying.set(key, p);
      try {
        const value = await p;
        cache.set(key, { at: now(), value });
        return value;
      } finally { flying.delete(key); }
    },
  };
}

/**
 * The line a person reads: "direct 12 ms", "relayed via fra 80 ms", "peer relay 30 ms".
 * @param {Partial<Health>|null|undefined} h
 */
export function describe(h) {
  if (!h) return "unknown";
  const ms = typeof h.latencyMs === "number" ? ` ${h.latencyMs} ms` : "";
  if (h.path === "direct") return `direct${ms}`;
  if (h.path === "relay") return `relayed${h.relay ? ` via ${h.relay}` : ""}${ms}`;
  if (h.path === "peer-relay") return `peer relay${ms}`;
  return h.why === "the node is offline" ? "offline" : "unknown";
}
