// @ts-check
// cdp: one long-lived Chrome DevTools Protocol connection per computer.
//
// The measured design this ports (the prototype's bin/macd.cjs): a CDP call costs a fraction of a
// millisecond once the socket is open, but opening a new one for every call costs tens of
// milliseconds of TCP and WebSocket handshake, twenty calls apart the difference between six
// milliseconds and the better part of a second. So one connection is made per agent's computer
// and reused for navigate, click, type, screenshot and evaluate; it reconnects only when the
// socket actually drops.
//
// Chrome's own debugging port is never reachable directly (it is loopback-only inside the
// container): this goes through computerd's authenticated `/cdp/...` proxy instead, the same
// helper `computers.endpoint` hands hands-desktop its token for. `cdpUrl` is computerd's own
// `helper.url` with `/cdp` on it; `/json/version` is fetched with the bearer token, and the
// `webSocketDebuggerUrl` computerd hands back already points back through that same proxy, so
// connecting it needs only the token appended as `?token=` — a plain WebSocket cannot carry a
// header, which is the one thing computerd's usual `Authorization: Bearer` check cannot ask of
// it. One connection is kept per agent's computer and reused for navigate, click, type,
// screenshot and evaluate; it reconnects only when the socket actually drops. Flattened
// auto-attach means one browser-level connection reaches every target with a `sessionId`, so a
// second tab never needs a second socket.

const CALL_TIMEOUT = 30_000;
const CONNECT_TIMEOUT = 10_000;

export class CdpError extends Error {
  /** @param {string} message @param {{ method?: string }} [o] */
  constructor(message, o = {}) {
    super(message);
    this.name = "CdpError";
    this.method = o.method;
  }
}

/**
 * One WebSocket to a Chrome instance's browser endpoint, reused across calls.
 * @param {{ cdpUrl: string, token?: string, fetch?: typeof fetch, WebSocket?: typeof WebSocket, onEvent?: (m: any) => void }} o
 */
export class Cdp {
  constructor(o) {
    this.base = String(o.cdpUrl || "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(this.base)) throw new CdpError("no CDP address: the computer's endpoint did not say where Chrome answers");
    this.token = o.token ? String(o.token) : "";
    this.fetchImpl = o.fetch || fetch;
    this.WS = o.WebSocket || WebSocket;
    /** @type {Array<(m: any) => void>} every listener sees every event; waitFor adds one of its own. */
    this.listeners = o.onEvent ? [o.onEvent] : [];
    /** @type {WebSocket|null} */
    this.ws = null;
    this.seq = 0;
    /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, method: string }>} */
    this.pending = new Map();
    /** @type {Promise<void>|null} */
    this.connecting = null;
  }

  /** Subscribe to every CDP event. Returns an unsubscribe function. */
  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }

  /**
   * Resolve the next event a predicate accepts, or after `ms` resolve anyway (a load event is a
   * courtesy, not a promise every page keeps: one that never fires must not hang the caller).
   * @param {(m: any) => boolean} predicate @param {number} [ms]
   */
  waitFor(predicate, ms = 15_000) {
    return new Promise(resolve => {
      let done = false;
      const off = this.on(m => { if (!done && predicate(m)) { done = true; off(); clearTimeout(timer); resolve(m); } });
      const timer = setTimeout(() => { if (!done) { done = true; off(); resolve(null); } }, ms);
    });
  }

  /** Resolve the browser's WebSocket debugger URL and open it, once, reused after. */
  async connect() {
    if (this.ws && this.ws.readyState === this.WS.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Never let the token reach a thrown message: it would otherwise land wherever an error does. */
  scrub(s) { return this.token ? String(s).split(this.token).join("[token]") : String(s); }

  async _connect() {
    /** @type {Response} */
    let res;
    try {
      res = await this.fetchImpl(this.base + "/json/version",
        { signal: AbortSignal.timeout(CONNECT_TIMEOUT), headers: this.token ? { authorization: `Bearer ${this.token}` } : {} });
    } catch (e) { throw new CdpError(this.scrub(`could not reach Chrome at ${this.base}: ${/** @type {Error} */ (e).message}`)); }
    if (res.status === 401 || res.status === 403) throw new CdpError(`Chrome at ${this.base} refused /json/version: the helper token was not accepted (HTTP ${res.status}). The computer may have been recreated; ask computers.endpoint again.`);
    if (!res.ok) throw new CdpError(`Chrome at ${this.base} answered /json/version with HTTP ${res.status}`);
    const info = await res.json();
    const wsUrl = info && info.webSocketDebuggerUrl;
    if (!wsUrl) throw new CdpError(`Chrome at ${this.base} did not offer a WebSocket debugger URL`);
    // A plain WebSocket cannot carry an Authorization header, so the token rides the URL instead,
    // for computerd's WS-upgrade proxy alone to read: never logged, never in an error past here.
    const authed = this.token ? wsUrl + (wsUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(this.token) : wsUrl;

    const ws = new this.WS(authed);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new CdpError(`Chrome at ${this.base} did not finish the WebSocket handshake in time`)), CONNECT_TIMEOUT);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(undefined); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new CdpError(`could not open a CDP connection to ${this.base}`)); }, { once: true });
    });
    ws.addEventListener("message", ev => this._onMessage(ev));
    ws.addEventListener("close", () => this._onClose());
    this.ws = ws;

    // Flattened auto-attach: every tab and every iframe arrives as a sessionId on this one
    // connection instead of a socket of its own (macd.cjs's finding, ported unchanged).
    await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await this.send("Target.setDiscoverTargets", { discover: true });
  }

  _onMessage(ev) {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const { resolve, reject } = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) reject(new CdpError(m.error.message || "CDP error"));
      else resolve(m.result);
    } else if (m.method) {
      for (const fn of this.listeners) { try { fn(m); } catch {} }
    }
  }

  _onClose() {
    this.ws = null;
    const err = new CdpError("the CDP connection closed");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /**
   * @param {string} method
   * @param {any} [params]
   * @param {string} [sessionId] which tab; omitted means the browser target itself
   */
  async send(method, params = {}, sessionId) {
    await this.connect();
    const id = ++this.seq;
    /** @type {any} */
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const ws = /** @type {WebSocket} */ (this.ws);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new CdpError(`CDP call timed out: ${method}`, { method })); }
      }, CALL_TIMEOUT);
      this.pending.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v); },
        reject: e => { clearTimeout(timer); reject(e); },
        method,
      });
      try { ws.send(JSON.stringify(msg)); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(new CdpError(`could not send ${method}: ${/** @type {Error} */ (e).message}`)); }
    });
  }

  /** The first page target's sessionId, attaching one if none exists yet. */
  async page() {
    await this.connect();
    if (this.sessionId) return this.sessionId;
    const { targetInfos } = await this.send("Target.getTargets");
    let target = (targetInfos || []).find(t => t.type === "page" && !t.url.startsWith("devtools://"));
    if (!target) {
      const { targetId } = await this.send("Target.createTarget", { url: "about:blank" });
      target = { targetId };
    }
    const { sessionId } = await this.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("DOM.enable", {}, sessionId);
    return sessionId;
  }

  async close() {
    if (this.ws) { try { this.ws.close(); } catch {} }
    this.ws = null;
  }
}

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
