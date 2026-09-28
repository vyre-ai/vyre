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
// Browser contexts: an "agent" client may join with an agentName (addClient's third argument).
// The mux gets or creates that name's own Target.createBrowserContext (disposeOnDetach: false) on
// first use, in contextStore (a plain Map by default; index.js may back it with something
// durable), and reuses it for every later client of that name -- so two connections/sessions for
// the same agent share one set of cookies, storage and targets, and two different agent names
// never do. NOT YET WIRED (28 Sep): index.js's own addClient call passes no agentName, so this is
// all dormant until it does -- see the reviewer's H1/H2/M1/M2 fixes below, closed before wiring,
// and the wiring note at the very end of this comment.
//
// Any call a context-scoped agent client sends that names a browserContextId DIFFERENT from its
// own is refused outright, never silently rewritten (reviewer H1, 28 Sep) -- the same "refuse a
// wrong claim loudly" shape as everything else below, and not an enumerated list of methods, so a
// future CDP call that takes browserContextId is covered for free. Target.getBrowserContexts is
// refused outright too (REFUSED, below): it lists every agent's context id in one answer, which
// no client ever needs.
//
// Leaving browserContextId out is NOT neutral (reviewer M3, 28 Sep, closing a gap H1's own first
// cut left open): Chrome's own default for a call that takes one is the browser's DEFAULT
// context, exactly where a fill client's private sign-in and any unscoped client actually live --
// so a scoped client omitting it on Storage.setCookies/clearCookies, Browser.grantPermissions/
// setPermission/resetPermissions or Browser.setDownloadBehavior would reach INTO that context
// rather than being fenced out of it. OPTIONAL_CONTEXT_METHODS is where the mux fills in the
// client's own context instead of letting Chrome default it (Target.createTarget did this from
// the start; M3 added the rest); every other Browser.*/Storage.* call with no browserContextId is
// refused unless it is in CONTEXT_READONLY_METHODS (touches nothing context-specific, e.g.
// Browser.getVersion) -- assumed unsafe, never assumed to apply mux-wide just because this file
// has not vetted what it does with no context.
//
// A handful of calls name a TARGET, not a context, with no browserContextId param to check
// (TARGET_ID_METHODS: attachToTarget, closeTarget, activateTarget, getTargetInfo,
// autoAttachRelated -- the last one added for M4, 28 Sep: an enumerated list is only as good as
// the enumeration) -- a scoped client's own targetId on one of these is checked against
// targetContext instead (reviewer H2, 28 Sep): an id targetContext has never learned is refused,
// not assumed safe, the same allowlist-not-denylist shape the rest of this file uses.
//
// Target.setDiscoverTargets and auto-attach are native per session (above) but not per context:
// Chrome fans a browser session's Target.targetCreated/attachedToTarget/targetInfoChanged/
// targetDestroyed out across every context in the browser, not just the one it was opened for
// (checked against testing/fake-chrome.js, which does the same) -- so the mux filters those four
// events for a context-scoped agent client down to its own context, dropping the rest the same
// way an event on a session nobody owns is dropped. The drop is on EQUALITY to the client's own
// context, not on a known mismatch (reviewer M1, 28 Sep: an event whose target had no
// browserContextId at all used to fall through undropped -- fail-open). waitForDebuggerOnStart is
// refused outright for a scoped client on ANY method that carries it, not just
// Target.setAutoAttach (reviewer M2, then M4, 28 Sep, closing the same enumeration gap
// Target.autoAttachRelated exposed above): Chrome's auto-attach fans out the same way discovery
// does, so turning it on would pause another agent's brand-new target and never resume it (this
// client's own copy of that target's attachedToTarget is the one thing that would normally resume
// it, and that event is exactly what gets dropped above) -- a real DoS on the other agent, not
// just an information leak. Target.getTargets is
// fenced the same way as the four events, on its way back (_response): a client asking directly,
// rather than waiting on discovery events, must not see another agent's targetInfos either.
// Target.targetDestroyed carries no browserContextId at all in real CDP, and neither does a
// target with no discovery/auto-attach client ever watching it, so targetContext below remembers
// each open target's context from two places: whichever of the other three events named it
// first, AND (reviewer M1's fix exposed this gap too) the response to the client's own
// Target.createTarget call, so H2's own checks work even when nobody ever turns discovery on for
// this target at all. An "agent" client joined with no agentName, and every "fill" client, keep
// today's unscoped behaviour exactly.
//
// Wiring, when it happens (not yet -- reviewer, 28 Sep): agentName must come from computerd's own
// authenticated identity, never from the client itself, and in shared mode an unscoped "agent"
// client must be refused outright, since it would see every context unfenced.
//
// Refusals, on any session: Browser.close, Browser.crash and crashGpuProcess (the agent must not
// kill the browser everyone shares), Target.sendMessageToTarget (the old unflattened channel),
// Target.exposeDevToolsProtocol (CDP handed to a page's own script), Target.setRemoteLocations,
// Target.attachToBrowserTarget (a client already has its browser session, and a second one would
// escape the cleanup above), and Target.createBrowserContext / Target.disposeBrowserContext (only
// the mux itself ever calls these, from _contextFor; a client asking directly gets the same
// refusal everything else in this list does). From the agent only, as ADR 0005 says:
// Runtime.addBinding and Page.addScriptToEvaluateOnNewDocument, either of which would leave
// script of its own in a page a person later signs in on.
//
// Nothing here ever logs a message's contents: they carry whatever is on the page, passwords a
// person is typing included. Logs name methods and count things, never more.

