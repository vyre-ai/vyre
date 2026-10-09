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
    }
    await c.connect();
    return c;
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
