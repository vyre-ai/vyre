// @ts-check
// health: how the connection to one linked device is doing. Direct or relayed, how fast, and when
// the two last shook hands.
//
// The answer comes from the Wink node: network.wink.status through ctx.call (its per-space link, path and latency), one read. Each peer's answer is kept for a minute
// and callers that ask at the same moment share one check. There are no timers: nothing runs unless a tool asks (SPEC principle 8). A checker made with no ctx has nothing
// to read and says so.

/**
 * @typedef {"direct"|"relay"|"peer-relay"|"unknown"} Path
 * @typedef {{ path: Path, relay: string|null, latencyMs: number|null, lastHandshake: number|null, online: boolean,
 *   checkedAt: number, cached: boolean, why?: string }} Health
 */

/**
 * The answer for a node Vyre cannot check, in the contract's shape.
 * @param {string} why @param {number} at @returns {Health}
 */
export const unknown = (why, at) => ({ path: "unknown", relay: null, latencyMs: null, lastHandshake: null, online: false, checkedAt: at, cached: false, why });

/**
 * One peer's health from network.wink.status: the space whose id is the key (a link to a home), else the space that has the key among its connected peers, else the
 * one space this machine has when only one. 
 * @param {any} st the answer of network.wink.status @param {{ stableId?: string|null, ip?: string|null }} which @param {number} at @returns {Health}
 */
export function fromWink(st, { stableId, ip }, at) {
  const spaces = (st && Array.isArray(st.spaces)) ? st.spaces : [];
  const key = String(stableId || ip || "");
  const row = spaces.find((/** @type {any} */ s) => s.id === key) || spaces.find((/** @type {any} */ s) => (s.peerList || []).some((/** @type {any} */ p) => p.eid === key)) || (spaces.length === 1 ? spaces[0] : null);
  if (!row) return unknown("that device is not connected to a space here", at);
  const peer = (row.peerList || []).find((/** @type {any} */ p) => p.eid === key) || null;
  const online = row.state === "connected" || row.state === "relayed" || Boolean(peer);
  if (!online) return unknown(row.why || (row.state === "joining" ? "the link is still coming up" : "the link to this space is down"), at);
  const via = peer ? peer.via : row.path;
  const path = /** @type {Path} */ (via === "direct" || via === "relay" ? via : row.state === "relayed" ? "relay" : "direct");
  return { path, relay: null, latencyMs: peer ? null : typeof row.latencyMs === "number" ? row.latencyMs : null, lastHandshake: peer ? peer.since : row.since ?? null, online: true, checkedAt: at, cached: false };
}

/**
 * A checker with a per-peer cache. `ctx` makes it read the Wink node;
 * @param {{ ctx?: { call: (tool: string, input?: any) => Promise<any> }, now?: () => number, ttl?: number }} [opts]
 */
export function createHealth({ ctx, now = Date.now, ttl = 60_000 } = {}) {
  /** @type {Map<string, { at: number, value: Health }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<Health>>} */
  const flying = new Map();

  /** @param {{ ip?: string|null, stableId?: string|null }} which @returns {Promise<Health>} */
  async function fresh({ ip, stableId }) {
    if (ctx) {
      const r = await ctx.call("network.wink.status", { ping: true });
      return fromWink(r && typeof r === "object" && "data" in r ? r.data : r, { ip, stableId }, now());
    }
    return unknown("this machine has no network link to read yet", now());
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

/**
 * The one reachability shape every surface reads (plans/tailnet.md 3.9, C5):
 *   reach   "direct" (a direct path, whatever it took inside),
 *           "relay" (through Vyre's relay) or "none"
 *   why     a plain sentence
 *   fix     { action, label }, when one click could help
 *   since   ms, when the current reach began
 *   tailnet { path, latencyMs }, the direct path's own detail, under its own key so "relay" never
 *           means two things
 * @typedef {{ reach: "direct"|"relay"|"none", why: string, fix?: { action: string, label: string }, since: number,
 *   tailnet?: { path: Path, latencyMs: number|null } }} Reach
 */

/** The click that would help, from what went wrong. Null when nothing a person can do. */
function fixFor(why) {
  const w = String(why || "");
  if (/not paired|pair again|no longer knows/.test(w)) return { action: "pair", label: "Pair with your server" };
  if (/say which node/.test(w)) return null;
  return { action: "retry", label: "Check again" };
}

/**
 * A tailnet check reduced to the shape. `since` is when this reach began, from `sinceTracker`.
 * @param {Partial<Health>} h @param {number} since @returns {Reach}
 */
export function toReach(h, since) {
  const up = Boolean(h.online) && (h.path === "direct" || h.path === "relay" || h.path === "peer-relay") && typeof h.latencyMs === "number";
  if (up) {
    const p = /** @type {Path} */ (h.path);
    return { reach: "direct", why: `Connected to your server (${describe(h)}).`, since,
      tailnet: { path: p, latencyMs: /** @type {number} */ (h.latencyMs) } };
  }
  const why = h.why || "Your server does not answer.";
  const fix = fixFor(why);
  return { reach: "none", why, ...(fix ? { fix } : {}), since,
    ...(h.path && h.path !== "unknown" ? { tailnet: { path: h.path, latencyMs: h.latencyMs ?? null } } : {}) };
}

/**
 * Remembers when each key's reach last changed, so `since` is the start of the current reach and
 * not of the latest check. No timers.
 * @param {() => number} [now]
 */
export function sinceTracker(now = Date.now) {
  /** @type {Map<string, { reach: string, at: number }>} */
  const seen = new Map();
  return {
    /** @param {string} key @param {string} reach @returns {number} */
    at(key, reach) {
      const s = seen.get(key);
      if (s && s.reach === reach) return s.at;
      const at = now();
      seen.set(key, { reach, at });
      return at;
    },
  };
}

/**
 * A tailnet check, shaped: the old fields stay (Deck, Glass, Chat and the CLI read them) and the
 * contract's ride beside them. The old `why` was only ever set on a failure; the sentence now
 * always is, and on a failure it is the same text.
 * @param {Health} h @param {ReturnType<typeof sinceTracker>} tracker @param {string} key
 */
export function shaped(h, tracker, key) {
  const r = toReach(h, 0);
  return { ...h, ...toReach(h, tracker.at(key, r.reach)) };
}