/** Methods no client may call, on any session. */
export const REFUSED = new Set([
  "Browser.close", "Browser.crash", "Browser.crashGpuProcess",
  "Target.sendMessageToTarget", "Target.exposeDevToolsProtocol",
  "Target.setRemoteLocations", "Target.attachToBrowserTarget",
  // Only the mux's own _contextFor ever creates or disposes an agent's browser context; a client
  // asking directly is refused the same way as everything else here.
  "Target.createBrowserContext", "Target.disposeBrowserContext",
  // Lists every agent's browserContextId in one answer -- no client ever needs this, and a
  // context-scoped client asking it would learn every other agent's context id outright
  // (reviewer H1, 28 Sep).
  "Target.getBrowserContexts",
]);

/**
 * Methods an "agent" client may not call, on any session. The cookie dumps would hand it the
 * HttpOnly session cookies of every login it was lent (a page's own script never sees those); it
 * uses a login through the browser, never by reading it.
 */
export const AGENT_REFUSED = new Set([
  "Runtime.addBinding", "Page.addScriptToEvaluateOnNewDocument",
  // Page.getCookies is deprecated in favour of Network.getCookies, but some Chrome builds still
  // answer it (reviewer, 28 Sep): the same dump, refused the same way.
  "Storage.getCookies", "Network.getAllCookies", "Network.getCookies", "Page.getCookies",
  // Reads a URL directly and hands back its bytes over IO.read, file:// included -- the same
  // class of leak DOM.setFileInputFiles is refused for below, by a different route (reviewer,
  // 28 Sep). Never checked against real Chrome (no docker host this pass).
  "Network.loadNetworkResource",
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
/** @param {any} headers a CDP headers object ({name: value}), or anything else (left alone) */
const dropCookieHeaders = headers => {
  if (!headers || typeof headers !== "object") return headers;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!COOKIE_HEADER.test(k)) out[k] = v;
  return out;
};
/** A "headers"-shaped key, whatever case: the map form ({name: value}) and the array form (CDP's own {name, value} list, Fetch.requestPaused's responseHeaders) both carry cookies the same way. */
const HEADER_KEY = /^(request|response)?headers$/i;
/**
 * Keys CDP uses to carry a cookie's actual value, or raw header text, nowhere a headers map or
 * array would catch (reviewer, 28 Sep): Network.requestWillBeSentExtraInfo's associatedCookies
 * (full Cookie objects, value included), responseReceivedExtraInfo's blockedCookies/
 * exemptedCookies (each carries its own cookieLine) and headersText/requestHeadersText (the raw
 * header block, Set-Cookie/Cookie included, that no per-header split ever sees), and Audits
 * CookieIssueDetails' rawCookieLine. Dropped whole rather than picked apart: none of these has a
 * non-cookie use an agent needs.
 */
const DROP_KEY = /^(associatedcookies|blockedcookies|exemptedcookies|rawcookieline|cookieline|headerstext|requestheaderstext)$/i;

/**
 * Removes anything a Network, Fetch or Audits event could carry a cookie's actual value in, at
 * any depth -- recursion rather than a per-event, per-field enumeration, since CDP keeps adding
 * new places headers and cookie values show up (a WebSocket handshake's own request/response, an
 * Audits issue's nested detail object) and an enumerated list only ever catches the ones already
 * found (e2e review MEDIUM 4 covered three events; the reviewer's 28 Sep pass found the rest were
 * still open: associatedCookies, headersText, the WebSocket handshake events, Audits
 * rawCookieLine). Every OTHER header still reaches the agent (a page telling it its own
 * Content-Type is normal automation) -- only cookie-shaped keys are touched.
 * @param {any} v
 */
/**
 * A "headers" field's value, either shape CDP uses: the map form ({name: value}, an object) or
 * the array form ({name, value} pairs, e.g. Fetch.requestPaused's responseHeaders) -- both carry
 * cookies the same way, so both are scrubbed the same way.
 * @param {any} val
 */
function scrubHeaderValue(val) {
  if (Array.isArray(val)) return val.filter(e => !(e && typeof e === "object" && COOKIE_HEADER.test(e.name)));
  return dropCookieHeaders(val);
}

function scrubAgentEvent(v) {
  if (Array.isArray(v)) return v.map(scrubAgentEvent);
  if (v && typeof v === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      if (DROP_KEY.test(k)) continue;
      out[k] = HEADER_KEY.test(k) ? scrubHeaderValue(val) : scrubAgentEvent(val);
    }
    return out;
  }
  return v;
}

