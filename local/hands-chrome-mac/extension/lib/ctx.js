// @ts-check
// ctx: the one object a capability receives (ADR 0049). Kept small and stable because other
// teams write capabilities against it:
//
//   ctx.cdp        attach / send / on / detach / attached          (lib/cdp.js)
//   ctx.tabs       query / get / update / create / remove / active / focusWindow
//   ctx.emit(evt)  push an unsolicited {event, ...} to the module (redacted by the shell)
//   ctx.stopped()  true while the person's stop is in force
//   ctx.floorAllows(tabId, op) -> Promise<{allow, tier, why}>     (async: it reads the tab's URL)
//   ctx.floorUrl(url, op)      -> Promise<{allow, tier, why}>     same, for a URL not yet open
//   ctx.storage    get(area, key) / set(area, obj), area "local" | "session"
//   ctx.call(op, args)         run another op through the registry (floor and stop still apply)
//   ctx.setStopped(bool)       the shell's, set from the module's stop and resume events

import { createCdp } from "./cdp.js";
import * as floor from "./floor.js";
import { err } from "./err.js";
import { dispatch } from "../caps/index.js";

/**
 * @param {{ chrome: any, emit?: (evt: any) => void }} o
 */
export function createCtx({ chrome, emit = () => {} }) {
  const cdp = createCdp({ chrome, emit });
  let stopped = false;

  const storage = {
    /** @param {"local"|"session"} area @param {string} key */
    async get(area, key) { const r = await chrome.storage[area].get(key); return r ? r[key] : undefined; },
    /** @param {"local"|"session"} area @param {Record<string, any>} obj */
    async set(area, obj) { await chrome.storage[area].set(obj); },
  };

  const tabs = {
    /** @param {any} [q] @returns {Promise<any[]>} */
    query: q => chrome.tabs.query(q || {}),
    /** @param {number} id */
    async get(id) {
      try { return await chrome.tabs.get(id); } catch { throw err("no_tab", `no tab ${id}`); }
    },
    /** @param {number} id @param {any} props */
    update: (id, props) => chrome.tabs.update(id, props),
    /** @param {any} props */
    create: props => chrome.tabs.create(props),
    /** @param {number|number[]} ids */
    remove: ids => chrome.tabs.remove(ids),
    /** The active tab of the window the person last used, or null. */
    async active() {
      const a = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (a && a[0]) return a[0];
      const b = await chrome.tabs.query({ active: true, currentWindow: true });
      return (b && b[0]) || null;
    },
    /** @param {number} windowId */
    async focusWindow(windowId) { if (chrome.windows?.update) await chrome.windows.update(windowId, { focused: true }); },
  };

  // ctx.dnr: a browser-level block on a tab (chrome.declarativeNetRequest session rules). It sees WebSocket handshakes and
  // beacons from every frame of the tab, including a fresh iframe, which no page shim can. Absent in a browser without it.
  // Rule ids live in 800000..899999. A monotonic counter never repeats within a run, so two tabs guarded at once cannot collide,
  // and a worker that starts again clears whatever a crashed guard left behind (a stale rule would keep blocking a tab's sockets).
  const RULE_MIN = 800000, RULE_MAX = 899999;
  let ruleSeq = RULE_MIN;
  const dnrApi = () => chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules ? chrome.declarativeNetRequest : null;
  const dnr = {
    /** Remove every leftover rule of ours. */
    async sweep() {
      const api = dnrApi();
      if (!api || !api.getSessionRules) return;
      try { const old = (await api.getSessionRules()).map((/** @type {any} */ r) => r.id).filter((/** @type {number} */ id) => id >= RULE_MIN && id <= RULE_MAX); if (old.length) await api.updateSessionRules({ removeRuleIds: old }); } catch { /* nothing to clear */ }
    },
    /**
     * Block WebSockets, beacons and "other" requests of one tab to any host not in `allowHosts`. `ok` is false when the browser
     * could not set the rule (no API, or it refused): the caller then reports the containment as partial.
     * @param {{ tab: number, allowHosts: string[] }} o @returns {Promise<{ id: number|null, ok: boolean, why?: string }>}
     */
    async block({ tab, allowHosts }) {
      const api = dnrApi();
      if (!api) return { id: null, ok: false, why: "this browser has no declarativeNetRequest" };
      const id = ruleSeq >= RULE_MAX ? (ruleSeq = RULE_MIN) : ++ruleSeq;
      const rule = { id, priority: 1, action: { type: "block" }, condition: { tabIds: [tab], resourceTypes: ["websocket", "ping", "other"], ...(allowHosts.length ? { excludedRequestDomains: allowHosts } : {}) } };
      try { await api.updateSessionRules({ removeRuleIds: [id], addRules: [rule] }); return { id, ok: true }; } catch (e) { return { id: null, ok: false, why: String(/** @type {Error} */ (e).message || e).slice(0, 120) }; }
    },
    /** @param {number|null} id */
    async unblock(id) {
      const api = dnrApi();
      if (id == null || !api) return;
      try { await api.updateSessionRules({ removeRuleIds: [id] }); } catch { /* already gone */ }
    },
  };
  void dnr.sweep();

  /** @returns {Promise<floor.FloorConfig>} */
  async function floorConfig() {
    return { blind: (await storage.get("local", "floor.blind")) || [], readonly: (await storage.get("local", "floor.readonly")) || [] };
  }

  /** @type {any} */
  const ctx = {
    cdp, tabs, storage, dnr,
    emit,
    stopped: () => stopped,
    setStopped: (/** @type {boolean} */ v) => { stopped = !!v; if (stopped) ctx.stoppedAt = Date.now(); },
    /** @param {number} tabId @param {string} op */
    async floorAllows(tabId, op) {
      const tab = await tabs.get(tabId);
      return floor.decide(tab.pendingUrl || tab.url, op, await floorConfig());
    },
    /** The floor's tier for many URLs at once: the person's lists are read once, not per URL. */
    async floorTier() { const cfg = await floorConfig(); return (/** @type {string} */ url) => floor.tierOf(url, cfg).tier; },
    /** @param {string} url @param {string} op */
    async floorUrl(url, op) { return floor.decide(url, op, await floorConfig()); },
    /** @param {string} op @param {any} [args] */
    call: (op, args) => dispatch(op, args || {}, ctx),
  };
  return ctx;
}
