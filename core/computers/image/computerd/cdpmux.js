// @ts-check
// cdpmux: one Chrome DevTools connection, shared by many clients.
//
// computerd starts Chrome with --remote-debugging-pipe, so Chrome has no debugging port at all:
// it reads CDP from its fd 3 and writes to its fd 4, each message one JSON text ended by a NUL
// byte. Nothing else on the computer (the agent's own terminal included) can dial it, and every
// client reaches it through this mux, after computerd's token and shield checks. This file does
// no process spawning and no networking: it takes the two ends of the pipe and "transports"
// (anything with send(text) and close()), so it can be driven entirely in memory by its tests.
//
// Every client gets a browser session of its own. The pipe's root session is shared by
// everything on it and outlives every client, so anything a client switched on there (Fetch
// interception, a trace, download behaviour, discovery) would outlive the client too: an agent cut
// off by the shield could leave Fetch.enable {urlPattern: "*"} behind and read the Vault fill's
// sign-in POST. So when a client joins, the mux calls Target.attachToBrowserTarget (flattened) on
// the root session and keeps the answer, browserSid, for that client alone:
//
// - A client's messages without a sessionId go to Chrome with sessionId = browserSid, and what
//   comes back on browserSid (answers and events) goes to that client with the sessionId taken
//   off again. The client never learns browserSid and cannot name it.
// - The root session is the mux's own (Browser.getVersion, and attaching or detaching browser
//   sessions). Nothing a client sends ever reaches it, and its events go to no client.
// - When a client leaves or is dropped, the mux detaches its child sessions and then browserSid
//   itself. Detaching the browser session ends everything the client set up on it: its Fetch and
//   Tracing, its discovery and auto-attach, and its child sessions with them.
// - Target.setAutoAttach and Target.setDiscoverTargets are per session in Chrome, so each client
//   sets them natively on its own browser session and gets its own events. The mux adds nothing.
//   Only flattened sessions are accepted (flatten: true), or child traffic could not be routed.
//
// Ids: every client numbers its own calls, so two clients both send {id: 1}. Each call is
// forwarded under a mux-wide id and answered under the client's own.
//
// Sessions: a child session belongs to the client whose session it was attached from, learned
// from Target.attachedToTarget arriving on one of that client's sessions, or from the answer to
// its own Target.attachToTarget. Traffic on a session goes only to its owner, and a client may
// send only on child sessions it owns; anything else is answered with CDP's own
// {code: -32001, message: "No session with given id"}. An event on a session nobody owns is
// dropped.
//
// Kinds: each client is marked "agent" or "fill". closeKind(kind) drops every client of that
// kind and detaches its sessions; raising the shield uses it to cut the agent off.
//
// Refusals, on any session: Browser.close, Browser.crash and crashGpuProcess (the agent must not
// kill the browser everyone shares), Target.sendMessageToTarget (the old unflattened channel),
// Target.exposeDevToolsProtocol (CDP handed to a page's own script), Target.setRemoteLocations,
// and Target.attachToBrowserTarget (a client already has its browser session, and a second one
// would escape the cleanup above). From the agent only, as ADR 0005 says: Runtime.addBinding and
// Page.addScriptToEvaluateOnNewDocument, either of which would leave script of its own in a page
// a person later signs in on.
//
// Nothing here ever logs a message's contents: they carry whatever is on the page, passwords a
// person is typing included. Logs name methods and count things, never more.

/** Methods no client may call, on any session. */
export const REFUSED = new Set([
  "Browser.close", "Browser.crash", "Browser.crashGpuProcess",
  "Target.sendMessageToTarget", "Target.exposeDevToolsProtocol",
  "Target.setRemoteLocations", "Target.attachToBrowserTarget",
]);

/**
 * Methods an "agent" client may not call, on any session. The cookie dumps would hand it the
 * HttpOnly session cookies of every login it was lent (a page's own script never sees those); it
 * uses a login through the browser, never by reading it.
 */
export const AGENT_REFUSED = new Set([
  "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument",
  "Storage.getCookies", "Network.getAllCookies", "Network.getCookies",
]);

/**
 * Where an "agent" client may point a page: the web, a blank page, or inline data. Never file://
 * (Chrome runs as computerd's uid, whose files are the Chrome profile and the VNC password),
 * chrome:// or devtools:// (the browser's own pages), or an extension's. Chrome's managed
 * URLBlocklist refuses the same for navigations a page starts itself; this refuses them at the call.
 */
