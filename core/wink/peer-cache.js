// @ts-check
// peer-cache: the synchronous `allow(deviceId)` the relay bridge's `peers` needs (core/relay/bridge.js: `peers = { allow(deviceId) sync, serve, shared }`),
// over the module tool `wink.peer.allow` (async). The answer for a device is cached; a removal or a re-pairing event refreshes it at once (a removal answers
// no immediately, before the refresh returns), and an answer older than ttlMs is refreshed in the background. A device never asked about answers no and is
// asked about now, so its next stream is let in once the answer is yes. In the Wink module itself the answer is `peers.allow` (sync, from the registry).

/**
 * @param {{ call: (tool: string, input: any) => Promise<any>, events: { on: (name: string, f: (e: any) => void) => (() => void) | void },
 *   ttlMs?: number, now?: () => number, log?: (m: string) => void }} o
 * @returns {{ allow(deviceId: string): boolean, refresh(deviceId: string): Promise<boolean>, stop(): void }}
 */
export function createPeerAllowCache(o) {
  const ttl = o.ttlMs ?? 60_000;
  const now = o.now || Date.now;
  /** @type {Map<string, { ok: boolean, at: number }>} */
  const cache = new Map();
  /** @type {Map<string, Promise<boolean>>} */
  const inflight = new Map();
  const refresh = (/** @type {string} */ id) => {
    const open = inflight.get(id);
    if (open) return open;
    const p = Promise.resolve().then(() => o.call("wink.peer.allow", { device: id })).then(r => {
      const ok = Boolean(r && r.data && r.data.allow === true);
      cache.set(id, { ok, at: now() });
      return ok;
    }, e => { if (o.log) o.log(`wink peer cache: ${/** @type {Error} */ (e).message}`); cache.set(id, { ok: false, at: now() }); return false; }).finally(() => { inflight.delete(id); });
    inflight.set(id, p);
    return p;
  };
  const idOf = (/** @type {any} */ e) => { const p = (e && e.payload) || e || {}; const v = p.device || p.id; return typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : ""; };
  const offs = ["wink.pair-done", "wink.peer-bound", "device.paired", "wink.server-adopted"].map(n => o.events.on(n, e => { const id = idOf(e); if (id) void refresh(id); else for (const k of [...cache.keys()]) void refresh(k); }));
  offs.push(...["wink.removed", "device.removed"].map(n => o.events.on(n, e => { const id = idOf(e); if (id) { cache.set(id, { ok: false, at: now() }); void refresh(id); } })));
  return {
    allow(deviceId) {
      const id = String(deviceId);
      const c = cache.get(id);
      if (!c) { void refresh(id); return false; }
      if (now() - c.at >= ttl) void refresh(id);
      return c.ok;
    },
    refresh,
    stop() { for (const f of offs) { try { if (typeof f === "function") f(); } catch { /* gone */ } } },
  };
}