/** A Chrome message larger than this is dropped whole rather than buffered. */
const MAX_MESSAGE = 256 * 1024 * 1024;
/** Messages a client may send before its browser session exists. */
const MAX_QUEUE = 1000;

/** Target events an agent client's own browserContextId fences (see the doc comment at the top). */
const TARGET_CONTEXT_EVENTS = new Set([
  "Target.attachedToTarget", "Target.targetCreated", "Target.targetInfoChanged", "Target.targetDestroyed",
]);

/**
 * Calls that name a target by id rather than by browserContextId (H2, reviewer 28 Sep): none of
 * these carries a browserContextId of its own to check the way Target.createTarget and the
 * Storage/Browser calls above do, so a scoped client's own targetId is checked against
 * targetContext instead, in _fromClient.
 */
const TARGET_ID_METHODS = new Set([
  "Target.attachToTarget", "Target.closeTarget", "Target.activateTarget", "Target.getTargetInfo",
  // M4 (reviewer, 28 Sep): an enumerated list is only as good as the enumeration --
  // Target.autoAttachRelated names ANOTHER target (not the caller's own session) to auto-attach
  // its related targets to, the same shape as attachToTarget, and was missed the first time.
  "Target.autoAttachRelated",
]);

/**
 * Calls whose browserContextId a scoped agent client may leave out, because the mux itself fills
 * it in with the client's own context (H1/M3, reviewer 28 Sep) -- Target.createTarget already
 * did; every other Browser and Storage call below did not, so a scoped client omitting
 * browserContextId on one of THOSE reached Chrome's DEFAULT context instead, the one place a
 * fill client's private sign-in and any unscoped client actually live. Any other Browser or
 * Storage method not in this set (or in CONTEXT_READONLY_METHODS, just below) is refused outright
 * when a scoped client leaves browserContextId out -- assumed unsafe by default, never assumed to
 * apply mux-wide just because this file has not enumerated what it does with no context.
 */
const OPTIONAL_CONTEXT_METHODS = new Set([
  "Target.createTarget", "Storage.setCookies", "Storage.clearCookies",
  "Browser.grantPermissions", "Browser.setPermission", "Browser.resetPermissions",
  "Browser.setDownloadBehavior",
]);

/** Browser and Storage calls a scoped client may still send with no browserContextId at all,
 * because they touch nothing context-specific (read the browser's own version, never a page's or
 * a context's data). Kept deliberately small; a call this file has not vetted is refused, not
 * assumed harmless. */
