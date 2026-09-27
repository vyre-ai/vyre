// @ts-check
// fake-cf: just enough of the Cloudflare Workers runtime to run relay/worker/index.js under
// node:test. WebSocketPair, the Hibernation API on a fake ctx (acceptWebSocket, tags, attachments,
// getWebSockets, setWebSocketAutoResponse), an async Map for ctx.storage with Cloudflare's size
// limits, a DO namespace, and a browser-style WebSocket class that connects through the Worker.
//
// Hibernation is simulated by throwing the DO instance away and constructing a new one over the
// same ctx: `hibernate()` between events, or `hibernateEveryEvent` to do it after every event.
// Attachments and storage values are structured-cloned, as the real runtime serializes them.

const OPEN = 1, CLOSING = 2, CLOSED = 3;
const MAX_ATTACHMENT = 2048;
const MAX_VALUE = 128 * 1024;

/** @param {any} data */
const copy = data => {
  if (typeof data === "string") return data;
  const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
  return view.slice().buffer;
};

/** One end of a WebSocketPair. Events wait until something listens, as a Worker's client end waits for accept(). */
export class End {
  constructor() {
    /** @type {End|null} */ this.peer = null;
    this.readyState = OPEN;
    this.closeReceived = false;
    /** @type {any} */ this.att = null;
    /** @type {string[]} */ this.tags = [];
    /** @type {any} set by acceptWebSocket */ this.ctx = null;
    /** @type {((type: string, ev: any) => void)|null} */ this.listener = null;
    /** @type {Array<[string, any]>} */ this.pending = [];
  }
  /** @param {(type: string, ev: any) => void} fn */
  listen(fn) { this.listener = fn; for (const [t, e] of this.pending.splice(0)) fn(t, e); }
  emit(type, ev) { this.listener ? this.listener(type, ev) : this.pending.push([type, ev]); }
  /** @param {any} data */
  send(data) {
    if (this.readyState !== OPEN) throw new Error("Can't call WebSocket send() after close().");
    const peer = /** @type {End} */ (this.peer), v = copy(data);
    setImmediate(() => peer.receive(v));
  }
  receive(data) {
    if (this.readyState === CLOSED) return;
    const auto = this.ctx && this.ctx.auto;
    // The edge answers the auto-response pair itself: the object is not constructed or woken.
    if (auto && data === auto.request && this.readyState === OPEN) { this.ctx.autoAnswered++; this.send(auto.response); return; }
    this.emit("message", data);
  }
  close(code, reason = "") {
    if (this.readyState === CLOSED) return;
    if (code !== undefined && code !== 1000 && !(code >= 3000 && code <= 4999) && code !== 1009 && code !== 1001) throw new Error(`invalid close code ${code}`);
    const peer = /** @type {End} */ (this.peer);
    if (this.closeReceived) { this.readyState = CLOSED; peer.receiveClose(code ?? 1005, reason); return; }
    if (this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    setImmediate(() => peer.receiveClose(code ?? 1005, reason));
  }
  receiveClose(code, reason) {
    if (this.readyState === CLOSED) return;
    if (this.readyState === CLOSING && !this.closeReceived) { this.readyState = CLOSED; this.emit("close", { code, reason, ack: true }); return; }
    this.closeReceived = true;
    this.readyState = CLOSING;
    this.emit("close", { code, reason, ack: false });
  }
  serializeAttachment(v) {
    const s = JSON.stringify(v);
    if (s && s.length > MAX_ATTACHMENT) throw new Error("attachment over 2 KiB");
    this.att = structuredClone(v);
  }
  deserializeAttachment() { return this.att === null ? null : structuredClone(this.att); }
}

export class WebSocketPair {
  constructor() {
    const a = new End(), b = new End();
    a.peer = b; b.peer = a;
    this[0] = a; this[1] = b;
  }
}

export class WebSocketRequestResponsePair {
  /** @param {string} request @param {string} response */
  constructor(request, response) { this.request = request; this.response = response; }
}

/** ctx.storage: an async Map with the KV API's per-value and per-call limits. */
export class FakeStorage {
  constructor() { /** @type {Map<string, any>} */ this.map = new Map(); this.writes = 0; }
  async get(key) { return structuredClone(this.map.get(key)); }
  async put(key, value) {
    const entries = typeof key === "string" ? [[key, value]] : Object.entries(key);
    if (entries.length > 128) throw new Error("put: at most 128 keys");
    for (const [k, v] of entries) {
      const bytes = ArrayBuffer.isView(v) ? v.byteLength : JSON.stringify(v).length;
      if (bytes > MAX_VALUE) throw new Error(`value for ${k} is over 128 KiB`);
    }
    for (const [k, v] of entries) { this.map.set(k, structuredClone(v)); this.writes++; }
  }
  async delete(key) {
    const keys = Array.isArray(key) ? key : [key];
    if (keys.length > 128) throw new Error("delete: at most 128 keys");
    let n = 0;
    for (const k of keys) if (this.map.delete(k)) n++;
    return Array.isArray(key) ? n : n > 0;
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, structuredClone(v)]));
  }
}

/**
 * Patches globalThis with what a Worker expects: WebSocketPair, WebSocketRequestResponsePair, and a
 * Response that takes status 101 with a webSocket (Node's refuses 101).
 */
export function install() {
  const g = /** @type {any} */ (globalThis);
  if (g.__fakeCf) return;
  g.__fakeCf = true;
  g.WebSocketPair = WebSocketPair;
  g.WebSocketRequestResponsePair = WebSocketRequestResponsePair;
  const Base = g.Response;
  g.Response = class Response extends Base {
    constructor(body, init = {}) {
      super(body, init.status === 101 ? { ...init, status: 200 } : init);
      if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
      this.webSocket = init.webSocket || null;
    }
  };
}

