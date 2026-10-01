// @ts-check
// net: the network buffer, live watch, acting on requests, and replay.
//
// RAW STAYS IN THE WORKER. Headers, cookies and bodies are kept exactly as Chrome reported them
// because replay and api.call need the real Authorization header, but nothing that leaves this
// file is raw: every return and every emitted event goes through redact.request. There is no
// argument that asks for a raw value.
//
// FRAMES. A tab is not one session: a cross-origin iframe (and one inside it) has its own CDP session and its
// own network traffic. Capture, the Fetch interception and the egress guard run on the top session AND every
// child session of the tab (cdp.children, plus Target.attachedToTarget for late ones). A record is keyed by
// (session, requestId) so two frames cannot collide, and carries `frame` (the origin of the document that made
// it). The buffer, its caps and its eviction stay per tab.
//
// BOUNDED. A ring keyed by requestId holds at most maxRequests entries and maxBytes of headers,
// post data and urls; the oldest goes first. Bodies are never buffered: net.get asks Chrome for
// one on demand, and it comes back bounded to 100 kB with a truncated flag.
//
// ACTING. net.on with block, mock or headers goes through the Fetch domain and changes what the
// page sees, so it is refused while the person's stop is in force and checked against the floor
// as "net.intercept". Every rule expires (ttlMs, default 5 minutes) and dies with its tab.
// net.replay re-issues a captured request from inside the page (Runtime.evaluate of fetch with
// credentials included), so the page's own cookies authenticate it and no credential is handed to
// anything outside the browser.

import * as redact from "../shared/redact.js";
import { classify } from "../shared/floor.js";
import { classifySend, held, writeGate, PASS } from "../shared/outbound.js";
import { fail } from "../shared/proto.js";

const DEFAULT_MAX_REQUESTS = 500;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const BODY_MAX = 100_000;
const BODY_PRECAP = 1_000_000;
const RULE_TTL = 5 * 60_000;
const WATCH_PER_SECOND = 20;
const NO_SET = new Set(["cookie", "host", "content-length", "connection", "user-agent", "origin", "referer", "accept-encoding", "priority", "upgrade-insecure-requests"]);

/**
 * @typedef {{ id: string, seq: number, ts: number, method: string, url: string, type: string, initiator: any,
 *   reqHeaders: Record<string, string>, resHeaders: Record<string, string>, postData?: string, status?: number, mime?: string,
 *   timing?: any, sent?: number, encoded?: number, dataLength?: number, done?: boolean, failed?: string, endTs?: number, size: number,
 *   requestId: string, session?: string, frame?: string }} Rec
 * @typedef {{ id: string, filter: any, then: any, ttlMs: number, expiresAt: number, timer: any }} Rule
 * @typedef {{ tab: number, recs: Map<string, Rec>, bytes: number, maxRequests: number, maxBytes: number, seq: number,
 *   rules: Map<string, Rule>, ruleSeq: number, watchers: Map<string, any>, watchSeq: number, win: number, winCount: number, dropped: number, fetchOn: boolean, redirects: number, sessions: Set<string>, fetchPats: string[]|null }} TabNet
 */

/** @type {WeakMap<object, { tabs: Map<number, TabNet> }>} */
const perCtx = new WeakMap();

/** @param {string} code @param {string} [detail] */
export function refuse(code, detail) {
  const error = fail(code, detail);
  return Object.assign(new Error(error.message), { code, error });
}

/** @param {any} ctx */
export function root(ctx) {
  let r = perCtx.get(ctx);
  if (r) return r;
  r = { tabs: new Map() };
  perCtx.set(ctx, r);
  const tabs = r.tabs;
  ctx.cdp.on((/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params, /** @type {string|undefined} */ session) => {
    const t = tabs.get(tab);
    if (!t) return;
    if (method === "Inspector.detached") { if (!session) forget(tabs, tab); return; }
    try { handle(ctx, t, method, params || {}, session || undefined); } catch { /* one bad event must not break the buffer */ }
  });
  return r;
}

/** Resolve the tab, then the floor, then (for acting ops) stop. @param {any} ctx @param {any} args @param {string} op @param {boolean} [acting] */
export async function target(ctx, args, op, acting = false) {
  let tab = args?.tab;
  if (tab == null) {
    const a = await ctx.tabs.active();
    tab = a && typeof a === "object" ? a.id : a;
  }
  if (tab == null) throw refuse("no_tab");
  const f = await ctx.floorAllows(tab, op);
  if (!f || !f.allow) throw refuse("blocked", f?.why);
  if (acting && ctx.stopped()) throw refuse("stopped");
  return /** @type {number} */ (tab);
}

/** @param {any} ctx @param {number} tab */
async function attachOnce(ctx, tab) {
  const a = ctx.cdp.attached();
  const has = Array.isArray(a) ? a.includes(tab) : a instanceof Set ? a.has(tab) : false;
  if (!has) await ctx.cdp.attach(tab);
}

/** @param {Map<number, TabNet>} tabs @param {number} tab */
function forget(tabs, tab) {
  const t = tabs.get(tab);
  if (!t) return;
  for (const r of t.rules.values()) clearTimeout(r.timer);
  t.rules.clear();
  t.watchers.clear();
  t.recs.clear();
  tabs.delete(tab);
}

/**
 * Start (or resize) capture for a tab. Idempotent.
 * @param {any} ctx @param {number} tab @param {{ maxRequests?: number, maxBytes?: number }} [opts]
 */
export async function start(ctx, tab, opts = {}) {
  const { tabs } = root(ctx);
  let t = tabs.get(tab);
  const fresh = !t;
  if (!t) {
    t = { tab, recs: new Map(), bytes: 0, maxRequests: DEFAULT_MAX_REQUESTS, maxBytes: DEFAULT_MAX_BYTES, seq: 0, rules: new Map(), ruleSeq: 0, watchers: new Map(), watchSeq: 0, win: 0, winCount: 0, dropped: 0, fetchOn: false, redirects: 0, sessions: new Set(), fetchPats: null };
    tabs.set(tab, t);
  }
  if (opts.maxRequests) t.maxRequests = Math.max(1, Math.min(5000, Math.floor(opts.maxRequests)));
  if (opts.maxBytes) t.maxBytes = Math.max(1024, Math.floor(opts.maxBytes));
  evict(t);
  if (fresh) {
    await attachOnce(ctx, tab);
    await ctx.cdp.send(tab, "Network.enable", NETWORK_ARGS);
  }
  await syncSessions(ctx, t);
  return t;
}

const NETWORK_ARGS = { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 };

/** A child session worth capturing: a frame (a cross-origin iframe, nested too). @param {any} k */
const isFrameTarget = k => k && (k.type === "iframe" || k.type === "page");
/** Every child target the guard must cover: frames and dedicated workers (a worker has its own network that the page's fetch shim never sees). @param {any} k */
const isGuardTarget = k => isFrameTarget(k) || (k && (k.type === "worker" || k.type === "shared_worker" || k.type === "service_worker"));

/** Stop a running script: terminate execution on the tab's own session and on every child session. @param {any} ctx @param {TabNet} t */
async function abortScript(ctx, t) {
  const eg = /** @type {any} */ (t).egress; if (eg) eg.aborted = true;
  await Promise.all([ctx.cdp.send(t.tab, "Runtime.terminateExecution", {}), ...[...t.sessions].map(k => ctx.cdp.send(t.tab, "Runtime.terminateExecution", {}, k))].map(p => Promise.resolve(p).catch(() => {})));
}