const CONTEXT_READONLY_METHODS = new Set(["Browser.getVersion"]);

/**
 * @typedef {{ send(text: string): void, close(): void }} Transport
 * @typedef {{ id: number, kind: string, transport: Transport, closed: boolean,
 *   browserSid: string|null, queue: string[], sessions: Set<string>,
 *   agentName: string|null, browserContextId: string|null }} Client
 * @typedef {{ client: Client|null, origId?: number, method: string, sessionId?: string,
 *   resolve?: (v: any) => void, reject?: (e: Error) => void, timer?: any, browserContextId?: string }} Pending
 * @typedef {{ get(agentName: string): string|undefined, set(agentName: string, browserContextId: string): void }} ContextStore
 *   Where an agent's browserContextId lives. Deliberately tiny -- get one, set one, nothing else --
 *   so a plain Map works as the default (and is all these tests need) while a caller like index.js
 *   can later back it with something that outlives this process.
 */

export class CdpMux {
  /** @param {{ log?: (line: string) => void }} [o] */
  /** @param {{ log?: (line: string) => void, downloads?: string, contextStore?: ContextStore }} [o]
   *   downloads: the one folder an agent may send downloads to; contextStore: where an agent's
   *   browserContextId lives (default: an in-memory Map, see the ContextStore typedef above) */
  constructor(o = {}) {
    this.log = o.log || (() => {});
    // Not under /home/agent (e2e review MEDIUM 3): the agent owns its home outright and could
    // rename Downloads there for a symlink into browser's own profile home, which Chrome would
    // then follow. /var/lib/vyre/browser/downloads is browser-owned, mode 2750 (entrypoint.sh) --
    // Chrome writes into it as browser, the agent can list and read but never rename or replace it.
    this.downloads = o.downloads || "/var/lib/vyre/browser/downloads";
    /** @type {ContextStore} */
    this.contextStore = o.contextStore || new Map();
    /** @type {Map<string, Promise<string>>} an agent name's Target.createBrowserContext while it
     *  is still being made, so two clients joining for the same name at once share the one call
     *  in flight rather than each starting their own and racing to store the result. */
    this.contextInFlight = new Map();
    /** @type {Map<string, string>} a target's browserContextId (open or since destroyed), learned
     *  from whichever of Target.targetCreated / attachedToTarget / targetInfoChanged named it
     *  first, or from the client's own Target.createTarget response (_response). Needed because
     *  Target.targetDestroyed carries only a targetId in real CDP, never a context, and because
     *  Target.attachToTarget / closeTarget / activateTarget / getTargetInfo (TARGET_ID_METHODS)
     *  name a target with no browserContextId either. Never deleted (see _event's own comment on
     *  why: Chrome fans a destroyed event out once per subscribed session, and deleting on the
     *  first of those calls would blind the target's own owner's later call to it) -- a small,
     *  bounded residual, one entry per target ever created for this process's lifetime. */
    this.targetContext = new Map();
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
    // Learned here too, not only from an event (H2's own targetId checks, in _fromClient, need
    // this even when nobody ever turns discovery or auto-attach on for this target -- the same
    // reliability gap Target.targetDestroyed's own missing browserContextId already forced
    // targetContext to close another way).
    if (!m.error && p.method === "Target.createTarget" && p.browserContextId && m.result && typeof m.result.targetId === "string") {
      this.targetContext.set(m.result.targetId, p.browserContextId);
    }
    // Target.getTargets answers with every target in the browser, not just the caller's context
    // (checked against testing/fake-chrome.js, same as the four events above) -- a context-scoped
    // agent client asking directly, rather than waiting for discovery events, must not see another
    // agent's targetInfos this way either. targetContext is kept in sync by _event for exactly this.
    if (!m.error && c.kind === "agent" && c.browserContextId && p.method === "Target.getTargets"
      && m.result && Array.isArray(m.result.targetInfos)) {
      m.result = { ...m.result, targetInfos: m.result.targetInfos.filter(t => {
        const ctx = t && typeof t.browserContextId === "string" ? t.browserContextId : this.targetContext.get(t && t.targetId);
        return ctx === c.browserContextId;
      }) };
    }
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
    // Fenced per the doc comment at the top: an agent client scoped to a browserContextId never
    // learns another context's target ids exist, even though Chrome's own discovery/auto-attach
    // is browser-wide, not per-context. targetContext remembers what targetDestroyed itself never
    // says. Checked and (if it belongs to another context) dropped before _own below, so a
    // filtered attachedToTarget never gives the client an owned, addressable child session either
    // -- it never learns the sessionId, and the mux never treats it as this client's to use.
    // M1 (reviewer, 28 Sep): this used to drop only when ctx was a KNOWN, different context --
    // an event whose target had no browserContextId at all (ctx undefined) fell through and was
    // delivered, fail-open. Fixed: for a scoped client, ctx must equal its own context exactly, so
    // undefined (unknown, or a target genuinely outside any context) is dropped the same as a
    // known mismatch, matching the allowlist-not-denylist shape the rest of this file uses.
    if (TARGET_CONTEXT_EVENTS.has(m.method)) {
      const tid = m.method === "Target.targetDestroyed" ? params.targetId
        : (params.targetInfo && typeof params.targetInfo.targetId === "string" ? params.targetInfo.targetId : undefined);
      const ctx = m.method === "Target.targetDestroyed" ? this.targetContext.get(tid)
        : (params.targetInfo && typeof params.targetInfo.browserContextId === "string" ? params.targetInfo.browserContextId : undefined);
      // Deliberately never deletes on targetDestroyed: Chrome fans this event out once PER
      // SUBSCRIBED SESSION, so _event runs once per client watching it, each its own call --
      // deleting on the first call (whichever client's copy happened to arrive first, fenced
      // agent included) would leave the entry gone before the target's OWNER's own copy of the
      // same destroyed event is checked just below, wrongly dropping it as "unknown" under M1's
      // now-strict equality. Left in place instead: a small, bounded residual (one Map entry per
      // target ever created, for the mux's own process lifetime -- the shared browser computer's
      // own idle-pause restart, docs/design/agent-browsers.md, already recycles this regularly).
      if (typeof tid === "string" && typeof ctx === "string") this.targetContext.set(tid, ctx);
      if (s.client.kind === "agent" && s.client.browserContextId && ctx !== s.client.browserContextId) return;
    }
    if (m.method === "Target.attachedToTarget" && typeof params.sessionId === "string" && !this.sessions.has(params.sessionId)) this._own(params.sessionId, s.client);
    if (m.method === "Target.detachedFromTarget" && typeof params.sessionId === "string") {
      const child = this.sessions.get(params.sessionId);
      if (child && child.client === s.client && !child.browser) this._forget(params.sessionId);
    }
    // An agent client never sees a Cookie or Set-Cookie header, or a cookie's actual value under
    // any other name CDP uses for one: those live in events Chrome sends unasked (Network/Fetch/
    // Audits domains), which CDP's cookie-API refusal above does not touch (e2e review MEDIUM 4;
    // widened past three enumerated events to every event in those three domains, reviewer 28
    // Sep, since CDP kept adding new cookie-carrying fields an enumerated list did not cover).
    // Every other domain's events keep the fast, unparsed passthrough.
    const scrub = s.client.kind === "agent" && /^(Network|Fetch|Audits)\./.test(m.method);
    if (s.browser) {
      const out = { ...m, params: scrub ? scrubAgentEvent(params) : m.params };
      delete out.sessionId;
      s.client.transport.send(JSON.stringify(out));
    } else if (scrub) {
      s.client.transport.send(JSON.stringify({ ...m, params: scrubAgentEvent(params) }));
    } else s.client.transport.send(text);
  }