/**
 * A fake Workers runtime around one Worker module.
 * @param {{ worker: any, Class: any, env?: Record<string, any>, hibernateEveryEvent?: boolean }} o
 */
export function createRuntime(o) {
  install();
  /** @type {Error[]} */
  const errors = [];
  /** @type {Map<string, any>} */
  const objects = new Map();
  let constructed = 0;

  const object = name => {
    let obj = objects.get(name);
    if (obj) return obj;
    /** @type {Set<End>} */
    const sockets = new Set();
    const ctx = {
      id: { toString: () => name },
      storage: new FakeStorage(),
      auto: /** @type {WebSocketRequestResponsePair|null} */ (null),
      autoAnswered: 0,
      setWebSocketAutoResponse(pair) { ctx.auto = pair || null; },
      getWebSocketAutoResponse() { return ctx.auto; },
      /** @param {End} ws @param {string[]} [tags] */
      acceptWebSocket(ws, tags = []) {
        if (!(ws instanceof End) || ws.ctx) throw new Error("acceptWebSocket: not a fresh server end");
        if (tags.length > 10 || tags.some(t => typeof t !== "string" || t.length > 256)) throw new Error("acceptWebSocket: bad tags");
        ws.ctx = ctx;
        ws.tags = [...tags];
        sockets.add(ws);
        ws.listen((type, ev) => {
          if (type === "message") { run(inst => inst.webSocketMessage(ws, ev)); return; }
          run(async inst => { await inst.webSocketClose(ws, ev.code, ev.reason, true); }).then(() => {
            // Compatibility dates from 2026 reply to a close for the object if it did not.
            if (!ev.ack && ws.readyState !== CLOSED) { ws.readyState = CLOSED; /** @type {End} */ (ws.peer).receiveClose(ev.code, ev.reason); }
            sockets.delete(ws);
          });
        });
      },
      /** @param {string} [tag] */
      getWebSockets(tag) { return [...sockets].filter(s => s.readyState !== CLOSED && (tag === undefined || s.tags.includes(tag))); },
    };
    let queue = Promise.resolve();
    /** @param {(inst: any) => any} fn */
    const run = fn => {
      const p = queue.then(async () => {
        if (!obj.instance) { obj.instance = new o.Class(ctx, env); constructed++; }
        try { return await fn(obj.instance); } finally { if (o.hibernateEveryEvent) obj.instance = null; }
      });
      queue = p.then(() => {}, e => { errors.push(e); });
      return p;
    };
    obj = { name, ctx, sockets, instance: null, run, idle: () => queue };
    objects.set(name, obj);
    return obj;
  };

  const env = {
    ...(o.env || {}),
    ROUTES: {
      idFromName: name => ({ name, toString: () => name }),
      get: id => ({ fetch: request => object(id.name).run(inst => inst.fetch(request)) }),
    },
  };

  /** @param {string} url @param {Record<string, string>} [headers] */
  const fetch = (url, headers = {}) => o.worker.fetch(new Request(url.replace(/^ws/, "http"), { headers }), env);

  /** A browser-style WebSocket that connects through the Worker. */
  class FakeWebSocket {
    /** @param {string} url */
    constructor(url, ip = "203.0.113.7") {
      this.url = url;
      this.readyState = 0;
      this.binaryType = "blob";
      /** @type {any} */ this.onopen = null;
      /** @type {any} */ this.onmessage = null;
      /** @type {any} */ this.onclose = null;
      /** @type {any} */ this.onerror = null;
      /** @type {End|null} */ this.end = null;
      /** @type {Response|null} */ this.response = null;
      setImmediate(async () => {
        let res;
        try { res = await fetch(url, { upgrade: "websocket", "cf-connecting-ip": ip }); } catch (e) { errors.push(/** @type {Error} */ (e)); }
        this.response = res || null;
        const end = res && res.status === 101 ? /** @type {any} */ (res).webSocket : null;
        if (!end) { this.readyState = CLOSED; this.onerror?.({ type: "error" }); this.onclose?.({ code: 1006, reason: "", wasClean: false }); return; }
        this.end = end;
        this.readyState = OPEN;
        this.onopen?.({ type: "open" });
        end.listen((type, ev) => {
          if (type === "message") { this.onmessage?.({ data: ev }); return; }
          if (!ev.ack) end.close(ev.code === 1005 ? undefined : ev.code, ev.reason);
          this.readyState = CLOSED;
          this.onclose?.({ code: ev.code, reason: ev.reason, wasClean: true });
        });
      });
    }
    send(data) {
      if (this.readyState !== OPEN || !this.end) throw new Error("InvalidStateError: not open");
      this.end.send(data);
    }
    close(code, reason = "") {
      if (this.readyState === 0) { this.readyState = CLOSED; return; }
      if (this.readyState !== OPEN || !this.end) return;
      this.readyState = CLOSING;
      this.end.close(code, reason);
    }
  }

  return {
    env,
    fetch,
    WebSocket: FakeWebSocket,
    errors,
    /** The Durable Object for a route (created on first use). */
    object,
    /** Throws away every DO instance (or one route's): the next event constructs a new one. */
    hibernate(name) { for (const obj of objects.values()) if (name === undefined || obj.name === name) obj.instance = null; },
    get constructed() { return constructed; },
    /** Waits until every queued event has run. */
    async settle() {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setImmediate(r));
        await Promise.all([...objects.values()].map(x => x.idle()));
      }
    },
  };
}