/** Turn capture (and interception, if it is up) on for one child session. @param {any} ctx @param {TabNet} t @param {string} session */
/** Target types that have no Fetch domain (the DNR rules cover them). A FRAME that answers the same way is not one of these: it fails the guard. */
const WORKER_TYPES = /^(worker|shared_worker|service_worker)$/;
async function enableSession(ctx, t, session) {
  try {
    // The guard first: a frame that attaches while a script runs must not have an unguarded moment between its capture and its interception.
    // A dedicated worker's target has no Fetch domain in Chrome ("'Fetch.enable' wasn't found", measured in a real Chrome 154): its requests are covered by the declarativeNetRequest rules
    // alone (measured: a Blob worker's fetch is blocked with Fetch off). Only that error is tolerated, and only here; any other failure still leaves the child paused and the script stopped.
    if (t.fetchOn && t.fetchPats) {
      try {
        { const egF = /** @type {any} */ (t).egress; if (egF && egF.failEnable && /^(iframe|page)$/.test(String(t.sessionTypes?.get(session) || ""))) throw new Error("test: forced Fetch.enable failure"); } await ctx.cdp.send(t.tab, "Fetch.enable", { patterns: t.fetchPats.map(urlPattern => ({ urlPattern, requestStage: "Request" })) }, session); }
      catch (e) { if (!/'Fetch\.enable' wasn't found/.test(String(e && /** @type {any} */ (e).message || e)) || !WORKER_TYPES.test(String(t.sessionTypes?.get(session) || ""))) throw e; const eg = /** @type {any} */ (t).egress; if (eg) eg.noFetchTargets = (eg.noFetchTargets || 0) + 1; }
    }
    await ctx.cdp.send(t.tab, "Network.enable", NETWORK_ARGS, session);
    return true;
  } catch (e) { const eg = /** @type {any} */ (t).egress; if (eg) (eg.enableErrors || (eg.enableErrors = [])).push(String(e && /** @type {any} */ (e).message || e).slice(0, 160)); t.sessions.delete(session); /* gone, or not ours to enable: tried again on the next start */ return false; }
}

/** Every child session the tab has now gets capture. Cheap when nothing is new. @param {any} ctx @param {TabNet} t */
export function syncSessions(ctx, t) {
  const kids = typeof ctx.cdp.children === "function" ? ctx.cdp.children(t.tab) : [];
  const fresh = kids.filter((/** @type {any} */ k) => isGuardTarget(k) && !t.sessions.has(k.sessionId) && !(/** @type {any} */ (t).closed && /** @type {any} */ (t).closed.has(k.sessionId)));
  for (const k of fresh) { t.sessions.add(k.sessionId); (t.sessionTypes || (t.sessionTypes = new Map())).set(k.sessionId, String(k.type || "")); }
  return Promise.all(fresh.map((/** @type {any} */ k) => enableSession(ctx, t, k.sessionId)));
}

/**
 * The buffer must never outlive the floor (reviewer-2): a tab that goes to a bank or a Vyre surface
 * and comes back must not hand its traffic to a later net.list, net.get or api.learn. Each record
 * is judged by its own URL, and a navigation to a blind page empties the tab's buffer.
 * @param {string} url
 */
const blindUrl = url => classify(url, undefined, {}).tier === "blind";

/** Forget the buffer, or (with a session) only what one child frame captured. @param {TabNet} t @param {string} [session] */
function purge(t, session) {
  if (!session) { t.recs.clear(); t.bytes = 0; return; }
  for (const [k, r] of t.recs) if (r.session === session) { t.recs.delete(k); t.bytes -= r.size; }
}

/** @param {TabNet} t */
function evict(t) {
  while (t.recs.size > t.maxRequests || (t.bytes > t.maxBytes && t.recs.size > 1)) {
    const [k, r] = /** @type {[string, Rec]} */ (t.recs.entries().next().value);
    t.recs.delete(k);
    t.bytes -= r.size;
  }
}

/** @param {Rec} r */
const weigh = r => 300 + r.url.length + (r.postData?.length ?? 0) + JSON.stringify(r.reqHeaders).length + JSON.stringify(r.resHeaders).length;

/** @param {TabNet} t @param {Rec} r */
function reweigh(t, r) {
  const n = weigh(r);
  t.bytes += n - r.size;
  r.size = n;
}

/** The key of a request in the buffer: the bare id for the top session (as ever), session-qualified for a child. @param {string|undefined} session @param {string} id */
const keyOf = (session, id) => (session ? `${session}:${id}` : String(id));

/** @param {string} u */
const docOrigin = u => { try { const o = new URL(String(u)).origin; return o === "null" ? "" : o; } catch { return ""; } };

/** @param {any} ctx @param {TabNet} t @param {string} method @param {any} p @param {string} [session] */
/**
 * A child the guard could not reach is closed before it runs a line, not released: while it still waits for the debugger, `self.close()` (a worker) or `location.replace("about:blank")` (a frame)
 * is evaluated in it and only then is it resumed, so its own code never runs. If that cannot be done it is LEFT paused (a paused target is inert; it is never handed to the fallback resume).
 * @param {any} ctx @param {TabNet} t @param {string} sessionId @param {string} type @param {any} eg
 */
async function neutralize(ctx, t, sessionId, type, eg) {
  const expression = WORKER_TYPES.test(type) ? "self.close()" : "location.replace('about:blank')";
  try {
    // A frame that waits for the debugger has no execution context yet (measured: Runtime.evaluate fails on it), so it is sent to a blank page with Page.navigate; a worker gets self.close().
    if (WORKER_TYPES.test(type)) await ctx.cdp.send(t.tab, "Runtime.evaluate", { expression, returnByValue: true }, sessionId);
    else { try { await ctx.cdp.send(t.tab, "Page.navigate", { url: "about:blank" }, sessionId); } catch { await ctx.cdp.send(t.tab, "Runtime.evaluate", { expression, returnByValue: true }, sessionId); } }
    eg.neutralized = (eg.neutralized || 0) + 1;
    try { await ctx.cdp.send(t.tab, "Runtime.runIfWaitingForDebugger", {}, sessionId); } catch { /* gone */ }
  } catch {
    eg.leftPaused = (eg.leftPaused || 0) + 1;
  }
  if (ctx.cdp.resumed) ctx.cdp.resumed(sessionId); // either way it is not the fallback's to resume
}
/** The browser's own reports about the guard's probe requests (see probeGuard): which frame's probe a request is, a CSP block, a service worker's answer. @param {any} eg */
function probeNetwork(eg, method, p, session) {
  if (!eg.probeReq) return;
  if (/^Network\.(responseReceived|loadingFailed)$/.test(method) && (eg.netSeen || (eg.netSeen = [])).length < 12 && eg.probeReq.has(keyOf(session, p.requestId))) eg.netSeen.push({ m: method.slice(8), sw: p.response?.fromServiceWorker, br: p.blockedReason, et: p.errorText });
  const key = keyOf(session, p.requestId);
  if (method === "Network.requestWillBeSent") {
    const url = String(p.request?.url || ""), at = url.indexOf(PROBE_PATH + eg.nonce + "_");
    if (at < 0) return;
    const n = /^\d+/.exec(url.slice(at + PROBE_PATH.length + eg.nonce.length + 1));
    if (n) eg.probeReq.set(key, { n: Number(n[0]), type: p.type === "XHR" ? "Fetch" : String(p.type || "") });
  } else if (method === "Network.responseReceived") {
    const r = eg.probeReq.get(key); if (r && p.response && p.response.fromServiceWorker === true) eg.probeSw.add(r.n);
  } else if (method === "Network.loadingFailed") {
    const r = eg.probeReq.get(key); if (r && p.blockedReason === "csp") eg.probeSeen.add(`${r.n}:${r.type}`);
  }
}
function handle(ctx, t, method, p, session) {
  { const egP = /** @type {any} */ (t).egress; if (egP && egP.nonce && /^Network\.(requestWillBeSent|responseReceived|loadingFailed)$/.test(method)) probeNetwork(egP, method, p, session); }
  if (method === "Target.attachedToTarget") {
    { const eg0 = /** @type {any} */ (t).egress; if (eg0 && eg0.live && p.sessionId) (eg0.kidSessions || (eg0.kidSessions = new Map())).set(p.sessionId, String(p.targetInfo?.type || ""));
      // Under a sticky guard a worker made from a Blob and attached after the call returned is the script's most likely (a slow runner starts one late): it joins the guarded children.
      const st0 = /** @type {any} */ (t).sticky; if (!eg0 && st0 && p.sessionId && p.targetInfo && p.targetInfo.type === "worker" && String(p.targetInfo.url || "").startsWith("blob:")) { st0.kids.set(p.sessionId, "worker"); } }
    { const eg0 = /** @type {any} */ (t).egress; if (eg0 && eg0.live) eg0.lateChildren = (eg0.lateChildren || 0) + 1; if (eg0) (eg0.attached || (eg0.attached = [])).length < 12 && eg0.attached.push({ type: String(p.targetInfo?.type || ""), url: String(p.targetInfo?.url || "").slice(0, 60), wait: !!p.waitingForDebugger, guardTarget: isGuardTarget(p.targetInfo), known: t.sessions.has(p.sessionId), from: session ? "child" : "top" }); }
    if (p.sessionId && isGuardTarget(p.targetInfo) && !t.sessions.has(p.sessionId)) {
      t.sessions.add(p.sessionId);
      (t.sessionTypes || (t.sessionTypes = new Map())).set(p.sessionId, String(p.targetInfo?.type || ""));
      void (async () => {
        const ok = await enableSession(ctx, t, p.sessionId);
        const eg = /** @type {any} */ (t).egress;
        if (!ok && eg) {
          // A child that could not be guarded stays PAUSED while the script runs (that is the window it could leak in); the script is stopped now, and the child is released only after the guard is down.
          eg.failed = (eg.failed || 0) + 1; eg.unguarded = true;
          await abortScript(ctx, t);
          if (p.waitingForDebugger) await neutralize(ctx, t, p.sessionId, String(p.targetInfo?.type || ""), eg);
        } else if (p.waitingForDebugger) {
          try { await ctx.cdp.send(t.tab, "Runtime.runIfWaitingForDebugger", {}, p.sessionId); } catch { /* gone */ }
          if (ctx.cdp.resumed) ctx.cdp.resumed(p.sessionId);
        }
      })();
    } else if (p.sessionId && p.waitingForDebugger) {
      // a paused child the capture does not cover: never leave it waiting
      void (async () => { try { await ctx.cdp.send(t.tab, "Runtime.runIfWaitingForDebugger", {}, p.sessionId); } catch { /* gone */ } if (ctx.cdp.resumed) ctx.cdp.resumed(p.sessionId); })();
    }
    return;
  }
  if (method === "Target.detachedFromTarget") {
    if (p.sessionId) { t.sessions.delete(p.sessionId); if (/** @type {any} */ (t).closed) /** @type {any} */ (t).closed.delete(p.sessionId); const st = /** @type {any} */ (t).sticky; if (st) st.kids.delete(p.sessionId); }
    return;
  }
  if (method === "Network.requestWillBeSent") {
    const key = keyOf(session, p.requestId);
    const old = t.recs.get(key);
    if (old && p.redirectResponse) {
      // Keep the hop that redirected under its own key so the chain stays visible.
      t.recs.delete(key);
      old.status = p.redirectResponse.status;
      old.done = true;
      t.recs.set(`${key}#${++t.redirects}`, old);
    }
    // A document load is a navigation (a tab or a frame): if it goes somewhere blind, forget the
    // buffer now, before anything else can be read from it. The built-in list decides here at once;
    // the person's own blind list is asked right after.
    if (t.sticky && !session && p.type === "Document" && p.loaderId && String(p.loaderId) === String(p.requestId)) void clearStickyIfTop(ctx, t, p.frameId);
    if (p.type === "Document" && p.request?.url) {
      const u = String(p.request.url);
      if (blindUrl(u)) { purge(t, session); return; }
      void ctx.floorUrl(u, "net.list").then((/** @type {any} */ v) => { if (v && v.tier === "blind") purge(t, session); }, () => {});
    }
    const frame = docOrigin(p.documentURL) || (session ? docOrigin(kidUrl(ctx, t, session)) : "");
    /** @type {Rec} */
    const r = { id: key, requestId: String(p.requestId), ...(p.frameId ? { frameId: String(p.frameId).slice(-6) } : {}), ...(p.loaderId ? { loaderId: String(p.loaderId).slice(-6) } : {}), ...(p.initiator && p.initiator.type ? { initiator: String(p.initiator.type) } : {}), ...(session ? { session } : {}), ...(frame ? { frame } : {}), seq: ++t.seq, ts: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(), method: p.request?.method || "GET", url: p.request?.url || "", type: p.type || "Other", initiator: p.initiator || {}, reqHeaders: { ...(p.request?.headers || {}) }, resHeaders: {}, postData: p.request?.postData, size: 0 };
    // A request made while the eval guard was up is not evidence that the page talks to that origin (it may be the very request the guard blocks): the guard never learns from it,
    // and an origin first seen HERE, that the guard had not already allowed, is denied for good, whoever blocks the request (DNR, Fetch or nothing).
    if (/** @type {any} */ (t).egress) {
      /** @type {any} */ (r).guarded = true;
      try { const o = new URL(String(r.url)).origin; if (o && o !== "null" && !/** @type {any} */ (t).egress.allowed.has(o)) (t.denied || (t.denied = new Set())).add(o); } catch { /* not a URL */ }
    }
    if ((/** @type {any} */ (t)).evalTag && p.initiator && p.initiator.stack) {
      // Does a script this tab's guarded calls compiled sit anywhere in the stack that started the request (including the async parents of a timer or a promise)?
      let st = p.initiator.stack, hops = 0, hit = false;
      while (st && hops++ < 8 && !hit) { for (const f of st.callFrames || []) if (String(f.url || "").includes(/** @type {any} */ (t).evalTag)) { hit = true; break; } st = st.parent; }
      if (hit) /** @type {any} */ (r).tagged = true;
    }
    r.size = weigh(r);
    t.recs.set(r.id, r);
    t.bytes += r.size;
    evict(t);
    return;
  }
  if (method === "Fetch.requestPaused") { void paused(ctx, t, p, session); return; }
  const r = t.recs.get(keyOf(session, p.requestId));
  if (!r) return;
  if (method === "Network.requestWillBeSentExtraInfo") { Object.assign(r.reqHeaders, p.headers || {}); reweigh(t, r); }
  else if (method === "Network.responseReceived") {
    r.status = p.response?.status;
    // ONE RULE for what the page "talks to": an origin that returned a completed response to a request made OUTSIDE any guard. Nothing else vouches for an origin.
    if (!(/** @type {any} */ (r)).guarded && Number(r.status) > 0) { try { const o = new URL(String(r.url)).origin; if (o && o !== "null") (t.okOrigins || (t.okOrigins = new Set())).add(o); } catch { /* not a URL */ } }
    r.mime = p.response?.mimeType;
    r.timing = p.response?.timing;
    if (p.type) r.type = p.type;
    Object.assign(r.resHeaders, p.response?.headers || {});
    reweigh(t, r);
  } else if (method === "Network.responseReceivedExtraInfo") {
    Object.assign(r.resHeaders, p.headers || {});
    if (r.status == null && p.statusCode) r.status = p.statusCode;
    reweigh(t, r);
  } else if (method === "Network.dataReceived") r.dataLength = (r.dataLength || 0) + (p.dataLength || 0);
  else if (method === "Network.loadingFinished") {
    r.done = true;
    r.encoded = p.encodedDataLength;
    r.endTs = p.timestamp;
    notify(ctx, t, r);
  } else if (method === "Network.loadingFailed") {
    r.done = true;
    r.failed = p.errorText || (p.canceled ? "canceled" : "failed");
    notify(ctx, t, r);
  }
}

/** The url a child session was attached for (cdp.js keeps it current). @param {any} ctx @param {TabNet} t @param {string} session */
function kidUrl(ctx, t, session) {
  const k = typeof ctx.cdp.children === "function" ? ctx.cdp.children(t.tab).find((/** @type {any} */ c) => c.sessionId === session) : null;
  return k ? k.url : "";
}

/** @param {string} u */
function safeUrl(u) { return redact.url(String(u)); }

/** A record as a model may read it: no headers, no bodies. @param {Rec} r */
export function summary(r) {
  const t = r.timing;
  return {
    id: r.id,
    method: r.method,
    url: r.url,
    status: r.status,
    mime: r.mime,
    type: r.type,
    ...(r.frame ? { frame: r.frame } : {}),
    initiator: { type: r.initiator?.type, ...(r.initiator?.url ? { url: safeUrl(r.initiator.url) } : {}), ...(r.initiator?.lineNumber != null ? { line: r.initiator.lineNumber } : {}) },
    startedAt: r.ts,
    durationMs: t && r.endTs != null && t.requestTime ? Math.max(0, Math.round((r.endTs - t.requestTime) * 1000)) : undefined,
    sizes: { request: r.postData?.length ?? 0, response: r.dataLength ?? 0, encoded: r.encoded ?? 0 },
    ...(r.failed ? { failed: r.failed } : {}),
    ...(r.done ? {} : { pending: true }),
  };
}

/** @param {{ url?: string, method?: string, status?: any, type?: string, since?: number, frame?: string } | undefined} f */
export function matcher(f) {
  const url = f?.url ? String(f.url).toLowerCase() : "";
  const method = f?.method ? String(f.method).toUpperCase() : "";
  const type = f?.type ? String(f.type).toLowerCase() : "";
  const status = f?.status;
  const since = Number(f?.since) || 0;
  const frame = f?.frame != null && f.frame !== "" ? String(f.frame).toLowerCase() : "";
  /** @param {{ url: string, method: string, type: string, status?: number, ts?: number, frame?: string }} r */
  return r => {
    if (frame && !String(r.frame || "").toLowerCase().includes(frame)) return false;
    if (url && !r.url.toLowerCase().includes(url)) return false;
    if (method && r.method.toUpperCase() !== method) return false;
    if (type && String(r.type).toLowerCase() !== type) return false;
    if (since && (r.ts ?? 0) <= since) return false;
    if (status != null) {
      const list = [].concat(status);
      const ok = list.some(s => /^\dxx$/i.test(String(s)) ? String(r.status ?? "")[0] === String(s)[0] : Number(s) === r.status);
      if (!ok) return false;
    }
    return true;
  };
}

/** Raw records, for api.js to learn from. Never returned to a caller. @param {any} ctx @param {number} tab @param {any} [filter] */
export async function records(ctx, tab, filter) {
  const t = root(ctx).tabs.get(tab);
  if (!t) return [];
  const m = matcher(filter);
  const tier = await ctx.floorTier();
  return [...t.recs.values()].filter(r => tier(r.url) !== "blind").filter(m);
}

/** @param {any} ctx @param {TabNet} t @param {Rec} r */
function notify(ctx, t, r) {
  if (!t.watchers.size) return;
  const hit = [...t.watchers.values()].some(f => matcher(f)(r));
  if (!hit) return;
  const now = Date.now();
  if (now - t.win >= 1000) { t.win = now; t.winCount = 0; }
  if (t.winCount >= WATCH_PER_SECOND) { t.dropped++; return; }
  t.winCount++;
  const dropped = t.dropped;
  t.dropped = 0;
  ctx.emit({ event: "net.event", tab: t.tab, request: redact.request(summary(r)), ...(dropped ? { dropped } : {}) });
}

/** Bound a redacted body. @param {string | undefined} s */
function bound(s) {
  if (s === undefined) return { text: undefined, truncated: false };
  return s.length > BODY_MAX ? { text: s.slice(0, BODY_MAX), truncated: true } : { text: s, truncated: false };
}

/** Text that is too big to parse is cut first, then key-value shapes are masked by hand. @param {string} s */
export function precap(s) {
  if (s.length <= BODY_PRECAP) return s;
  return s.slice(0, BODY_PRECAP).replace(/("(?:[^"\\]*?(?:pass|secret|token|auth|key|session|cookie|csrf)[^"\\]*?)"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, `$1"${redact.MASK}:cut]"`);
}

/**
 * The redacted view of a record (or of a replay result), bodies bounded after redaction.
 * @param {any} view raw fields incl. requestHeaders/responseHeaders/requestBody/responseBody
 */
export function present(view) {
  const clean = { ...view };
  if (clean.requestBody !== undefined) clean.requestBody = precap(String(clean.requestBody));
  if (clean.responseBody !== undefined) clean.responseBody = precap(String(clean.responseBody));
  const out = redact.request(clean);
  const a = bound(out.requestBody);
  const b = bound(out.responseBody);
  if (a.text !== undefined) out.requestBody = a.text;
  if (b.text !== undefined) out.responseBody = b.text;
  return { ...out, ...(a.truncated ? { requestBodyTruncated: true } : {}), ...(b.truncated ? { responseBodyTruncated: true } : {}) };
}

/** Pause handling: first matching acting rule wins, emit rules always fire, everything else continues. The reply goes to the session that paused the request. @param {any} ctx @param {TabNet} t @param {any} p @param {string} [session] */
/**
 * Stop one request the guard or a block rule judged blocked: failRequest, once more if it rejects, then a local empty 403 (the page gets an answer, the origin gets nothing). Returns
 * whether any of them was accepted. It never continues the request.
 * @param {(m: string, x: any) => Promise<any>} send @param {string} id @param {string} reason
 */
/**
 * The guard's readiness probe. Fetch.enable resolving in the extension does not prove Chrome has put the interceptor into the renderer of a frame that already exists (a slow runner, the
 * first enable for a tab). So before the script runs, each readable frame the script could call into (the frame it runs in, and the tab's other frames with a real document) fires an Image
 * and a fetch at its OWN origin, under a path carrying a per-guard nonce, and the guard waits for BOTH to arrive at Fetch.requestPaused. The probe goes to an origin DNR already allows and
 * is failed at the pause, so it never reaches the server; if the interceptor is not live it is one GET for a random path on the page's own site. If they do not all arrive the guard
 * asks for interception again once, waits longer, and then refuses the script. Any exception while probing refuses too.
 * @param {any} ctx @param {any} t @param {any} eg @param {any} frame the frame the script runs in (null for the top page)
 */
const PROBE_PATH = "/__vyre_probe_";
async function probeGuard(ctx, t, eg, frame) {
  /** @type {any[]} */ let frames = [];
  try { frames = ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(t.tab) : []; } catch { frames = []; }
  const readable = frames.filter(f => f.readable && f.how !== "none" && !String(f.frameId).startsWith("element:"));
  // The script's own frame first, then the others that share an allowed origin (a frame on an origin the guard does not allow cannot be probed without DNR blocking the probe, and a
  // script cannot call into a cross-origin frame's network anyway).
  const targets = [frame ? readable.find(f => f.frameId === frame.frameId) || frame : readable.find(f => f.how === "top") || null];
  for (const f of readable) if (targets[0] !== f && f.origin && eg.allowed.has(f.origin) && targets.length < 8) targets.push(f);
  eg.nonce = eg.nonce || Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const expect = (/** @type {number} */ n) => [`${n}:Image`, `${n}:Fetch`];
  eg.probeReq = new Map(); eg.probeSw = new Set(); eg.probeClaim = new Set();
  for (let attempt = 0; attempt < 2; attempt++) {
    eg.probeSeen = new Set();
    try {
      // All frames at once, so a page with many frames does not pay the wait per frame.
      const results = await Promise.all(targets.map(async (f, n) => {
        const fire = `(() => { const o = location.origin; if (!/^https?:/.test(o)) return 0; const u = o + ${JSON.stringify(PROBE_PATH + eg.nonce + "_" + n)}; try { new Image().src = u; } catch (e) {} try { fetch(u, { mode: "no-cors", cache: "no-store" }).catch(function () {}); } catch (e) {} let sw = 0; try { sw = navigator.serviceWorker && navigator.serviceWorker.controller ? 1 : 0; } catch (e) {} return 1 + sw; })()`;
        const r = await runIn(ctx, t.tab, f, fire, { returnByValue: true });
        return r && r.result && r.result.value;
      }));
      for (const [n, v] of results.entries()) {
        if (v !== 1 && v !== 2) { if (n === 0) return false; eg.probeSkipped = (eg.probeSkipped || 0) + 1; targets[n] = null; } else if (v === 2) eg.probeClaim.add(n);
      }
    } catch { return false; /* a frame that cannot run the probe is not a frame the guard can vouch for */ }
    // Whether a service worker controls each frame, read from an ISOLATED world: DOM wrappers are per world, so a page that redefines navigator.serviceWorker in its own world changes nothing
    // here, while the state underneath (does the document have a controller) is the browser's. Where the world cannot be made (no frame id, an old tab) the page's own claim stands.
    for (const [n, f] of targets.entries()) {
      if (!f || !f.frameId) continue;
      try {
        const sess = f.how !== "top" && f.session ? String(f.session) : undefined;
        const w = await ctx.cdp.send(t.tab, "Page.createIsolatedWorld", { frameId: f.frameId, worldName: "vyre-probe", grantUniveralAccess: false }, sess);
        if (!w || typeof w.executionContextId !== "number") continue;
        const v = await ctx.cdp.send(t.tab, "Runtime.evaluate", { expression: "!!(navigator.serviceWorker && navigator.serviceWorker.controller)", contextId: w.executionContextId, returnByValue: true }, sess);
        const truth = v && v.result ? v.result.value : undefined;
        if (truth === true) eg.probeClaim.add(n); else if (truth === false) eg.probeClaim.delete(n);
      } catch { /* the page's claim stands */ }
    }
    // What counts as live for a frame, all of it generated by the BROWSER (never by the page): both probe requests paused by Fetch; or a probe request the browser says its page's CSP blocked
    // (Network.loadingFailed blockedReason "csp" for that type: it could not leave either); or a service worker answers the frame: the browser says so for a probe (Network.responseReceived
    // fromServiceWorker) OR the frame CLAIMS a controller (page JS, spoofable, and the ServiceWorker CDP domain reports nothing through chrome.debugger in Chrome 154, measured). Such a frame has
    // no Fetch interception to probe and rests on the browser-level rules alone, narrowed to the first party and required to be TESTED (see egressGuard), so a false claim only makes it stricter.
    const swOf = (/** @type {number} */ n) => eg.probeSw.has(n) || eg.probeClaim.has(n);
    const covered = (/** @type {number} */ n) => expect(n).every(k => eg.probeSeen.has(k)) || swOf(n);
    const end = Date.now() + (attempt ? 1000 : 400);
    const done = () => targets.every((f, n) => !f || covered(n));
    while (Date.now() < end && !done()) await new Promise(r => setTimeout(r, 15));
    if (done()) {
      eg.swFrames = targets.map((f, n) => (f && swOf(n) && !expect(n).every(k => eg.probeSeen.has(k)) ? n : -1)).filter(n => n >= 0);
      return true;
    }
    if (attempt === 0) await syncFetch(ctx, t); // ask again once
  }
  return false;
}

/** The site of an origin, approximately: the registrable domain (last two labels, three under a two-letter TLD with a short second level), or the whole host for an IP or a localhost name. @param {string} origin */
export function siteOf(origin) {
  let h = ""; try { h = new URL(origin).hostname; } catch { return origin; }
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.endsWith(".localhost") || h === "localhost") return h;
  const p = h.split(".");
  if (p.length <= 2) return h;
  const tld = p[p.length - 1], sld = p[p.length - 2];
  return tld.length === 2 && ["co", "com", "org", "net", "gov", "ac", "edu"].includes(sld) ? p.slice(-3).join(".") : p.slice(-2).join(".");
}
/** A third party the page talks to may receive only SMALL requests from a guarded script (URL plus body at most this many bytes): a beacon-sized ping, never a dump. */
export const THIRD_PARTY_MAX_BYTES = 256;
/** ... and in total, per guarded script: at most this many bytes and requests to ALL capped origins together. */
export const THIRD_PARTY_TOTAL_BYTES = 1024, THIRD_PARTY_MAX_REQUESTS = 8;

async function stopRequest(send, id, reason) {
  let stopped = false;
  for (let i = 0; i < 2 && !stopped; i++) stopped = await Promise.resolve(send("Fetch.failRequest", { requestId: id, errorReason: reason })).then(() => true, () => false);
  if (!stopped) stopped = await Promise.resolve(send("Fetch.fulfillRequest", { requestId: id, responseCode: 403, responseHeaders: [{ name: "content-type", value: "text/plain" }], body: "" })).then(() => true, () => false);
  return stopped;
}

/** The pseudo-guard for a request judged after the call returned, or null when the request is not the script's. @param {any} t @param {any} p @param {string|undefined} session */
/** A command that must not hold the call: it answers within `ms` or is given up on (the answer, if it comes, is ignored). @param {any} promise @param {number} ms */
/** Run first in every document made while a guard is up (see egressGuard). */
const NO_WORKERS_SRC = `(() => { const no = function () { throw new Error("Vyre held this: a script may not start a worker"); }; for (const k of ["Worker", "SharedWorker"]) { try { Object.defineProperty(window, k, { value: no, configurable: false, writable: false }); } catch (e) {} } try { if (navigator.serviceWorker) navigator.serviceWorker.register = no; } catch (e) {} })();`;

/** A breadcrumb of what the guard last did, for the harness to read when a call hangs. @param {any} t @param {string} what */
const mark = (t, what) => { try { (t.trail || (t.trail = [])).push([Date.now() % 1000000, what]); if (t.trail.length > 40) t.trail.shift(); } catch { /* */ } };

const bounded = (promise, ms = 500) => Promise.race([Promise.resolve(promise).catch(() => {}), new Promise(res => setTimeout(res, ms))]);

async function stickyJudge(t, p, session) {
  const st = t.sticky;
  let judge = !!(session && st.kids.has(session));
  if (!judge && p.networkId && st.tag) {
    // Network.requestWillBeSent carries the initiator stack and is joined to this pause by networkId; give it a moment to arrive first.
    let rec = t.recs.get(keyOf(session, p.networkId));
    for (let i = 0; !rec && i < 20; i++) { await new Promise(res => setTimeout(res, 5)); rec = t.recs.get(keyOf(session, p.networkId)); }
    judge = !!(rec && /** @type {any} */ (rec).tagged);
  }
  if (!judge) return null;
  st.judged = (st.judged || 0) + 1;
  return st.pseudo || (st.pseudo = { allowed: st.allowed, first: st.first, blocked: [], decisions: [], sticky: true, depth: 1 });
}

async function paused(ctx, t, p, session) {
  const id = p.requestId;
  let judged = false;
  const send = (/** @type {string} */ m, /** @type {any} */ x) => (session ? ctx.cdp.send(t.tab, m, x, session) : ctx.cdp.send(t.tab, m, x));
  try {
    // While a guarded script runs, nothing it does may reach an origin that is not this page's own or
    // one the page already talks to (fetch, XHR, beacons, images, scripts, navigation all pass here).
    let eg = /** @type {any} */ (t).egress;
    // AFTER a guarded call has returned: a request that a script of that call started (its initiator stack names the eval's sourceURL: a timer, a promise chain) and every request of a child
    // that attached while the guard was up is still judged, against the allowed set as it stood when the call returned, until the page navigates. Everything else is continued.
    if (!eg && t.sticky) eg = await stickyJudge(t, p, session);
    if (eg) {
      eg.pausedCount = (eg.pausedCount || 0) + 1;
      // The guard's own readiness probe: a request for a nonce path on a frame's own origin. Proof that Fetch is live in that frame. Stopped, not counted as the script's.
      if (eg.nonce && typeof p.request?.url === "string") {
        const m = p.request.url.indexOf(PROBE_PATH + eg.nonce + "_");
        if (m >= 0) {
          const n = /^\d+/.exec(p.request.url.slice(m + PROBE_PATH.length + eg.nonce.length + 1));
          if (n) { (eg.probeSeen || (eg.probeSeen = new Set())).add(`${n[0]}:${p.resourceType === "XHR" ? "Fetch" : String(p.resourceType || "")}`) /* Chrome reports a page fetch as type XHR */; await stopRequest(send, id, "BlockedByClient"); return; }
        }
      }
      let o = "";
      try { const x = new URL(p.request?.url || ""); if (!["data:", "blob:", "about:", "chrome-extension:"].includes(x.protocol)) o = x.origin; } catch { /* not a URL */ }
      (eg.decisions || (eg.decisions = [])).length < 40 && eg.decisions.push({ origin: o, type: String(p.resourceType || ""), ...(session ? { session: "child" } : {}), decision: o && !eg.allowed.has(o) ? "block" : "allow" });
      // A third party the page uses (allowed, but not the tab's site or a loaded frame's site) may only be sent something SMALL by a guarded script. Residual, written down: a multi-tenant third
      // party (an analytics or storage service many sites share) can still receive up to this much per request; this is a size bound, not a proof of intent.
      let thirdPartyBig = false, sizeCapped = false;
      if (o && eg.allowed.has(o) && eg.first) {
        const site = siteOf(o);
        const firstParty = [...eg.first].some(f => siteOf(f) === site);
        if (!firstParty) {
          const size = String(p.request?.url || "").length + (typeof p.request?.postData === "string" ? p.request.postData.length : p.request?.hasPostData ? THIRD_PARTY_MAX_BYTES + 1 : 0);
          // One budget for the whole guard: thirty small requests do not add up to a dump.
          thirdPartyBig = size > THIRD_PARTY_MAX_BYTES || (eg.thirdBytes || 0) + size > THIRD_PARTY_TOTAL_BYTES || (eg.thirdCount || 0) >= THIRD_PARTY_MAX_REQUESTS;
          if (!thirdPartyBig) { eg.thirdBytes = (eg.thirdBytes || 0) + size; eg.thirdCount = (eg.thirdCount || 0) + 1; }
          else sizeCapped = true;
        }
      }
      if (o && (!eg.allowed.has(o) || thirdPartyBig)) {
        // JUDGED BLOCKED: from here nothing may let this request go. failRequest, once more if it fails, then a fulfilled 403 with an empty body (the page gets an answer, the
        // origin gets nothing). If every attempt fails the request is left paused and the script's eval says a request MAY have been sent: it is never continued.
        judged = true;
        const stopped = await stopRequest(send, id, "BlockedByClient");
        if (!stopped) (eg.stuck || (eg.stuck = [])).push({ id, session }); // tried again just before Fetch goes off (stop())
        if (!sizeCapped) try { (/** @type {any} */ (t).denied || (/** @type {any} */ (t).denied = new Set())).add(o); } catch { /* */ } // a size-capped third party is not denied for the tab: one big beacon must not cut it off
        if (eg.blocked.length < 20) eg.blocked.push({ method: String(p.request?.method || "GET"), origin: o, type: String(p.resourceType || ""), ...(session ? { session } : {}), ...(stopped ? {} : { leaked: true }) });
        return;
      }
    }
    const req = { url: p.request?.url || "", method: p.request?.method || "GET", type: p.resourceType || "Other", ts: Date.now() };
    let acted = false;
    for (const rule of [...t.rules.values()]) {
      if (!matcher({ ...rule.filter, status: undefined, since: undefined, frame: undefined })(req)) continue;
      const a = rule.then || {};
      if (a.action === "emit") {
        ctx.emit({ event: "net.event", tab: t.tab, rule: rule.id, request: redact.request({ id: p.networkId || id, method: req.method, url: req.url, type: req.type, paused: true }) });
        continue;
      }
      if (acted) continue;
      if (a.action === "block") {
        judged = true; // from here this request is never continued, whatever happens to the commands that stop it
        await stopRequest(send, id, a.reason || "BlockedByClient");
        acted = true;
      } else if (a.action === "mock") {
        const headers = Object.entries(a.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
        if (!headers.some(h => h.name.toLowerCase() === "content-type")) headers.push({ name: "content-type", value: a.contentType || (typeof a.body === "object" ? "application/json" : "text/plain") });
        const body = typeof a.body === "string" ? a.body : a.body === undefined ? "" : JSON.stringify(a.body);
        await send("Fetch.fulfillRequest", { requestId: id, responseCode: a.status || 200, responseHeaders: headers, body: btoa(unescape(encodeURIComponent(body))) });
        acted = true;
      } else if (a.action === "headers") {
        const cur = { ...(p.request?.headers || {}) };
        for (const k of a.remove || []) for (const n of Object.keys(cur)) if (n.toLowerCase() === String(k).toLowerCase()) delete cur[n];
        for (const [k, v] of Object.entries(a.set || {})) {
          for (const n of Object.keys(cur)) if (n.toLowerCase() === k.toLowerCase()) delete cur[n];
          cur[k] = String(v);
        }
        await send("Fetch.continueRequest", { requestId: id, headers: Object.entries(cur).map(([name, value]) => ({ name, value })) });
        acted = true;
      }
    }
    if (!acted) await send("Fetch.continueRequest", { requestId: id });
  } catch {
    // A request must never hang on a rule that failed: but one judged blocked is never let through (it stays paused rather than go out).
    if (judged) return;
    await Promise.resolve(session ? ctx.cdp.send(t.tab, "Fetch.continueRequest", { requestId: id }, session) : ctx.cdp.send(t.tab, "Fetch.continueRequest", { requestId: id })).catch(() => {});
  }
}

/**
 * The egress guard for a script the person did not ask for by hand (reviewer-2 B1): a script that
 * reads localStorage or a token can send it anywhere with one fetch, and redaction only masks what
 * comes BACK. While the guard is up, every request the tab makes to an origin that is neither its
 * own nor one it already talks to is failed and reported. The known origins are the tab's own, those
 * in its captured traffic (every frame's), those in the resource timing of every readable frame taken
 * before the script runs, and the origins of the tab's own frames (top and children), so a script in a
 * builder iframe that talks to that frame's own API host is not held wrongly. Interception runs on every
 * session of the tab, and stop() puts every session back.
 * @param {any} ctx @param {number} tab
 * @returns {Promise<{ contained: "full"|"partial", why?: string, stop: () => Promise<Array<{ method: string, origin: string }>> }>}
 */
/** The person approved something for this tab (an `asked` call): origins the guard denied are no longer held against it. @param {any} ctx @param {number} tab */
export async function clearDenied(ctx, tab) { try { const t = /** @type {any} */ (await start(ctx, tab)); if (t.denied) t.denied.clear(); } catch { /* no capture */ } }

export async function egressGuard(ctx, tab, frame = null, opts = {}) {
  const t = /** @type {any} */ (await start(ctx, tab));
  const eg = t.egress || (t.egress = { depth: 0, allowed: new Set(), blocked: [] });
  // TEST ONLY (the host sets it under the test flag in a temp profile): the DNR layer alone, to measure it without Fetch. Never on in a real profile.
  if (opts && opts.noFetch === true) eg.noFetch = true;
  if (opts && opts.failEnable === true) eg.failEnable = true; // TEST ONLY, see index.js
  /** Origins this guard has ever judged blocked on this tab: they can never become "allowed" by being observed. @type {Set<string>} */
  const denied = /** @type {any} */ (t).denied || (/** @type {any} */ (t).denied = new Set());
  /** Where each allowed origin came from, for the diagnostics of a leak. @type {Record<string, string>} */
  const prov = eg.prov || (eg.prov = {});
  const add = (/** @type {string} */ u, /** @type {string} */ why = "?") => { try { const x = new URL(String(u)); if (x.origin && x.origin !== "null" && !denied.has(x.origin)) { eg.allowed.add(x.origin); if (!prov[x.origin]) prov[x.origin] = why; } } catch { /* skip */ } };
  // THE RULE. Allowed = the tab's own origin + origins that returned a completed response to a request made outside any guard + (at the first guard only) what the browser itself reports as
  // loaded: frames that actually have a document (the CDP frame tree, never the DOM's iframe elements or their `element:` stubs) and resource-timing entries with a response status.
  // The DOM, frame stubs, attempts and anything a guarded script made can never vouch for an origin.
  try { const tb = await ctx.tabs.get(tab); add(tb && (tb.url || tb.pendingUrl), "tab"); } catch { /* the tab went away */ }
  for (const o of (t.okOrigins || [])) add(o, "response");
  /** @type {any[]} */ let frames = [];
  try { frames = ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(tab) : []; } catch { frames = []; }
  const readable = frames.filter(f => f.readable && !String(f.frameId).startsWith("element:"));
  if (!t.seeded) {
    t.seeded = true;
    t.seedOrigins = new Set();
    for (const f of frames) if (f.how !== "none" && !String(f.frameId).startsWith("element:") && f.origin) t.seedOrigins.add(f.origin);
    // What the page's own resource timing says got a response (responseStatus > 0, Chrome 109+; an engine without the field is taken at its word).
    const timing = "[...new Set(performance.getEntriesByType('resource').filter(e => e.responseStatus === undefined || e.responseStatus > 0).map(e => e.name))].slice(0, 1000)";
    for (const f of (readable.length ? readable : [null])) {
      try { const rt = await runIn(ctx, tab, f, timing, { returnByValue: true }); for (const u of (rt && rt.result && rt.result.value) || []) { try { t.seedOrigins.add(new URL(String(u)).origin); } catch { /* */ } } } catch { /* the guard still stands with what it has */ }
    }
  }
  for (const o of t.seedOrigins) add(o, "first-guard");
  // The first party: the tab's own origin and the origin of the frame the script runs in. Every other allowed origin (a chat widget's iframe, an analytics host) is a third party
  // and gets the small-request budget in paused(). A frame the script runs in is named by the caller, so a page's third-party iframe never becomes first party by loading.
  eg.first = new Set([...eg.allowed].filter(o => prov[o] === "tab"));
  if (frame && frame.origin && !(t.denied && t.denied.has(frame.origin))) eg.first.add(frame.origin);
  if (!eg.noFetch) (/** @type {any} */ (t)).evalTag = (/** @type {any} */ (t)).evalTag || "vyre-eval-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  if (eg.depth === 0 && ctx.dnr) {
    const hosts = [...eg.allowed].map(o => { try { return new URL(o).hostname; } catch { return ""; } }).filter(Boolean);
    // New WebSockets: only the FIRST PARTY's host (any port; ws and wss), never a third party's. Existing sockets are not touched by any of this.
    const wsHosts = [...new Set([...eg.first].map(o => { try { return new URL(o).hostname; } catch { return ""; } }).filter(Boolean))];
    const b = await ctx.dnr.block({ tab, allowOrigins: [...eg.allowed], initiatorHosts: [...new Set(hosts)], wsHosts });
    eg.rule = b && b.ids && b.ids.length ? b.ids : b && b.id != null ? b.id : null;
    eg.dnrTested = !!(b && b.tested); eg.dnrArgs = { initiatorHosts: [...new Set(hosts)], wsHosts };
    eg.contained = b && b.ok ? "full" : "partial";
    eg.containedWhy = b && !b.ok ? b.why : undefined;
    // UNTIL the stage has proved zero requests for a worker from a pristine iframe, a mid-script frame, window.open and a script rewriting its allow list, the browser-level rule is REQUIRED:
    // if it could not be set the script does not run (it is the only layer for a new frame's first requests and for a worker's fetch).
    if (!(b && b.ok)) { t.egress = null; throw refuse("blocked", `the browser-level network rule could not be set (${String(eg.containedWhy || "unknown").slice(0, 100)}), so a script is not run on this page`); }

  }
  eg.depth++;
  // The Fetch domain does not see a WebSocket handshake and Network.setBlockedURLs did not stop a new one in a real Chrome
  // (measured in CI). Two layers instead: a declarativeNetRequest session rule for this tab (every frame, no page cooperation,
  // set above) and the page shim in outbound.js for the plain forms, which also reports what it refused.
  // New children start PAUSED while the guard is up: interception goes on before they run a line. If the tab would not accept that, the guard says so (a frame could start unpaused).
  if (eg.depth === 1 && !eg.noFetch && ctx.cdp && typeof ctx.cdp.setPause === "function") { const okPause = await Promise.race([ctx.cdp.setPause(tab, true), new Promise(res => setTimeout(() => res(false), 2500))]); if (!okPause) eg.pauseWhy = "a new frame could start before the guard reached it"; }
  const failed = eg.noFetch ? [] : await syncFetch(ctx, t);
  eg.failedSessions = failed || [];
  // A child frame that would not take the interception is a way out: the script does not run, and the guard is taken down again.
  if (failed && failed.length) {
    if (--eg.depth <= 0) { const rule = eg.rule; t.egress = null; if (ctx.dnr) await ctx.dnr.unblock(rule ?? null); await syncFetch(ctx, t); }
    throw refuse("blocked", `a frame of this page would not accept the network guard (${failed.length} session${failed.length === 1 ? "" : "s"}), so a script is not run on it`);
  }
  // PROOF OF LIFE: the interception is confirmed live in the frame the script will run in (an Image and a fetch to an unroutable host are paused) or the script does not run.
  if (!eg.noFetch && !(await probeGuard(ctx, t, eg, frame))) {
    if (--eg.depth <= 0) { const rule = eg.rule; t.egress = null; if (ctx.cdp && typeof ctx.cdp.setPause === "function") await bounded(ctx.cdp.setPause(tab, false), 2500); if (ctx.dnr) await ctx.dnr.unblock(rule ?? null); await syncFetch(ctx, t); }
    throw refuse("blocked", "the network guard could not be confirmed live in this frame (a probe request was not intercepted), so a script is not run on it" + (opts && opts.diag ? ` [diag ${JSON.stringify({ paused: eg.pausedCount || 0, seen: [...(eg.probeSeen || [])], netSeen: eg.netSeen || [], sw: [...(eg.probeSw || [])], skipped: eg.probeSkipped || 0, sessions: [...t.sessions].length, failed: eg.failedSessions || [], rule: eg.rule })}]` : ""));
  }
  // A frame a service worker controls has no Fetch interception (so no size cap or third-party budget either): it rests on the browser-level rules alone. Those must have been proven by
  // testMatchOutcome (tab and tab-less rule; only an unpacked extension has it, so on a packed one such a frame is refused), and for the guard's window the rules allow the FIRST PARTY only,
  // so a script cannot send an unbounded amount to a third party on the page's list.
  if (eg.swFrames && eg.swFrames.length && !eg.noFetch) {
    const fail = async (/** @type {string} */ why) => {
      if (--eg.depth <= 0) { const rule = eg.rule; t.egress = null; if (ctx.cdp && typeof ctx.cdp.setPause === "function") await bounded(ctx.cdp.setPause(tab, false), 2500); if (ctx.dnr) await ctx.dnr.unblock(rule ?? null); await syncFetch(ctx, t); }
      throw refuse("blocked", why);
    };
    if (!eg.dnrTested) await fail("a service worker answers this page's requests and this browser cannot test the network rules against it, so a script is not run on it");
    const a = eg.dnrArgs || { initiatorHosts: [], wsHosts: [] };
    // The wide rules come off FIRST: two block rules of the same priority would hide the new one from testMatchOutcome (only one is reported), and the script has not started.
    await ctx.dnr.unblock(eg.rule ?? null); eg.rule = null;
    const narrow = await ctx.dnr.block({ tab, allowOrigins: [...eg.first], initiatorHosts: a.initiatorHosts, wsHosts: a.wsHosts });
    if (!(narrow && narrow.ok && narrow.tested)) await fail("the network rules for a page with a service worker could not be confirmed, so a script is not run on it");
    eg.rule = narrow.ids;
    eg.allowed = new Set(eg.first);
  }
  // From here on the script runs: a frame or worker that attaches now was made by it (or by the page while it ran).
  eg.live = true; mark(t, "start:live");
  // A same-origin frame the script makes starts with a window of its own that the page shim never saw: its Worker would be an unguarded route out. Every new document made while the guard is up
  // gets the same refusal before any script of it runs (removed again at stop). Not used in the test-only DNR-alone mode.
  if (!eg.noFetch && eg.depth === 1) { try { const nd = await bounded(ctx.cdp.send(tab, "Page.addScriptToEvaluateOnNewDocument", { source: NO_WORKERS_SRC })); eg.newDoc = nd && nd.identifier; } catch { /* the shim and the closing of a worker at return remain */ } }
  let done = false;
  return {
    // "partial" when the browser-level rule could not be set: only the plain-form page shim stands for WebSockets and beacons.
    contained: eg.contained || (ctx.dnr ? "full" : "partial"), why: eg.containedWhy,
    /** The sourceURL the caller puts on the script it runs, so a request it starts later names it in its initiator stack. */
    tag: eg.noFetch ? "" : /** @type {any} */ (t).evalTag,
    /** The origins the script may reach: for the page-level shim, a second layer beside the browser-level guard. */
    allowed: [...eg.allowed],
    /** Everything needed to prove the path of a leak: where each allowed origin came from, every request the guard judged, and which child sessions took the interception. */
    diag: () => ({ paused: eg.pausedCount || 0, probe: [...(eg.probeSeen || [])], allowed: { ...prov }, decisions: (eg.decisions || []).slice(0, 40), sessions: [...t.sessions].map(k => ({ session: String(k).slice(-6), fetch: !(eg.failedSessions || []).includes(k) })), denied: [...denied] }),
    async stop() {
      if (done) return [];
      done = true; mark(t, "stop:begin");
      // A BARRIER, not a clock: a worker or frame the script made is announced to us by the browser (Target.attachedToTarget) and may still be on its way when the script returns. A command answered
      // by the browser process queues behind every event the browser has already sent, so what the script created before it returned has attached by the time these answer.
      if (eg.depth <= 1 && !eg.noFetch) {
        await bounded(ctx.cdp.send(tab, "Target.getTargetInfo", {}));
        await bounded(ctx.cdp.send(tab, "Runtime.evaluate", { expression: "1", returnByValue: true }));
        await new Promise(r => setTimeout(r, 0));
        if (eg.newDoc) await bounded(ctx.cdp.send(tab, "Page.removeScriptToEvaluateOnNewDocument", { identifier: eg.newDoc }));
        mark(t, "stop:barrier-done");
      }
      // A request judged blocked whose failRequest never took is tried once more now, while Fetch is still on: once it is off the request would be released to the network.
      for (const sr of (eg.stuck || []).splice(0)) {
        const send2 = (/** @type {string} */ m, /** @type {any} */ x) => (sr.session ? ctx.cdp.send(t.tab, m, x, sr.session) : ctx.cdp.send(t.tab, m, x));
        const ok = await stopRequest(send2, sr.id, "BlockedByClient").catch(() => false);
        if (ok) for (const b of eg.blocked) if (b.leaked && !b.retried) { b.leaked = false; b.retried = true; break; }
      }
      const blocked = eg.blocked.splice(0);
      /** @type {any} */ (t).lastGuard = { paused: eg.pausedCount || 0, blocked: blocked.slice(0, 8), decisions: (eg.decisions || []).slice(0, 40), failedSessions: eg.failedSessions || [], noFetch: !!eg.noFetch, rule: eg.rule, failed: eg.failed || 0, enableErrors: eg.enableErrors || [], noFetchTargets: eg.noFetchTargets || 0, closedWorkers: eg.closedWorkers || 0, neutralized: eg.neutralized || 0, leftPaused: eg.leftPaused || 0, swFrames: eg.swFrames || [], attached: eg.attached || [] }; // read back by the test harness only (net.list under trust.diag)
      // A frame or worker that started during the script and could not be guarded is reported like a leak: it MAY have sent requests.
      if (eg.failed) blocked.push({ method: "GUARD", origin: "stopped: a frame could not be guarded", stopped: true });
      if (eg.pauseWhy && !blocked.length) blocked.push({ method: "GUARD", origin: eg.pauseWhy, leaked: true });
      if (eg.depth <= 1) { for (const [key, r] of [...t.recs]) { if ((/** @type {any} */ (t).denied || new Set()).has(docOrigin(r.url))) t.recs.delete(key); } }
      if (--eg.depth <= 0) {
        const rule = eg.rule;
        // THE CLOCK-FREE RULE. The call has returned, but what it started has not stopped: a timer, a promise chain, a worker or a frame it made. From here until the page navigates, a request whose
        // initiator stack names the eval's sourceURL, and every request of a child that attached while the guard was up, is still judged against the allowed set as it stood now (frozen); Fetch
        // stays on for that, and so does pausing new children at birth, so a worker that attaches late is caught before its first line. While a worker lives the tab-less DNR rule stays up too.
        if (!eg.noFetch && /** @type {any} */ (t).evalTag) {
          const prev = /** @type {any} */ (t).sticky;
          const kids = new Map(prev ? prev.kids : []);
          for (const [k, v] of (eg.kidSessions || [])) {
            if (!t.sessions.has(k)) continue;
            // Chrome has no Fetch interception on a dedicated worker, and the browser rules cannot tell a worker's request from the page's: a worker the script made does not outlive the call.
            if (/worker/.test(String(v))) { eg.closedWorkers = (eg.closedWorkers || 0) + 1; await bounded(ctx.cdp.send(tab, "Runtime.evaluate", { expression: "self.close()", returnByValue: true }, k)); t.sessions.delete(k); (/** @type {any} */ (t).closed || (/** @type {any} */ (t).closed = new Set())).add(k); }
            else kids.set(k, v);
          }
          /** @type {any} */ (t).sticky = { tag: /** @type {any} */ (t).evalTag, allowed: new Set(eg.allowed), first: new Set(eg.first), kids, hosts: (eg.dnrArgs && eg.dnrArgs.initiatorHosts) || (prev ? prev.hosts : []) };
        }
        t.egress = null; mark(t, "stop:egress-null");
        if (ctx.cdp && typeof ctx.cdp.setPause === "function") await bounded(ctx.cdp.setPause(tab, false), 2500);
        // A child that could not be guarded was held paused; it starts running now, and the browser-level rules stay up while it does (a worker's first fetch runs within milliseconds of its release).
        if (eg.failed) await new Promise(r => setTimeout(r, 400));
        mark(t, "stop:pause-done");
        if (ctx.dnr) await ctx.dnr.unblock(rule ?? null);
        mark(t, "stop:dnr-off");
        await syncFetch(ctx, t);
        mark(t, "stop:syncfetch-done");
      }
      return blocked;
    },
  };
}

/** Re-declare the Fetch patterns from the guard and the rules that exist, on the top session and every child session, or switch Fetch off everywhere when none do. @param {any} ctx @param {TabNet} t */
/** End the sticky guard: the page navigated away from the scripts it was watching. @param {any} ctx @param {any} t */
async function clearSticky(ctx, t) {
  const st = t.sticky; if (!st) return;
  t.sticky = null;
  if (!t.egress) { if (ctx.cdp && typeof ctx.cdp.setPause === "function") await bounded(ctx.cdp.setPause(t.tab, false), 2500); await syncFetch(ctx, t); }
}
/** A main-frame navigation ends it; a sub-frame's document load does not. @param {any} ctx @param {any} t @param {string} frameId */
async function clearStickyIfTop(ctx, t, frameId) {
  try {
    const list = ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(t.tab) : [];
    const top = list.find((/** @type {any} */ f) => f.how === "top");
    if (top && String(top.frameId) === String(frameId)) await clearSticky(ctx, t);
  } catch { /* the frame list is gone: the next navigation tries again */ }
}

async function syncFetch(ctx, t) {
  /** @type {string[]} */ const none = [];
  /** @type {(m: string, x: any, session?: string) => Promise<any>} */
  const send = (m, x, session) => (session ? ctx.cdp.send(t.tab, m, x, session) : ctx.cdp.send(t.tab, m, x));
  const guardOn = (/** @type {any} */ (t).egress && !/** @type {any} */ (t).egress.noFetch) || /** @type {any} */ (t).sticky;
  if (!guardOn && !t.rules.size) {
    const kids = [...t.sessions];
    if (t.fetchOn) {
      t.fetchOn = false; t.fetchPats = null;
      await Promise.resolve(send("Fetch.disable", {})).catch(() => {});
      await Promise.all(kids.map(k => Promise.resolve(send("Fetch.disable", {}, k)).catch(() => {})));
    }
    return none;
  }
  // Every child session the tab has RIGHT NOW joins the guard, not only the ones capture already knew about (a frame that attached a moment ago is a way out).
  await syncSessions(ctx, t);
  const pats = new Set();
  if (guardOn) pats.add("*");
  for (const r of t.rules.values()) {
    const u = r.filter?.url;
    pats.add(typeof u === "string" && u && !/[*?]/.test(u) ? `*${u}*` : "*");
  }
  const list = pats.has("*") ? ["*"] : [...pats];
  t.fetchOn = true; t.fetchPats = list;
  const arg = { patterns: list.map(urlPattern => ({ urlPattern, requestStage: "Request" })) };
  await send("Fetch.enable", arg);
  const kids = [...t.sessions];
  /** @type {string[]} */ const failed = [];
  // A worker that was already running when the guard went up is the page's own and cannot be reached by the script (new ones are refused by the shim and paused at birth).
  const workerSessions = new Set((typeof ctx.cdp.children === "function" ? ctx.cdp.children(t.tab) : []).filter((/** @type {any} */ c) => /worker/.test(String(c.type))).map((/** @type {any} */ c) => c.sessionId));
  await Promise.all(kids.map(k => Promise.race([Promise.resolve(send("Fetch.enable", arg, k)), new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 1500))]).catch((/** @type {any} */ e) => { if (!/not found|no session|closed|detached|gone|target/i.test(String(e && e.message || e)) && !workerSessions.has(k)) failed.push(k); })));
  return failed;
}

