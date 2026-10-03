// @ts-check
// The watcher bridge: watchers (core/watchers, a 0.2 module the daemon runs) emit daemon events, not kernel events, so a Flow armed on a watcher never heard of them. This is the
// thin adapter that listens on the watchers module's own events and forwards each new item to `runner.watcherItem`. It imports nothing from core/: the host gives it ports.
//
//   const stop = bridgeWatchers({ runner, on, call, log });
//   on("watcher.fired", fn)            the daemon's event subscription (ctx.events.on), called with { name, items, ... }
//   call("watchers.items", { name, limit })   a tool call as the Flows module (ctx.call): the items watchers filed, newest first
//
// A watcher's `watcher.fired` says how many new items it filed (`items`); the items themselves are read back through `watchers.items`, as the Flows module, so what a Flow sees is
// what that tool lets this caller see (scoped, never wider). Each item reaches the runner once: a redelivery is the same run (the runner keys a run by watcher and item id).

/**
 * @param {{ runner: { watcherItem(w: { watcher: string, item: any, trust?: string }): Promise<any> },
 *   on: (type: string, fn: (payload: any, where?: any) => any) => (() => void) | void,
 *   call: (tool: string, input: any) => Promise<any>,
 *   log?: (m: string) => void }} ports
 * @returns {() => void} stop listening
 */
export function bridgeWatchers(ports) {
  const log = ports.log || (() => {});
  const seen = new Set();
  const stop = ports.on("watcher.fired", async (p) => {
    try {
      if (!p || typeof p.name !== "string" || !(p.items > 0)) return;
      const r = await ports.call("watchers.items", { name: p.name, limit: Math.min(100, Number(p.items) || 1) });
      const rows = Array.isArray(r) ? r : r && Array.isArray(r.data) ? r.data : [];
      // newest first: hand them over oldest first, so runs start in the order things happened
      for (const row of rows.slice(0, Number(p.items)).reverse()) {
        const item = row && typeof row.data === "string" ? safeJson(row.data) || row : row;
        const id = item && (item.id ?? row.id);
        const key = `${p.name}/${String(id)}`;
        if (id === undefined || seen.has(key)) continue;
        seen.add(key); if (seen.size > 5000) seen.delete(seen.values().next().value);
        await ports.runner.watcherItem({ watcher: p.name, item });
      }
    } catch (e) { log(`flows: watcher ${p && p.name}: ${/** @type {Error} */ (e).message}`); }
  });
  return () => { if (typeof stop === "function") stop(); };
}

/** @param {string} t */
function safeJson(t) { try { return JSON.parse(t); } catch { return null; } }
