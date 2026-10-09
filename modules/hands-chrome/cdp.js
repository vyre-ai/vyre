// @ts-check
// hands-chrome's CDP side: the connection itself is lib/cdp.js (shared with the vault's fill of an agent's computer); this file keeps the per-agent pool.

import { Cdp, CdpError } from "../../lib/cdp.js";
export { Cdp, CdpError };

/**
 * A pool of Cdp connections, one per agent, reused across tool calls. A dead socket is dropped
 * and reconnected on next use rather than reused, since a stale sessionId from before a Chrome
 * restart would otherwise fail every call with an opaque error.
 */
export class CdpPool {
  /** @param {{ WebSocket?: typeof WebSocket, fetch?: typeof fetch, onEvent?: (agent: string, m: any) => void }} [o] */
  constructor(o = {}) {
    this.WS = o.WebSocket || WebSocket;
    this.fetchImpl = o.fetch || fetch;
    this.onEvent = o.onEvent || (() => {});
    /** @type {Map<string, Cdp>} */
    this.byAgent = new Map();
    /** @type {Map<string, string>} the tab to prefer for an agent whose connection is not made yet */
    this.wanted = new Map();
  }

  /** @param {string} agent @param {string} cdpUrl @param {string} [token] */
  async get(agent, cdpUrl, token) {
    let c = this.byAgent.get(agent);
    // A recreated computer gets a fresh helper token as well as a fresh address (pool.js's
    // ensure()); either changing means the old connection is talking to a dead computer.
    if (c && (c.base !== String(cdpUrl).replace(/\/+$/, "") || c.token !== String(token || ""))) { await c.close(); c = undefined; }
    if (c && c.ws && c.ws.readyState === this.WS.OPEN) return c;
    if (!c) {
      c = new Cdp({ cdpUrl, token, WebSocket: this.WS, fetch: this.fetchImpl, onEvent: m => this.onEvent(agent, m) });
      this.byAgent.set(agent, c);
      const want = this.wanted.get(agent);
      if (want) { c.prefer = want; this.wanted.delete(agent); }
    }
    await c.connect();
    return c;
  }

  /** The tab the hands should work in from now on (the one a Vault sign-in earned a session in); the next page() attaches to it if it is still there. @param {string} agent @param {string} targetId */
  prefer(agent, targetId) {
    const c = this.byAgent.get(agent);
    if (!c) { this.wanted.set(agent, targetId); return; }
    c.prefer = targetId; c.sessionId = null;
  }

  /** @param {string} agent */
  async drop(agent) {
    const c = this.byAgent.get(agent);
    if (!c) return;
    this.byAgent.delete(agent);
    await c.close();
  }

  async closeAll() {
    for (const [, c] of this.byAgent) await c.close();
    this.byAgent.clear();
  }
}