/**
 * Run a script in one frame of a tab: its own session, its own execution context, or the top page (no frame).
 * @param {any} ctx @param {number} tab @param {any} frame a lib/frames.js Frame, or null for the top page @param {string} expression @param {any} [params]
 */
export async function runIn(ctx, tab, frame, expression, params = {}) {
  if (frame && frame.how !== "top") {
    if (ctx.frames && typeof ctx.frames.evalIn === "function") return ctx.frames.evalIn(tab, frame, expression, params);
    if (frame.session) return ctx.cdp.send(tab, "Runtime.evaluate", { expression, ...params }, frame.session);
  }
  return ctx.cdp.send(tab, "Runtime.evaluate", { expression, ...params });
}

/** The frames of a tab, or none when the shell has no frame layer (or the tree cannot be read). @param {any} ctx @param {number} tab @returns {Promise<any[]>} */
export async function frameList(ctx, tab) {
  try { return ctx.frames && typeof ctx.frames.list === "function" ? await ctx.frames.list(tab) : []; } catch { return []; }
}

/**
 * Run fetch inside the page so the page's cookies authenticate it. The origin guard lives in the
 * page too: a tab that navigated away between capture and replay fails instead of sending
 * credentials somewhere else.
 * @param {any} ctx @param {number} tab
 * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: string }} req
 * @param {{ origin?: string, frame?: any, gate?: { pass?: symbol } }} [opts] `gate`: what writeGate() returned. A write without its pass is refused here, whatever the caller did. `frame`: run the fetch INSIDE that frame (lib/frames.js Frame), so its own cookies sign it;
 *   `origin` is then compared against that frame's origin, not the top page's.
 */