  // ---- clients ----------------------------------------------------------------------------

  /**
   * A new client. `kind` marks it for closeKind and AGENT_REFUSED. For an "agent" client, the
   * optional `agentName` scopes it to that agent's own browser context (get-or-created via
   * _contextFor, then enforced on Target.createTarget and the four target events by _fromClient/
   * _event below); an "agent" client joined with no agentName behaves exactly as before, unscoped.
   * Ignored for "fill" clients -- the private sign-in flow has no browser-context scope, and this
   * does not give it one.
   * Returns its handle: receive() takes one CDP message as text, leave() says it has gone (safe to
   * call more than once). Messages that arrive before its browser session (and, for a named agent,
   * its browser context) is ready wait for it.
   * @param {string} kind @param {Transport} transport @param {string} [agentName]
   */
  addClient(kind, transport, agentName) {
    /** @type {Client} */
    const c = {
      id: ++this.nextClient, kind, transport, closed: false, browserSid: null, queue: [], sessions: new Set(),
      agentName: kind === "agent" && typeof agentName === "string" && agentName ? agentName : null,
      browserContextId: null,
    };
    const handle = {
      /** @param {string} text */
      receive: text => this._fromClient(c, text),
      leave: () => this._leave(c),
    };
    if (!this.up) { c.closed = true; try { transport.close(); } catch {} return handle; }
    this.clients.add(c);
    this.log(`cdp: ${kind} client joined; ${this.clients.size} clients`);
    this.call("Target.attachToBrowserTarget", {}).then(async r => {
      const sid = r && r.sessionId;
      if (typeof sid !== "string") throw new Error("no browser session");
      if (c.closed) { this._detachInChrome(sid); return; }
      c.browserSid = sid;
      this.sessions.set(sid, { client: c, browser: true });
      if (c.agentName) {
        try {
          c.browserContextId = await this._contextFor(c.agentName);
        } catch {
          if (!c.closed) { this.log(`cdp: could not open a browser context for a "${c.agentName}" agent client`); this._drop(c); }
          return;
        }
        if (c.closed) return;
      }
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

  /**
   * The browserContextId for an agent name: contextStore's own if one is already there, else a
   * fresh Target.createBrowserContext {disposeOnDetach: false} (survives past any one client's
   * session, the same way a person's Chrome profile survives past any one login) stored there for
   * every later call to reuse. Two clients joining for the same name at once share the one call in
   * flight rather than each making their own and racing to store the result.
   * @param {string} agentName @returns {Promise<string>}
   */
  async _contextFor(agentName) {
    const existing = this.contextStore.get(agentName);
    if (typeof existing === "string") return existing;
    let inFlight = this.contextInFlight.get(agentName);
    if (!inFlight) {
      inFlight = this.call("Target.createBrowserContext", { disposeOnDetach: false }).then(r => {
        const id = r && r.browserContextId;
        if (typeof id !== "string") throw new Error("Target.createBrowserContext returned no browserContextId");
        this.contextStore.set(agentName, id);
        return id;
      });
      this.contextInFlight.set(agentName, inFlight);
      inFlight.catch(() => {}).finally(() => { this.contextInFlight.delete(agentName); });
    }
    return inFlight;
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
    // Kept in sync so a mutation below (Target.createTarget's browserContextId, just past) reaches
    // Chrome: params is the same object as m.params when the client sent one, but a client that
    // sent none at all would otherwise mutate a copy nobody forwards.
    m.params = params;

    if (REFUSED.has(method) || (c.kind === "agent" && AGENT_REFUSED.has(method))) {
      this.log(`cdp: refused ${method} from a ${c.kind} client`);
      return fail(-32000, `${method} is not allowed on this computer`);
    }
    if (c.kind === "agent") {
      const why = this._agentParams(method, params);
      if (why) { this.log(`cdp: refused ${method} from an agent client (${why})`); return fail(-32000, `${method} ${why}`); }
    }
    // A context-scoped agent's own call always stays inside its own browser context (reviewer H1,
    // 28 Sep). ANY method naming a browserContextId that is not the client's own is refused
    // outright, never rewritten -- that is another agent's context, and a wrong claim is refused
    // loudly, the same shape as everywhere else in this file; it is not an enumerated list of
    // methods, so a future CDP method that takes browserContextId is covered for free.
    if (c.kind === "agent" && c.browserContextId && params.browserContextId !== undefined && params.browserContextId !== c.browserContextId) {
      this.log(`cdp: refused ${method} from an agent client naming another browser context`);
      return fail(-32000, `${method} may name only this agent's own browser context`);
    }
    // M3 (reviewer, 28 Sep): the check above only ever fired when browserContextId was PRESENT.
    // Leaving it out is not neutral -- Chrome's own default for a browserContextId-taking call is
    // the browser's DEFAULT context, exactly where a fill client's private sign-in and any
    // unscoped client actually live, so a scoped client omitting it on Storage.setCookies/
    // clearCookies, Browser.grantPermissions/setPermission/resetPermissions or
    // Browser.setDownloadBehavior would reach into that context rather than being fenced out of
    // it. OPTIONAL_CONTEXT_METHODS is where the mux fills in the client's own context instead of
    // letting Chrome default it (Target.createTarget already did; the rest are new here); every
    // OTHER Browser.*/Storage.* call with no browserContextId is refused outright unless it is in
    // CONTEXT_READONLY_METHODS (touches nothing context-specific) -- assumed unsafe, never assumed
    // to apply mux-wide just because this file has not vetted what it does with no context.
    if (c.kind === "agent" && c.browserContextId && params.browserContextId === undefined) {
      if (OPTIONAL_CONTEXT_METHODS.has(method)) params.browserContextId = c.browserContextId;
      else if (/^(Browser|Storage)\./.test(method) && !CONTEXT_READONLY_METHODS.has(method)) {
        this.log(`cdp: refused ${method} from an agent client with no browserContextId (would reach the default context)`);
        return fail(-32000, `${method} needs this agent's own browserContextId`);
      }
    }
    // H2 (reviewer, 28 Sep): a scoped client's own targetId, on any of these, must map through
    // targetContext to its own context -- attaching to, closing, activating or reading another
    // agent's target by id, none of which carries a browserContextId of its own to check above.
    // An id targetContext has never learned (a target from before this client's discovery/
    // auto-attach was on, or one that belongs to no scoped agent at all) is refused too: unknown
    // is not assumed safe, the same allowlist-not-denylist shape the rest of this file uses.
    if (c.kind === "agent" && c.browserContextId && TARGET_ID_METHODS.has(method)) {
      const ctx = typeof params.targetId === "string" ? this.targetContext.get(params.targetId) : undefined;
      if (ctx !== c.browserContextId) {
        this.log(`cdp: refused ${method} from an agent client naming a target outside its own browser context`);
        return fail(-32000, `${method} may name only a target in this agent's own browser context`);
      }
    }
    if (sid !== undefined && !this._ownsChild(c, sid)) return fail(-32001, "No session with given id");
    if (!this.up) return fail(-32000, "Chrome is not running");
    if ((method === "Target.attachToTarget" || (method === "Target.setAutoAttach" && params.autoAttach)) && params.flatten !== true) {
      return fail(-32602, "only flattened sessions are supported here: pass flatten: true");
    }
    // M2/M4 (reviewer, 28 Sep): waitForDebuggerOnStart pauses a new target until something calls
    // Runtime.runIfWaitingForDebugger on it. Chrome's own auto-attach fans out across every
    // context, not just the caller's (the same fan-out the target events above are fenced
    // against) -- Target.setAutoAttach AND Target.autoAttachRelated (M4: the first cut only
    // checked the former) both take it, and a scoped client turning it on would pause another
    // agent's brand-new target and never resume it (the mux drops that target's own
    // attachedToTarget event for this client, per the event fence below), a real DoS on the other
    // agent. Refused on ANY method that carries this param, not an enumerated list of two -- this
    // client never had any legitimate target to pause in the first place, whatever the method.
    if (c.kind === "agent" && c.browserContextId && params.waitForDebuggerOnStart) {
      return fail(-32602, "waitForDebuggerOnStart is not allowed for a context-scoped agent client");
    }
    if (method === "Target.detachFromTarget" && !this._ownsChild(c, params.sessionId)) return fail(-32001, "No session with given id");

    const id = ++this.nextId;
    // browserContextId is remembered here, not just learned later from an event, so a scoped
    // client's own H2 checks (Target.closeTarget etc, just above) work even when nobody ever
    // turned discovery or auto-attach on for this target -- the same reliability gap
    // Target.targetDestroyed's own missing browserContextId already forced targetContext to
    // exist for.
    this.pending.set(id, {
      client: c, origId: m.id, method, sessionId: typeof sid === "string" ? sid : undefined,
      browserContextId: method === "Target.createTarget" && c.kind === "agent" ? c.browserContextId : undefined,
    });
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
