// @ts-check
// api-exec: chrome.api route and call on the box — in-page fetch over CDP (same catalog as apilearn.js).

import { buildCall } from "../../lib/siteops/apilearn.js";
import * as redact from "../../lib/siteops/redact.js";

const STOP = new Set(["the", "and", "for", "with", "from", "all", "get", "list", "show", "read", "fetch", "find", "give", "that", "this", "get"]);
/** @param {string} s @returns {string[]} */
const words = s => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.replace(/(ies)$/, "y").replace(/s$/, ""));
/** @param {string[]} hint @param {any} e */
const scoreEntry = (hint, e) => {
  const have = new Set([...words(e.pathTemplate.replace(/\{[^}]*\}/g, " ")), ...Object.keys(e.query || {}).flatMap(words)]);
  return hint.filter(w => have.has(w)).length;
};
const DEAD_AFTER = 2;
const MAX_BODY = 120_000;

/** @param {any} h @param {string} name */
function hget(h, name) {
  if (!h) return undefined;
  if (Array.isArray(h)) return h.find(x => String(x.name).toLowerCase() === name)?.value;
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? h[k] : undefined;
}

/** @param {string} u @param {string} o */
function sameOrigin(u, o) {
  try { return new URL(u).origin === o; } catch { return false; }
}

/**
 * @param {{ send: (method: string, params?: any, sessionId?: string) => Promise<any> }} cdp
 * @param {string} sessionId
 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: string }} req
 */
export async function pageFetch(cdp, sessionId, req) {
  const payload = JSON.stringify({
    url: req.url,
    method: req.method,
    headers: req.headers || {},
    body: req.body ?? null,
  });
  const expr = `(async () => {
    const p = ${payload};
    const r = await fetch(p.url, {
      method: p.method,
      headers: p.headers,
      credentials: "include",
      body: p.body,
    });
    const t = await r.text();
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, mime: ct, headers: Object.fromEntries(r.headers.entries()), body: t };
  })()`;
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error(`in-page fetch failed: ${r.exceptionDetails.text || "unknown"}`);
  const v = r.result && r.result.value;
  if (!v || typeof v !== "object") throw new Error("in-page fetch returned nothing");
  return /** @type {{ status: number, mime: string, headers: Record<string, string>, body: string }} */ (v);
}

/** @param {any} view */
export function present(view) {
  const clean = { ...view };
  if (clean.responseBody !== undefined) {
    const s = String(clean.responseBody);
    clean.responseBody = s.length > MAX_BODY ? s.slice(0, MAX_BODY) + "\u2026" : s;
  }
  const out = redact.request({
    method: clean.method,
    url: clean.url,
    status: clean.status,
    mime: clean.mime,
    responseHeaders: clean.responseHeaders,
    responseBody: clean.responseBody,
  });
  if (out.responseBody && String(out.responseBody).length > MAX_BODY) {
    return { ...out, responseBodyTruncated: true };
  }
  return out;
}

/**
 * @param {any[]} catalog flat entries for one agent
 * @param {string} hint
 * @param {Record<string, any>} [params]
 * @param {any[]} traffic captured request records (for auth headers)
 * @param {(entry: any, params: any, trust: { approved?: boolean }) => Promise<any>} callEntry
 */
export async function routeApi(catalog, hint, params, traffic, callEntry) {
  const hintWords = words(hint);
  if (!hintWords.length) throw new Error("route needs a hint: what the page's data is about, in a few words");
  const scored = (catalog || []).map(e => ({ e, score: scoreEntry(hintWords, e) }))
    .filter(x => x.score > 0 && (x.e.fails || 0) < DEAD_AFTER);
  const reads = scored.filter(x => /^(GET|HEAD)$/.test(x.e.method)).sort((a, b) => b.score - a.score || b.e.count - a.e.count);
  const writes = scored.filter(x => !/^(GET|HEAD)$/.test(x.e.method)).slice(0, 5)
    .map(x => ({ entryId: x.e.id, method: x.e.method, pathTemplate: x.e.pathTemplate }));
  /** @param {string} why @param {any} [more] */
  const ui = (why, more) => ({ route: "ui", why, ...(writes.length ? { writes } : {}), ...(more || {}) });
  if (!reads.length) return ui(catalog.length ? "no learned read matches the hint" : "nothing is learned yet (run chrome.api learn after using the page)");
  const [best, next] = reads;
  if (next && next.score === best.score && next.e.pathTemplate !== best.e.pathTemplate) {
    return ui("more than one learned read matches equally; pick one with chrome.api call", {
      candidates: reads.slice(0, 5).map(x => ({ entryId: x.e.id, pathTemplate: x.e.pathTemplate })),
    });
  }
  const e = best.e;
  try { buildCall(e, params || {}); } catch (x) { return ui(/** @type {Error} */ (x).message, { entryId: e.id, pathTemplate: e.pathTemplate }); }
  let res;
  try { res = await callEntry(e, params || {}, {}); }
  catch (x) { return ui(`the call was refused: ${String(/** @type {any} */ (x)?.message || x)}`, { entryId: e.id }); }
  if (res && res.held) return { route: "held", entryId: e.id, ...res };
  const status = Number(res?.status);
  if (status >= 200 && status < 300) {
    if (e.fails) e.fails = 0;
    e.verified = Date.now();
    return { route: "api", entryId: e.id, pathTemplate: e.pathTemplate, ...res };
  }
  e.fails = (e.fails || 0) + 1;
  return ui(`the stored endpoint answered ${status || "nothing"}, so it is not trusted`, { entryId: e.id, status });
}

/**
 * @param {any} entry catalog entry
 * @param {Record<string, any>} params
 * @param {any[]} traffic
 * @param {{ approved?: boolean }} trust
 * @param {{ send: (method: string, params?: any, sessionId?: string) => Promise<any> }} cdp
 * @param {string} sessionId
 */
export async function callApi(entry, params, traffic, trust, cdp, sessionId) {
  const acting = !/^(GET|HEAD)$/.test(entry.method);
  if (acting && trust.approved !== true) {
    return {
      held: true,
      write: true,
      method: entry.method,
      why: "a write waits for the person's approval; pass approved: true after they said yes",
      pathTemplate: entry.pathTemplate,
    };
  }
  const built = buildCall(entry, params);
  /** @type {Record<string, string>} */
  const headers = { accept: "application/json", ...(built.headers || {}) };
  let authNote;
  if (entry.authKind === "bearer" || String(entry.authKind).startsWith("header:")) {
    const want = entry.authKind === "bearer" ? "authorization" : String(entry.authKind).slice(7);
    const src = [...(traffic || [])].reverse().find(r => sameOrigin(r.url, entry.origin) && Object.keys(r.requestHeaders || {}).some(k => k.toLowerCase() === want));
    const k = src && Object.keys(src.requestHeaders || {}).find(x => x.toLowerCase() === want);
    if (src && k) headers[k] = src.requestHeaders[k];
    else authNote = "no captured request carries this credential; use the app once, then call again";
  }
  const res = await pageFetch(cdp, sessionId, { method: built.method, url: built.url, headers, body: built.body });
  const view = present({
    method: built.method,
    url: built.url,
    status: res.status,
    mime: res.mime,
    responseHeaders: res.headers,
    responseBody: res.body,
  });
  return { entryId: entry.id, ...(authNote ? { authNote } : {}), ...view };
}

/** Drop entries that failed too often. @param {any[]} catalog */
export function pruneDead(catalog) {
  return (catalog || []).filter(e => (e.fails || 0) < DEAD_AFTER);
}