export async function pageFetch(ctx, tab, req, opts = {}) {
  // The last line of the write gate: no request that changes anything is issued with the page's credentials without the pass from writeGate().
  if (!/^(GET|HEAD|OPTIONS)$/i.test(String(req.method || "GET")) && !(opts.gate && opts.gate.pass === PASS)) throw refuse("blocked", "a write was about to be made with the page's login without passing the write gate; nothing was sent");
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const n = k.toLowerCase();
    if (NO_SET.has(n) || n.startsWith("sec-") || n.startsWith(":")) continue;
    /** @type {any} */ (headers)[k] = v;
  }
  const payload = { url: req.url, init: { method: req.method || "GET", headers, credentials: "include", ...(req.body != null && !/^(GET|HEAD)$/i.test(req.method || "GET") ? { body: req.body } : {}) }, origin: opts.origin || "", max: BODY_PRECAP };
  const expression = `(async (P) => {
    if (P.origin && location.origin !== P.origin) return { originMismatch: location.origin };
    const r = await fetch(P.url, P.init);
    const t = await r.text();
    return { status: r.status, mime: (r.headers.get("content-type") || "").split(";")[0], headers: Object.fromEntries(r.headers), body: t.slice(0, P.max) };
  })(${JSON.stringify(payload)})`;
  await attachOnce(ctx, tab);
  const res = await runIn(ctx, tab, opts.frame, expression, { awaitPromise: true, returnByValue: true, timeout: 30_000 });
  if (res?.exceptionDetails) throw refuse("bad_request", "the page could not make that request: " + String(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "error").split("\n")[0]);
  const v = res?.result?.value;
  if (!v) throw refuse("bad_request", "the page returned nothing");
  if (v.originMismatch) throw refuse("bad_request", `${opts.frame && opts.frame.how !== "top" ? "the frame" : "the tab"} is now on ${redact.url(v.originMismatch)}, not the origin this request belongs to`);
  return { status: v.status, mime: v.mime, headers: v.headers, body: v.body, sentHeaders: headers };
}

