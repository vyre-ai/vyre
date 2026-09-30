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
  let ruleSeq = 0;
  const dnr = {
    /**
     * Block WebSockets, beacons and "other" requests of one tab to any host not in `allowHosts`. Returns an id for unblock(), or null.
     * @param {{ tab: number, allowHosts: string[] }} o
     */
    async block({ tab, allowHosts }) {
      const api = chrome.declarativeNetRequest;
      if (!api || !api.updateSessionRules) return null;
      const id = 800000 + ((++ruleSeq + Date.now()) % 100000);
      const rule = { id, priority: 1, action: { type: "block" }, condition: { tabIds: [tab], resourceTypes: ["websocket", "ping", "other"], ...(allowHosts.length ? { excludedRequestDomains: allowHosts } : {}) } };
      try { await api.updateSessionRules({ addRules: [rule] }); return id; } catch { return null; }
    },
    /** @param {number|null} id */
    async unblock(id) {
      const api = chrome.declarativeNetRequest;
      if (id == null || !api || !api.updateSessionRules) return;
      try { await api.updateSessionRules({ removeRuleIds: [id] }); } catch { /* already gone */ }
    },
  };

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