export const agentUrlAllowed = url => typeof url === "string" && (/^https?:\/\//i.test(url) || /^about:blank(#.*)?$/i.test(url) || /^data:/i.test(url));

/** cookie and set-cookie, whatever case Chrome sent them in. */
const COOKIE_HEADER = /^(cookie|set-cookie)$/i;
/** Events worth reconstructing for an agent client rather than passing Chrome's text through. */
const COOKIE_EVENTS = new Set(["Network.requestWillBeSentExtraInfo", "Network.responseReceivedExtraInfo", "Fetch.requestPaused"]);
/** @param {any} headers a CDP headers object ({name: value}), or anything else (left alone) */
const dropCookieHeaders = headers => {
  if (!headers || typeof headers !== "object") return headers;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!COOKIE_HEADER.test(k)) out[k] = v;
  return out;
};

/**
 * Events that carry request/response headers straight from the network stack, which is where
 * HttpOnly cookies live -- CDP's own Network.getCookies-family refusal (AGENT_REFUSED, above)
 * never sees these, since they are events Chrome sends unasked once Network or Fetch is enabled.
 * The agent may still see every OTHER header (e2e review MEDIUM 4: "no bulk dumps", not "no
 * headers at all" -- a page telling the agent its own Content-Type is normal automation).
 * @param {string} method @param {any} params
 */
const scrubAgentEventParams = (method, params) => {
  if (method === "Network.requestWillBeSentExtraInfo" || method === "Network.responseReceivedExtraInfo") {
    return { ...params, headers: dropCookieHeaders(params.headers) };
  }
  if (method === "Fetch.requestPaused") {
    const out = { ...params };
    if (out.request && typeof out.request === "object") out.request = { ...out.request, headers: dropCookieHeaders(out.request.headers) };
    if (out.responseHeaders) out.responseHeaders = out.responseHeaders.filter((/** @type {any} */ h) => !COOKIE_HEADER.test(h.name));
    return out;
  }
  return params;
};

/** A Chrome message larger than this is dropped whole rather than buffered. */
const MAX_MESSAGE = 256 * 1024 * 1024;
/** Messages a client may send before its browser session exists. */
const MAX_QUEUE = 1000;

/**
 * @typedef {{ send(text: string): void, close(): void }} Transport
 * @typedef {{ id: number, kind: string, transport: Transport, closed: boolean,
 *   browserSid: string|null, queue: string[], sessions: Set<string> }} Client
 * @typedef {{ client: Client|null, origId?: number, method: string, sessionId?: string,
 *   resolve?: (v: any) => void, reject?: (e: Error) => void, timer?: any }} Pending
 */

export class CdpMux {
  /** @param {{ log?: (line: string) => void }} [o] */
  /** @param {{ log?: (line: string) => void, downloads?: string }} [o] downloads: the one folder an agent may send downloads to */
  constructor(o = {}) {
    this.log = o.log || (() => {});
    this.downloads = o.downloads || "/home/agent/Downloads";
    this.nextId = 0;
    this.nextClient = 0;
    /** @type {Map<number, Pending>} */
    this.pending = new Map();
    /** @type {Map<string, { client: Client, browser: boolean }>} every session a client owns, its browser session included */
    this.sessions = new Map();
    /** @type {Set<Client>} */
    this.clients = new Set();
    /** @type {import("node:stream").Writable|null} */
    this.input = null;
    this.up = false;
    /** bumped on every attach/detach, so a dead pipe's late events are ignored */
    this.gen = 0;
    /** @type {Buffer[]} */
    this.partial = [];
    this.partialLen = 0;
    this.skipping = false;
  }

  // ---- the pipe ---------------------------------------------------------------------------

  /**
   * Start talking to a (new) Chrome. `input` is what Chrome reads (its fd 3), `output` what it
   * writes (its fd 4).
   * @param {import("node:stream").Writable} input @param {import("node:stream").Readable} output
   */
  attach(input, output) {
    if (this.up) this.detach("Chrome was replaced");
    const gen = ++this.gen;
    this.input = input;
    this.up = true;
    this.partial = []; this.partialLen = 0; this.skipping = false;
    const gone = () => { if (gen === this.gen) this.detach("Chrome exited"); };
    output.on("data", chunk => { if (gen === this.gen) this._onData(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); });
    output.on("end", gone);
    output.on("close", gone);
    output.on("error", gone);
    input.on("error", gone);
    input.on("close", gone);
    this.log("cdp: Chrome's pipe is up");
  }