/** @param {string} u */
const originOf = u => { try { return new URL(u).origin; } catch { return ""; } };

/** The filter with the top-level `frame` argument folded in. @param {any} args */
const withFrame = args => (args?.frame != null && args.frame !== "" ? { ...(args.filter || {}), frame: args.frame } : args?.filter);

/** Where a record's frame sits in ctx.frames.list, when that is known: its own session's frame, else the first frame of that origin in the top session. @param {any[]} frames @param {Rec} r */
function frameIndex(frames, r) {
  if (!frames.length || !r.frame) return {};
  const f = (r.session && frames.find(x => x.session === r.session)) || frames.find(x => !x.session && x.origin === r.frame) || frames.find(x => x.origin === r.frame);
  return f ? { frameIndex: f.index } : {};
}

/** The frame a captured request came from, as a lib/frames.js Frame, for running something in it. @param {any} ctx @param {number} tab @param {Rec} r */
async function frameOfRec(ctx, tab, r) {
  const frames = await frameList(ctx, tab);
  if (!frames.length) return null;
  const f = (r.session && frames.find(x => x.session === r.session)) || (r.frame ? frames.find(x => x.readable && x.origin === r.frame) : null);
  return f || null;
}

/** @type {Record<string, (args: any, ctx: any) => Promise<any>>} */
const ops = {
  async "net.start"(args, ctx) {
    const tab = await target(ctx, args, "net.start");
    const t = await start(ctx, tab, { maxRequests: args?.maxRequests, maxBytes: args?.maxBytes });
    return { started: true, tab, maxRequests: t.maxRequests, maxBytes: t.maxBytes, buffered: t.recs.size };
  },

  async "net.list"(args, ctx, trust = {}) {
    const tab = await target(ctx, args, "net.list");
    const t = await start(ctx, tab);
    const limit = Math.min(Number(args?.limit) || 100, 500);
    const m = matcher(withFrame(args));
    const tier = await ctx.floorTier();
    const all = [...t.recs.values()].filter(r => tier(r.url) !== "blind").filter(m);
    const frames = all.some(r => r.frame) ? await frameList(ctx, tab) : [];
    const rows = all.slice(-limit).map(r => redact.request({ ...summary(r), ...frameIndex(frames, r) }));
    return { count: rows.length, matched: all.length, buffered: t.recs.size, requests: rows, ...(trust.diag === true && /** @type {any} */ (t).lastGuard ? { lastGuard: /** @type {any} */ (t).lastGuard } : {}), ...(trust.diag === true ? { trail: /** @type {any} */ (t).trail || [] } : {}), ...(trust.diag === true ? { sticky: /** @type {any} */ (t).sticky ? { kids: [...(/** @type {any} */ (t).sticky.kids)], judged: /** @type {any} */ (t).sticky.judged || 0, hosts: /** @type {any} */ (t).sticky.hosts || [], allowed: [...(/** @type {any} */ (t).sticky.allowed)] } : null } : {}) };
  },

  async "net.get"(args, ctx) {
    const tab = await target(ctx, args, "net.get");
    const t = await start(ctx, tab);
    const r = t.recs.get(String(args?.id));
    if (!r || blindUrl(r.url)) throw refuse("not_found", "no captured request with that id (it may have been evicted)");
    /** @type {any} */
    const view = { ...summary(r), requestHeaders: r.reqHeaders, responseHeaders: r.resHeaders };
    const tier = (await ctx.floorUrl(r.url, "net.get")).tier;
    if (tier === "blind") throw refuse("not_found", "no captured request with that id (it may have been evicted)");
    if (args?.bodies && tier === "open") {
      if (r.postData !== undefined) view.requestBody = r.postData;
      if (r.done && !r.failed) {
        try {
          const b = r.session ? await ctx.cdp.send(tab, "Network.getResponseBody", { requestId: r.requestId }, r.session) : await ctx.cdp.send(tab, "Network.getResponseBody", { requestId: r.requestId });
          view.responseBody = b?.base64Encoded ? `[binary ${String(b.body || "").length} base64 characters]` : String(b?.body ?? "");
        } catch (e) {
          view.responseBodyError = "Chrome no longer holds this body";
        }
      }
    }
    return present(view);
  },

  async "net.watch"(args, ctx) {
    const tab = await target(ctx, args, "net.watch");
    const t = await start(ctx, tab);
    const watchId = `w${++t.watchSeq}`;
    t.watchers.set(watchId, withFrame(args) || {});
    return { watchId, limitPerSecond: WATCH_PER_SECOND };
  },

  async "net.unwatch"(args, ctx) {
    const tab = await target(ctx, args, "net.unwatch");
    const t = root(ctx).tabs.get(tab);
    if (!t) return { removed: 0 };
    if (args?.watchId) return { removed: t.watchers.delete(String(args.watchId)) ? 1 : 0 };
    const n = t.watchers.size;
    t.watchers.clear();
    return { removed: n };
  },

  async "net.on"(args, ctx) {
    const then = args?.then;
    const action = then?.action;
    if (!["block", "mock", "headers", "emit"].includes(action)) throw refuse("bad_request", "then.action must be block, mock, headers or emit");
    const acting = action !== "emit";
    const tab = await target(ctx, args, acting ? "net.intercept" : "net.on", acting);
    const t = await start(ctx, tab);
    const ttlMs = Math.max(1000, Math.min(Number(args?.ttlMs) || RULE_TTL, 60 * 60_000));
    const id = `r${++t.ruleSeq}`;
    /** @type {Rule} */
    const rule = { id, filter: args?.filter || {}, then, ttlMs, expiresAt: Date.now() + ttlMs, timer: null };
    rule.timer = setTimeout(() => { t.rules.delete(id); void syncFetch(ctx, t); }, ttlMs);
    rule.timer?.unref?.();
    t.rules.set(id, rule);
    await syncFetch(ctx, t);
    return { ruleId: id, action, ttlMs, expiresAt: rule.expiresAt };
  },

  async "net.rules"(args, ctx) {
    const tab = await target(ctx, args, "net.rules");
    const t = root(ctx).tabs.get(tab);
    const rules = [...(t?.rules.values() || [])].map(r => ({
      ruleId: r.id, filter: r.filter, action: r.then.action, expiresAt: r.expiresAt,
      detail: r.then.action === "mock" ? { status: r.then.status || 200, bodyLength: typeof r.then.body === "string" ? r.then.body.length : JSON.stringify(r.then.body ?? "").length }
        : r.then.action === "headers" ? { set: Object.keys(r.then.set || {}), remove: r.then.remove || [] } : {},
    }));
    return { rules };
  },

  async "net.off"(args, ctx) {
    const tab = await target(ctx, args, "net.off");
    const t = root(ctx).tabs.get(tab);
    const r = t?.rules.get(String(args?.ruleId));
    if (!t || !r) throw refuse("not_found", "no such rule");
    clearTimeout(r.timer);
    t.rules.delete(r.id);
    await syncFetch(ctx, t);
    return { removed: r.id };
  },

  async "net.replay"(args, ctx, trust = {}) {
    const tab0 = args?.tab;
    // The method decides the floor op: a GET replay reads, anything else is acting.
    const t0 = tab0 == null ? null : root(ctx).tabs.get(tab0);
    const peek = t0?.recs.get(String(args?.id));
    const method = String(args?.overrides?.method || peek?.method || "GET").toUpperCase();
    const acting = !/^(GET|HEAD)$/.test(method);
    const tab = await target(ctx, args, acting ? "net.intercept" : "net.get", acting);
    const t = await start(ctx, tab);
    const r = t.recs.get(String(args?.id));
    if (!r) throw refuse("not_found", "no captured request with that id (it may have been evicted)");
    const o = args?.overrides || {};
    const m = String(o.method || r.method).toUpperCase();
    if (!/^(GET|HEAD)$/.test(m) && !acting) throw refuse("blocked", "a replay that changes the method is an acting request");
    const url = new URL(String(o.url || r.url), r.url).toString();
    if (originOf(url) !== originOf(r.url)) throw refuse("bad_request", "a replay stays on the origin it was captured from");
    const headers = { ...r.reqHeaders, ...(o.headers || {}) };
    const body = o.body !== undefined ? (typeof o.body === "string" ? o.body : JSON.stringify(o.body)) : r.postData;
    // A replay that SENDS something as the person waits at the Gate unless the person asked (P17).
    const ob = classifySend(m, url, typeof body === "string" ? body : "");
    if (ob.send && trust.asked !== true) return held(m, url, ob.why, `${m} ${url} ${typeof body === "string" ? body : ""}`);
    // Any other write is a change made with the person's login: the one write gate decides (asked, or a plan the module says covers it).
    const gate = writeGate(m, url, typeof body === "string" ? body : "", trust);
    if (gate.held) return gate.held;
    // A request a child frame made is replayed inside that frame: its own cookies and origin sign it.
    const frame = r.session || r.frame ? await frameOfRec(ctx, tab, r) : null;
    const res = await pageFetch(ctx, tab, { url, method: m, headers, body }, { origin: frame ? r.frame || frame.origin : originOf(r.url), frame, gate });
    return present({ method: m, url, status: res.status, mime: res.mime, requestHeaders: res.sentHeaders, requestBody: body, responseHeaders: res.headers, responseBody: res.body, replayOf: r.id });
  },
};

export default {
  name: "net",
  ops,
  /** Tab gone: rules, watchers and buffer go with it. @param {any} evt @param {any} ctx */
  onEvent(evt, ctx) {
    const kind = String(evt?.event ?? evt?.type ?? "");
    const tab = evt?.tab ?? evt?.tabId;
    if (tab != null && /remov|clos|detach/i.test(kind)) forget(root(ctx).tabs, tab);
  },
};
