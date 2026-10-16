// @ts-check
// chrome.api on the box: learn and catalog from CDP network traffic (lib/siteops/apilearn.js).

import { learn, mergeCatalog } from "../../lib/siteops/apilearn.js";

const QUIET_MS = 800;
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {import("./siteops.js").CdpLike} cdp @param {string} sessionId
 */
export function watchApiTraffic(cdp, sessionId) {
  /** @type {Map<string, any>} */
  const pending = new Map();
  /** @type {any[]} */
  const records = [];
  const off = cdp.on(m => {
    if (m.sessionId && m.sessionId !== sessionId) return;
    const p = m.params || {};
    if (m.method === "Network.requestWillBeSent") {
      const req = p.request || {};
      pending.set(p.requestId, {
        method: req.method || "GET",
        url: req.url || "",
        type: p.type || "other",
        requestHeaders: req.headers || {},
        postData: req.postData,
      });
    } else if (m.method === "Network.responseReceived") {
      const base = pending.get(p.requestId);
      if (!base) return;
      records.push({ ...base, status: (p.response && p.response.status) || 0 });
      pending.delete(p.requestId);
    }
  });
  return {
    async start() { await cdp.send("Network.enable", {}, sessionId); },
    async collect(ms = QUIET_MS) {
      const n0 = records.length;
      await sleep(ms);
      return records.slice(n0);
    },
    stop: off,
    all: () => records.slice(),
  };
}

/** @param {string} url */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

/**
 * @param {Map<string, any[]>} store agent|host -> catalog entries
 * @param {string} agent @param {string} host @param {any[]} fresh
 */
export function mergeApiCatalog(store, agent, host, fresh) {
  const key = `${agent}|${host}`;
  const merged = mergeCatalog(store.get(key) || [], learn(fresh));
  store.set(key, merged);
  return merged;
}
