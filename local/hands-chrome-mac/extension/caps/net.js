// @ts-check
// net: the network buffer, live watch, acting on requests, and replay.
//
// RAW STAYS IN THE WORKER. Headers, cookies and bodies are kept exactly as Chrome reported them
// because replay and api.call need the real Authorization header, but nothing that leaves this
// file is raw: every return and every emitted event goes through redact.request. There is no
// argument that asks for a raw value.
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
import { classifySend, held } from "../shared/outbound.js";
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
 *   timing?: any, sent?: number, encoded?: number, dataLength?: number, done?: boolean, failed?: string, endTs?: number, size: number }} Rec
 * @typedef {{ id: string, filter: any, then: any, ttlMs: number, expiresAt: number, timer: any }} Rule
 * @typedef {{ tab: number, recs: Map<string, Rec>, bytes: number, maxRequests: number, maxBytes: number, seq: number,
 *   rules: Map<string, Rule>, ruleSeq: number, watchers: Map<string, any>, watchSeq: number, win: number, winCount: number, dropped: number, fetchOn: boolean, redirects: number }} TabNet
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
  ctx.cdp.on((/** @type {number} */ tab, /** @type {string} */ method, /** @type {any} */ params) => {
    const t = tabs.get(tab);
    if (!t) return;
    if (method === "Inspector.detached") return forget(tabs, tab);
    try { handle(ctx, t, method, params || {}); } catch { /* one bad event must not break the buffer */ }
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
    t = { tab, recs: new Map(), bytes: 0, maxRequests: DEFAULT_MAX_REQUESTS, maxBytes: DEFAULT_MAX_BYTES, seq: 0, rules: new Map(), ruleSeq: 0, watchers: new Map(), watchSeq: 0, win: 0, winCount: 0, dropped: 0, fetchOn: false, redirects: 0 };
    tabs.set(tab, t);
  }
  if (opts.maxRequests) t.maxRequests = Math.max(1, Math.min(5000, Math.floor(opts.maxRequests)));
  if (opts.maxBytes) t.maxBytes = Math.max(1024, Math.floor(opts.maxBytes));
  evict(t);
  if (fresh) {
    await attachOnce(ctx, tab);
    await ctx.cdp.send(tab, "Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 5_000_000 });
  }
  return t;
}

/**
 * The buffer must never outlive the floor (reviewer-2): a tab that goes to a bank or a Vyre surface
 * and comes back must not hand its traffic to a later net.list, net.get or api.learn. Each record
 * is judged by its own URL, and a navigation to a blind page empties the tab's buffer.
 * @param {string} url
 */
const blindUrl = url => classify(url, undefined, {}).tier === "blind";

/** @param {TabNet} t */
function purge(t) { t.recs.clear(); t.bytes = 0; }

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

/** @param {any} ctx @param {TabNet} t @param {string} method @param {any} p */
function handle(ctx, t, method, p) {
  if (method === "Network.requestWillBeSent") {
    const old = t.recs.get(p.requestId);
    if (old && p.redirectResponse) {
      // Keep the hop that redirected under its own key so the chain stays visible.
      t.recs.delete(p.requestId);
      old.status = p.redirectResponse.status;
      old.done = true;
      t.recs.set(`${p.requestId}#${++t.redirects}`, old);
    }
    // A document load is a navigation (a tab or a frame): if it goes somewhere blind, forget the
    // buffer now, before anything else can be read from it. The built-in list decides here at once;
    // the person's own blind list is asked right after.
    if (p.type === "Document" && p.request?.url) {
      const u = String(p.request.url);
      if (blindUrl(u)) { purge(t); return; }
      void ctx.floorUrl(u, "net.list").then((/** @type {any} */ v) => { if (v && v.tier === "blind") purge(t); }, () => {});
    }
    /** @type {Rec} */
    const r = { id: p.requestId, seq: ++t.seq, ts: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(), method: p.request?.method || "GET", url: p.request?.url || "", type: p.type || "Other", initiator: p.initiator || {}, reqHeaders: { ...(p.request?.headers || {}) }, resHeaders: {}, postData: p.request?.postData, size: 0 };
    r.size = weigh(r);
    t.recs.set(r.id, r);
    t.bytes += r.size;
    evict(t);
    return;
  }
  const r = t.recs.get(p.requestId);
  if (method === "Fetch.requestPaused") { void paused(ctx, t, p); return; }
  if (!r) return;
  if (method === "Network.requestWillBeSentExtraInfo") { Object.assign(r.reqHeaders, p.headers || {}); reweigh(t, r); }
  else if (method === "Network.responseReceived") {
    r.status = p.response?.status;
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
    initiator: { type: r.initiator?.type, ...(r.initiator?.url ? { url: safeUrl(r.initiator.url) } : {}), ...(r.initiator?.lineNumber != null ? { line: r.initiator.lineNumber } : {}) },
    startedAt: r.ts,
    durationMs: t && r.endTs != null && t.requestTime ? Math.max(0, Math.round((r.endTs - t.requestTime) * 1000)) : undefined,
    sizes: { request: r.postData?.length ?? 0, response: r.dataLength ?? 0, encoded: r.encoded ?? 0 },
    ...(r.failed ? { failed: r.failed } : {}),
    ...(r.done ? {} : { pending: true }),
  };
}

/** @param {{ url?: string, method?: string, status?: any, type?: string, since?: number } | undefined} f */
export function matcher(f) {
  const url = f?.url ? String(f.url).toLowerCase() : "";
  const method = f?.method ? String(f.method).toUpperCase() : "";
  const type = f?.type ? String(f.type).toLowerCase() : "";
  const status = f?.status;
  const since = Number(f?.since) || 0;
  /** @param {{ url: string, method: string, type: string, status?: number, ts?: number }} r */
  return r => {
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

/** Pause handling: first matching acting rule wins, emit rules always fire, everything else continues. @param {any} ctx @param {TabNet} t @param {any} p */
async function paused(ctx, t, p) {
  const id = p.requestId;
  const send = (/** @type {string} */ m, /** @type {any} */ x) => ctx.cdp.send(t.tab, m, x);
  try {
    const req = { url: p.request?.url || "", method: p.request?.method || "GET", type: p.resourceType || "Other", ts: Date.now() };
    let acted = false;
    for (const rule of [...t.rules.values()]) {
      if (!matcher({ ...rule.filter, status: undefined, since: undefined })(req)) continue;
      const a = rule.then || {};
      if (a.action === "emit") {
        ctx.emit({ event: "net.event", tab: t.tab, rule: rule.id, request: redact.request({ id: p.networkId || id, method: req.method, url: req.url, type: req.type, paused: true }) });
        continue;
      }
      if (acted) continue;
      if (a.action === "block") {
        await send("Fetch.failRequest", { requestId: id, errorReason: a.reason || "BlockedByClient" });
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
    // A request must never hang on a rule that failed.
    await Promise.resolve(ctx.cdp.send(t.tab, "Fetch.continueRequest", { requestId: id })).catch(() => {});
  }
}

/** Re-declare the Fetch patterns from the rules that exist, or switch Fetch off when none do. @param {any} ctx @param {TabNet} t */
async function syncFetch(ctx, t) {
  if (!t.rules.size) {
    if (t.fetchOn) { t.fetchOn = false; await Promise.resolve(ctx.cdp.send(t.tab, "Fetch.disable", {})).catch(() => {}); }
    return;
  }
  const pats = new Set();
  for (const r of t.rules.values()) {
    const u = r.filter?.url;
    pats.add(typeof u === "string" && u && !/[*?]/.test(u) ? `*${u}*` : "*");
  }
  const list = pats.has("*") ? ["*"] : [...pats];
  t.fetchOn = true;
  await ctx.cdp.send(t.tab, "Fetch.enable", { patterns: list.map(urlPattern => ({ urlPattern, requestStage: "Request" })) });
}

/**
 * Run fetch inside the page so the page's cookies authenticate it. The origin guard lives in the
 * page too: a tab that navigated away between capture and replay fails instead of sending
 * credentials somewhere else.
 * @param {any} ctx @param {number} tab
 * @param {{ url: string, method?: string, headers?: Record<string, string>, body?: string }} req
 * @param {{ origin?: string }} [opts]
 */
export async function pageFetch(ctx, tab, req, opts = {}) {
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
  const res = await ctx.cdp.send(tab, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: 30_000 });
  if (res?.exceptionDetails) throw refuse("bad_request", "the page could not make that request: " + String(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "error").split("\n")[0]);
  const v = res?.result?.value;
  if (!v) throw refuse("bad_request", "the page returned nothing");
  if (v.originMismatch) throw refuse("bad_request", `the tab is now on ${redact.url(v.originMismatch)}, not the origin this request belongs to`);
  return { status: v.status, mime: v.mime, headers: v.headers, body: v.body, sentHeaders: headers };
}

/** @param {string} u */
const originOf = u => { try { return new URL(u).origin; } catch { return ""; } };

/** @type {Record<string, (args: any, ctx: any) => Promise<any>>} */
const ops = {
  async "net.start"(args, ctx) {
    const tab = await target(ctx, args, "net.start");
    const t = await start(ctx, tab, { maxRequests: args?.maxRequests, maxBytes: args?.maxBytes });
    return { started: true, tab, maxRequests: t.maxRequests, maxBytes: t.maxBytes, buffered: t.recs.size };
  },

  async "net.list"(args, ctx) {
    const tab = await target(ctx, args, "net.list");
    const t = await start(ctx, tab);
    const limit = Math.min(Number(args?.limit) || 100, 500);
    const m = matcher(args?.filter);
    const tier = await ctx.floorTier();
    const all = [...t.recs.values()].filter(r => tier(r.url) !== "blind").filter(m);
    const rows = all.slice(-limit).map(r => redact.request(summary(r)));
    return { count: rows.length, matched: all.length, buffered: t.recs.size, requests: rows };
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
          const b = await ctx.cdp.send(tab, "Network.getResponseBody", { requestId: r.id });
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
    t.watchers.set(watchId, args?.filter || {});
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

  async "net.replay"(args, ctx) {
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
    if (ob.send && args?.asked !== true) return held(m, url, ob.why, `${m} ${url} ${typeof body === "string" ? body : ""}`);
    const res = await pageFetch(ctx, tab, { url, method: m, headers, body }, { origin: originOf(r.url) });
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