  /**
   * Chrome is gone: every call still waiting is answered with an error, every session is
   * forgotten, and every client is closed (its sessionIds mean nothing to the next Chrome).
   * @param {string} [reason]
   */
  detach(reason = "Chrome exited") {
    if (!this.up) return;
    this.up = false;
    this.gen++;
    this.input = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    let failed = 0;
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      if (!p.client) { if (p.reject) p.reject(new Error(reason)); continue; }
      if (p.client.closed) continue;
      failed++;
      this._reply(p.client, { id: p.origId, error: { code: -32000, message: reason }, ...(p.sessionId ? { sessionId: p.sessionId } : {}) });
    }
    this.sessions.clear();
    const clients = [...this.clients];
    for (const c of clients) { c.sessions.clear(); c.browserSid = null; }
    for (const c of clients) this._drop(c);
    this.log(`cdp: Chrome's pipe closed; failed ${failed} pending calls, closed ${clients.length} clients`);
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    let start = 0;
    for (;;) {
      const i = chunk.indexOf(0, start);
      if (i < 0) break;
      const part = chunk.subarray(start, i);
      start = i + 1;
      if (this.skipping) { this.skipping = false; this.partial = []; this.partialLen = 0; continue; }
      const whole = this.partial.length ? Buffer.concat([...this.partial, part]) : part;
      this.partial = []; this.partialLen = 0;
      if (whole.length) this._fromChrome(whole.toString("utf8"));
    }
    if (start < chunk.length && !this.skipping) {
      const rest = chunk.subarray(start);
      this.partialLen += rest.length;
      if (this.partialLen > MAX_MESSAGE) {
        this.log(`cdp: dropped a Chrome message over ${MAX_MESSAGE} bytes`);
        this.partial = []; this.partialLen = 0; this.skipping = true;
      } else this.partial.push(Buffer.from(rest));
    }
  }

  /** @param {any} msg */
  _write(msg) {
    if (!this.up || !this.input) return false;
    try { this.input.write(JSON.stringify(msg) + "\0"); return true; }
    catch { this.detach("Chrome's pipe could not be written"); return false; }
  }

  /**
   * A call of the mux's own, on the root session unless a sessionId is given; never a client's.
   * @param {string} method @param {any} [params] @param {string} [sessionId] @param {number} [timeout] ms
   * @returns {Promise<any>}
   */
  call(method, params = {}, sessionId, timeout) {
    if (!this.up) return Promise.reject(new Error("Chrome is not running"));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      /** @type {Pending} */
      const p = { client: null, method, resolve, reject };
      if (timeout) p.timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, timeout);
      this.pending.set(id, p);
      /** @type {any} */
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      if (!this._write(msg)) { this.pending.delete(id); if (p.timer) clearTimeout(p.timer); reject(new Error("Chrome is not running")); }
    });
  }

  // ---- from Chrome ------------------------------------------------------------------------

  /** @param {string} text */
  _fromChrome(text) {
    let m;
    try { m = JSON.parse(text); } catch { this.log("cdp: Chrome sent something that is not JSON"); return; }
    if (!m || typeof m !== "object") return;
    if (typeof m.id === "number") return this._response(m);
    if (typeof m.method === "string") return this._event(m, text);
  }

  /** @param {any} m */
  _response(m) {
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (!p.client) {
      if (m.error) /** @type {(e: Error) => void} */ (p.reject)(new Error(String(m.error.message || "CDP error")));
      else /** @type {(v: any) => void} */ (p.resolve)(m.result);
      return;
    }
    const c = p.client;
    if (c.closed) return;
    // A child attached by this client's own call is its own, whether or not Chrome's
    // Target.attachedToTarget for it arrived first.
    const sid = !m.error && m.result && typeof m.result.sessionId === "string" ? m.result.sessionId : null;
    if (sid && p.method === "Target.attachToTarget" && !this.sessions.has(sid)) this._own(sid, c);
    const out = { ...m, id: p.origId };
    if (p.sessionId) out.sessionId = p.sessionId;
    else delete out.sessionId;
    this._reply(c, out);
  }

  /** @param {any} m @param {string} text */
  _event(m, text) {
    // The root session is the mux's; nothing on it concerns any client.
    if (typeof m.sessionId !== "string" || !m.sessionId) return;
    const s = this.sessions.get(m.sessionId);
    if (!s || s.client.closed) return;
    const params = m.params && typeof m.params === "object" ? m.params : {};
    if (m.method === "Target.attachedToTarget" && typeof params.sessionId === "string" && !this.sessions.has(params.sessionId)) this._own(params.sessionId, s.client);
    if (m.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      const child = this.sessions.get(params.sessionId);
      if (child && child.client === s.client && !child.browser) this._forget(params.sessionId);
    }
    // An agent client never sees a Cookie or Set-Cookie header, on any session: those live in
    // events Chrome sends unasked (Network/Fetch domains), which CDP's cookie-API refusal above
    // does not touch (e2e review MEDIUM 4). COOKIE_EVENTS is the only case worth reconstructing
    // the message for; everything else keeps the fast, unparsed passthrough.
    const scrub = s.client.kind === "agent" && COOKIE_EVENTS.has(m.method);
    if (s.browser) {
      const out = { ...m, params: scrub ? scrubAgentEventParams(m.method, params) : m.params };
      delete out.sessionId;
      s.client.transport.send(JSON.stringify(out));
    } else if (scrub) {
      s.client.transport.send(JSON.stringify({ ...m, params: scrubAgentEventParams(m.method, params) }));
    } else s.client.transport.send(text);
  }

  // ---- clients ----------------------------------------------------------------------------

  /**
   * A new client. `kind` marks it for closeKind and AGENT_REFUSED. Returns its handle: receive()
   * takes one CDP message as text, leave() says it has gone (safe to call more than once).
   * Messages that arrive before its browser session exists wait for it.
   * @param {string} kind @param {Transport} transport
   */
  addClient(kind, transport) {
    /** @type {Client} */
    const c = { id: ++this.nextClient, kind, transport, closed: false, browserSid: null, queue: [], sessions: new Set() };
    const handle = {
      /** @param {string} text */
      receive: text => this._fromClient(c, text),
      leave: () => this._leave(c),
    };
    if (!this.up) { c.closed = true; try { transport.close(); } catch {} return handle; }
    this.clients.add(c);
    this.log(`cdp: ${kind} client joined; ${this.clients.size} clients`);
    this.call("Target.attachToBrowserTarget", {}).then(r => {
      const sid = r && r.sessionId;
      if (typeof sid !== "string") throw new Error("no browser session");
      if (c.closed) { this._detachInChrome(sid); return; }
      c.browserSid = sid;
      this.sessions.set(sid, { client: c, browser: true });
      const queued = c.queue;
      c.queue = [];
      for (const text of queued) this._fromClient(c, text);
    }).catch(() => {
      if (c.closed) return;
      this.log(`cdp: could not open a browser session for a ${kind} client`);
      this._drop(c);
    });
    return handle;
  }

  /** Drop every client of one kind, detaching its sessions. Returns how many were dropped. @param {string} kind */
  closeKind(kind) {
    let n = 0;
    for (const c of [...this.clients]) if (c.kind === kind) { n++; this._drop(c); }
    if (n) this.log(`cdp: closed ${n} ${kind} clients`);
    return n;
  }

  /** Drop every client. */
  closeAll() {
    for (const c of [...this.clients]) this._drop(c);
  }

  /** How many clients of a kind are connected (all kinds when omitted). @param {string} [kind] */
  count(kind) {
    let n = 0;
    for (const c of this.clients) if (!kind || c.kind === kind) n++;
    return n;
  }

  /** @param {Client} c */
  _drop(c) {
    if (c.closed) return;
    try { c.transport.close(); } catch {}
    this._leave(c);
  }

  /** @param {Client} c */
  _leave(c) {
    if (c.closed) return;
    c.closed = true;
    c.queue = [];
    this.clients.delete(c);
    const children = [...c.sessions];
    for (const sid of children) this.sessions.delete(sid);
    c.sessions.clear();
    const browserSid = c.browserSid;
    c.browserSid = null;
    if (browserSid) {
      this.sessions.delete(browserSid);
      // Children first, on the session that attached them (Chrome also ends them with their
      // parent; this does not rely on it), then the browser session on the root.
      if (this.up) {
        for (const sid of children) this.call("Target.detachFromTarget", { sessionId: sid }, browserSid).catch(() => {});
        this._detachInChrome(browserSid);
      }
    }
    // A browser session still being opened is detached when its answer arrives (addClient).
    this.log(`cdp: ${c.kind} client left; detached ${children.length + (browserSid ? 1 : 0)} sessions; ${this.clients.size} clients`);
  }

  /** @param {string} sid @param {Client} c */
  _own(sid, c) {
    this.sessions.set(sid, { client: c, browser: false });
    c.sessions.add(sid);
  }

  /** @param {string} sid */
  _forget(sid) {
    const s = this.sessions.get(sid);
    if (!s) return;
    this.sessions.delete(sid);
    s.client.sessions.delete(sid);
  }

  /** Detach a session attached from the root (a browser session). @param {string} sid */
  _detachInChrome(sid) {
    this.call("Target.detachFromTarget", { sessionId: sid }).catch(() => {});
  }

  /** @param {Client} c @param {any} msg */
  _reply(c, msg) {
    if (c.closed) return;
    c.transport.send(JSON.stringify(msg));
  }

  /** @param {Client} c @param {string} text */
  _fromClient(c, text) {
    if (c.closed) return;
    if (!c.browserSid) {
      if (c.queue.length >= MAX_QUEUE) { this.log(`cdp: a ${c.kind} client sent too much before its session opened`); this._drop(c); return; }
      c.queue.push(text);
      return;
    }
    let m;
    try { m = JSON.parse(text); } catch { this.log(`cdp: ${c.kind} client sent something that is not JSON`); return; }
    if (!m || typeof m !== "object" || typeof m.id !== "number") return;
    const sid = m.sessionId;
    /** @param {number} code @param {string} message */
    const fail = (code, message) => this._reply(c, { id: m.id, error: { code, message }, ...(typeof sid === "string" ? { sessionId: sid } : {}) });
    if (typeof m.method !== "string") return fail(-32600, "Message must have string 'method' property");
    const method = m.method;
    const params = m.params && typeof m.params === "object" ? m.params : {};

    if (REFUSED.has(method) || (c.kind === "agent" && AGENT_REFUSED.has(method))) {
      this.log(`cdp: refused ${method} from a ${c.kind} client`);
      return fail(-32000, `${method} is not allowed on this computer`);
    }
    if (c.kind === "agent") {
      const why = this._agentParams(method, params);
      if (why) { this.log(`cdp: refused ${method} from an agent client (${why})`); return fail(-32000, `${method} ${why}`); }
    }
    if (sid !== undefined && !this._ownsChild(c, sid)) return fail(-32001, "No session with given id");
    if (!this.up) return fail(-32000, "Chrome is not running");
    if ((method === "Target.attachToTarget" || (method === "Target.setAutoAttach" && params.autoAttach)) && params.flatten !== true) {
      return fail(-32602, "only flattened sessions are supported here: pass flatten: true");
    }
    if (method === "Target.detachFromTarget" && !this._ownsChild(c, params.sessionId)) return fail(-32001, "No session with given id");

    const id = ++this.nextId;
    this.pending.set(id, { client: c, origId: m.id, method, sessionId: typeof sid === "string" ? sid : undefined });
    if (!this._write({ ...m, id, sessionId: typeof sid === "string" ? sid : c.browserSid })) {
      this.pending.delete(id);
      fail(-32000, "Chrome is not running");
    }
  }

  /**
   * An agent's call whose parameters would reach past what the agent may touch, and why; null
   * when it is fine. Checked for the agent only: the Vault's fill client opens its own pages.
   * @param {string} method @param {any} params @returns {string|null}
   */
  _agentParams(method, params) {
    if ((method === "Page.navigate" || method === "Target.createTarget") && !agentUrlAllowed(params.url)) {
      return "may open only http(s), about:blank or data: pages";
    }
    // Chrome (computerd's uid) opens whatever local path a file input names and hands the page
    // its bytes through the DOM -- a page-JS FileReader then reads .boot, the Cookies DB or
    // anything else that uid can see, which is exactly what the URL fence above stops for a
    // navigation. Refused outright: staging an agent's own upload through a vyre-owned copy is a
    // real feature, not a param this fence can safely narrow (e2e review finding, HIGH 1).
    if (method === "DOM.setFileInputFiles") return "cannot attach local files to a page";
    // A drag carrying files is the same attack shaped differently (a page's drop handler reads
    // them the same way a <input type=file> change handler would); a drag with no files (moving
    // an element within a page) is unaffected.
    if (method === "Input.dispatchDragEvent" && Array.isArray(params.data && params.data.files) && params.data.files.length) {
      return "cannot drag local files onto a page";
    }
    if (method === "Browser.setDownloadBehavior" || method === "Page.setDownloadBehavior") {
      const b = params.behavior;
      const path = typeof params.downloadPath === "string" ? params.downloadPath.replace(/\/+$/, "") : undefined;
      if (b === "deny" || b === "default") return path === undefined ? null : "takes no downloadPath with deny or default";
      if (path !== this.downloads) return `may save downloads only to ${this.downloads}`;
    }
    return null;
  }

  /** A child session (never the browser session) this client owns. @param {Client} c @param {any} sid */
  _ownsChild(c, sid) {
    if (typeof sid !== "string") return false;
    const s = this.sessions.get(sid);
    return Boolean(s && s.client === c && !s.browser);
  }
}
