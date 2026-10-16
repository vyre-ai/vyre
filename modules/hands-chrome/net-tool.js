// @ts-check
// chrome.net on the box: capture page traffic through CDP (shared browser or desktop), credentials masked.

import { bareUrl } from "./index.js";

const QUIET_MS = 800;
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {import("./siteops.js").CdpLike} cdp @param {string} sessionId
 */
export function watchNetwork(cdp, sessionId) {
  /** @type {any[]} */
  const order = [];
  const off = cdp.on(m => {
    if (m.sessionId && m.sessionId !== sessionId) return;
    if (m.method !== "Network.requestWillBeSent") return;
    const p = m.params || {};
    const url = p.request && p.request.url || "";
    order.push({ method: p.request && p.request.method || "GET", url: bareUrl(url), type: String(p.type || "other") });
    if (order.length > 200) order.shift();
  });
  return {
    async start() { await cdp.send("Network.enable", {}, sessionId); },
    stop: off,
    list: () => order.slice().reverse(),
  };
}
