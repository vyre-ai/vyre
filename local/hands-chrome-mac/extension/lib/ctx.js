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
import { createFrames } from "./frames.js";
import * as floor from "./floor.js";
import { err } from "./err.js";
import { dispatch } from "../caps/index.js";

/**
 * @param {{ chrome: any, emit?: (evt: any) => void }} o
 */
export function createCtx({ chrome, emit = () => {} }) {
  const cdp = createCdp({ chrome, emit });
  const frames = createFrames({ cdp });
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
    /**
     * Wait until a tab has COMMITTED to a page and finished loading (status complete, an address, nothing pending), or the time is up.
     * Never throws for a slow page: it returns what the tab looks like at the end. @param {number} id @param {number} [ms]
     * @returns {Promise<{ tab: any, settled: boolean, waitedMs: number }>}
     */
    async settle(id, ms = 15_000) {
      const t0 = Date.now();
      /** @type {any} */ let tab = null;
      for (;;) {
        try { tab = await chrome.tabs.get(id); } catch { tab = null; }
        const url = tab ? String(tab.url || "") : "";
        if (tab && tab.status === "complete" && url && !tab.pendingUrl) return { tab, settled: true, waitedMs: Date.now() - t0 };
        if (!tab) return { tab: null, settled: false, waitedMs: Date.now() - t0 };
        if (Date.now() - t0 >= ms) return { tab, settled: false, waitedMs: Date.now() - t0 };
        await new Promise(r => setTimeout(r, 80));
      }
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
     * Block EVERY request of one tab (all resource types except the main frame's own navigation, which the Fetch guard judges) to anything not in the allow list, at the network
     * level, in every frame of the tab including one a script just made. The allow list is exact origins (scheme, host AND port) as higher-priority ALLOW rules, not hostnames:
     * a hostname list would also allow other ports and every subdomain. `ok` is false when the browser could not set the rules (no API, or it refused).
     * @param {{ tab: number, allowOrigins?: string[], allowHosts?: string[] }} o @returns {Promise<{ id: number|null, ids: number[], ok: boolean, why?: string }>}
     */
    async block({ tab, allowOrigins = [], initiatorHosts = [] }) {
      const api = dnrApi();
      if (!api) return { id: null, ids: [], ok: false, why: "this browser has no declarativeNetRequest" };
      const next = () => (ruleSeq >= RULE_MAX ? (ruleSeq = RULE_MIN) : ++ruleSeq);
      const TYPES = ["sub_frame", "stylesheet", "script", "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport", "webbundle", "other"];
      const origins = [...new Set(allowOrigins)].filter(o => /^https?:\/\/[^/\s*^|?]+$/.test(o)).slice(0, 200);
      // A second pair for requests that belong to no tab (tabId -1: a shared or service worker's own fetches), scoped by the INITIATOR's host so other sites' workers are left alone.
      const hosts = [...new Set(initiatorHosts)].filter(h => /^[a-z0-9.\-]+$/i.test(h)).slice(0, 50);
      /** @type {any[]} */ const rules = [];
      const scopes = [{ tabIds: [tab] }, ...(hosts.length ? [{ tabIds: [-1], initiatorDomains: hosts }] : [])];
      const blockId = next();
      let first = true;
      for (const scope of scopes) {
        rules.push({ id: first ? blockId : next(), priority: 1, action: { type: "block" }, condition: { ...scope, resourceTypes: TYPES } });
        first = false;
        for (const o of origins) rules.push({ id: next(), priority: 2, action: { type: "allow" }, condition: { ...scope, urlFilter: `|${o}/`, resourceTypes: TYPES } });
      }
      const ids = rules.map(r => r.id);
      try { await api.updateSessionRules({ removeRuleIds: ids, addRules: rules }); } catch (e) { return { id: null, ids: [], ok: false, why: String(/** @type {Error} */ (e).message || e).slice(0, 160) }; }
      // CONFIRMED, not assumed: every rule reads back, and (where the browser offers testMatchOutcome, unpacked extensions) an Image and an XHR to a fresh origin from this tab match the block.
      try {
        const have = new Set((await api.getSessionRules()).map((/** @type {any} */ r) => r.id));
        if (!ids.every(id => have.has(id))) { await this.unblock(ids); return { id: null, ids: [], ok: false, why: "the rules did not read back" }; }
        if (typeof api.testMatchOutcome === "function") {
          const allowIds = new Set(rules.filter(r => r.action.type === "allow").map(r => r.id));
          for (const type of ["image", "xmlhttprequest"]) {
            const out = await api.testMatchOutcome({ url: "https://vyre-dnr-probe.invalid/x", type, tabId: tab, initiator: origins[0] || "https://vyre-dnr-probe.invalid" });
            const m = (out && out.matchedRules) || [];
            if (!m.some((/** @type {any} */ x) => x.ruleId === blockId) || m.some((/** @type {any} */ x) => allowIds.has(x.ruleId))) { await this.unblock(ids); return { id: null, ids: [], ok: false, why: `the ${type} test request was not blocked by the rule` }; }
          }
        }
      } catch (e) { await this.unblock(ids); return { id: null, ids: [], ok: false, why: "the rules could not be confirmed: " + String(/** @type {Error} */ (e).message || e).slice(0, 120) }; }
      return { id: blockId, ids, ok: true };
    },
    /** @param {number|number[]|null} ids */
    async unblock(ids) {
      const api = dnrApi();
      const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
      if (!list.length || !api) return;
      try { await api.updateSessionRules({ removeRuleIds: list }); } catch { /* already gone */ }
    },
  };
  void dnr.sweep();

  /** @returns {Promise<floor.FloorConfig>} */
  async function floorConfig() {
    return { blind: (await storage.get("local", "floor.blind")) || [], readonly: (await storage.get("local", "floor.readonly")) || [] };
  }

  /** @type {any} */
  const ctx = {
    cdp, tabs, storage, dnr, frames,
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
    /** @param {string} op @param {any} [args] @param {any} [trust] what the caller was approved for; never inside args */
    call: (op, args, trust) => dispatch(op, args || {}, ctx, trust),
  };
  return ctx;
}
