// @ts-check
// api: learn an app's own API from what the page already called, then call it the same way.
//
// api.learn reduces the net buffer's XHR/fetch traffic to shapes (shared/apilearn.js: path
// templates, query and body types, credential KIND, status codes, no values) and keeps the
// catalog in chrome.storage.session by origin, bounded. Session storage is cleared when the
// browser closes and is never synced, and it holds no secret because the catalog has none.
//
// api.call runs an entry FROM INSIDE THE PAGE (net.js pageFetch): the page's cookies authenticate
// it. For bearer and custom-header apps the credential is taken from the most recent captured
// request of that origin, inside the worker, and handed to the page's own fetch; it is never
// returned or logged, and the response comes back through redact.request. A call that is not GET
// or HEAD is acting: refused while stop is in force and checked against the floor.
//
// FRAMES. The traffic of every frame of the tab is in the buffer (net.js), so api.learn learns from a cross-origin
// iframe's calls too, and each entry records `frame`, the origin of the frame it was learned in. api.call runs the
// fetch INSIDE that frame by default (or the one `frame` names: index, id or a piece of its origin), so that
// frame's own cookies and auth sign it; the origin guard then compares against that frame's origin.

import { classifySend, held } from "../shared/outbound.js";
import { learn, mergeCatalog, buildCall } from "../shared/apilearn.js";
import { records, target, refuse, pageFetch, present, start, frameList } from "./net.js";

const KEY = "api.catalog";
const MAX_ORIGINS = 20;

/** @type {Map<string, any>} */
const memory = new Map();

/** @param {any} ctx */
function store(ctx) {
  const s = ctx.storage?.session ?? /** @type {any} */ (globalThis).chrome?.storage?.session;
  return {
    /** @returns {Promise<Record<string, { updated: number, entries: any[] }>>} */
    async load() {
      if (!s) return memory.get(KEY) || {};
      const r = await s.get(KEY);
      return r?.[KEY] || {};
    },
    /** @param {Record<string, any>} v */
    async save(v) {
      const keys = Object.keys(v).sort((a, b) => v[b].updated - v[a].updated).slice(0, MAX_ORIGINS);
      const trimmed = Object.fromEntries(keys.map(k => [k, v[k]]));
      if (!s) memory.set(KEY, trimmed);
      else await s.set({ [KEY]: trimmed });
    },
  };
}

/** @param {any} ctx @param {number} tab */
const bufferOrigins = async (ctx, tab) => [...new Set((await records(ctx, tab)).map(r => { try { return new URL(r.url).origin; } catch { return ""; } }).filter(Boolean))];

/** @param {string} u @param {string} o */
const sameOrigin = (u, o) => { try { return new URL(u).origin === o; } catch { return false; } };

/** @type {Record<string, (args: any, ctx: any) => Promise<any>>} */
const ops = {
  async "api.learn"(args, ctx) {
    const tab = await target(ctx, args, "api.learn");
    await start(ctx, tab);
    const recs = await records(ctx, tab, { since: args?.since });
    // Learn per frame, so an entry says which frame's traffic it came from (a script inside the builder iframe, not the shell).
    /** @type {Map<string, any[]>} */
    const byFrame = new Map();
    for (const r of recs) { const k = r.frame || ""; (byFrame.get(k) || byFrame.set(k, []).get(k))?.push(r); }
    const fresh = [...byFrame].flatMap(([frame, rs]) => learn(rs.map(r => ({ method: r.method, url: r.url, status: r.status, type: r.type, requestHeaders: r.reqHeaders, postData: r.postData }))).map(e => (frame ? { ...e, frame } : e)));
    const st = store(ctx);
    const all = await st.load();
    /** @type {Set<string>} */
    const touched = new Set();
    for (const e of fresh) {
      touched.add(e.origin);
      const cur = all[e.origin] || { updated: 0, entries: [] };
      all[e.origin] = { updated: Date.now(), entries: mergeCatalog(cur.entries, [e]) };
    }
    await st.save(all);
    const out = [...touched].flatMap(o => all[o]?.entries || []);
    return { seen: recs.length, learned: fresh.length, origins: [...touched], entries: out };
  },

  async "api.catalog"(args, ctx) {
    const tab = args?.tab != null ? await target(ctx, args, "api.catalog") : null;
    const all = await store(ctx).load();
    let origins = Object.keys(all);
    if (args?.origin) origins = origins.filter(o => o === args.origin);
    else if (tab != null) { const seen = await bufferOrigins(ctx, tab); if (seen.length) origins = origins.filter(o => seen.includes(o)); }
    return { origins, entries: origins.flatMap(o => all[o].entries) };
  },

  async "api.call"(args, ctx) {
    const all = await store(ctx).load();
    const entry = Object.values(all).flatMap(o => o.entries).find(e => e.id === (args?.entryId ?? args?.entry));
    if (!entry) throw refuse("not_found", "no catalog entry with that id (run api.learn first)");
    const acting = !/^(GET|HEAD)$/.test(entry.method);
    const tab = await target(ctx, args, acting ? "api.call" : "api.catalog", acting);
    let built;
    try { built = buildCall(entry, args?.params || args?.args || {}); } catch (e) { throw refuse("bad_request", /** @type {Error} */ (e).message); }
    /** @type {Record<string, string>} */
    const headers = { accept: "application/json", ...(built.headers || {}) };
    let authNote;
    if (entry.authKind === "bearer" || entry.authKind.startsWith("header:")) {
      // The credential comes from the newest captured request that carried it, inside the worker.
      const want = entry.authKind === "bearer" ? "authorization" : entry.authKind.slice(7);
      const src = (await records(ctx, tab)).reverse().find(r => sameOrigin(r.url, entry.origin) && Object.keys(r.reqHeaders).some(k => k.toLowerCase() === want));
      const k = src && Object.keys(src.reqHeaders).find(x => x.toLowerCase() === want);
      if (src && k) headers[k] = src.reqHeaders[k];
      else authNote = "no captured request carries this credential any more; trigger the app once, then call again";
    }
    // Hands-free after the grant, except a request that SENDS something as the person (a message,
    // a post, a payment) when nobody asked: that waits at the Gate. Judged by method and endpoint.
    const ob = classifySend(built.method, built.url, typeof built.body === "string" ? built.body : "");
    if (ob.send && args?.asked !== true) return held(built.method, built.url, ob.why, `${built.method} ${built.url} ${typeof built.body === "string" ? built.body : ""}`);
    // Which frame runs it: the one asked for, else the one the entry was learned in, else the top page.
    const frames = await frameList(ctx, tab);
    /** @type {any} */ let frame = null;
    let guard = entry.origin;
    if (args?.frame != null && args.frame !== "") {
      if (!frames.length || !ctx.frames?.pickFrom) throw refuse("bad_request", "this tab's frames cannot be listed, so a frame cannot be chosen");
      frame = ctx.frames.pickFrom(frames, args.frame);
      if (!frame) throw refuse("not_found", `no frame matches ${JSON.stringify(args.frame)}; the frames are ${frames.map(f => `${f.index} ${f.origin || "top"}`).join(", ")}`);
      if (frame.origin) guard = frame.origin;
    } else if (entry.frame && frames.length) {
      frame = frames.find(f => f.readable && f.origin === entry.frame) || null;
      if (!frame && frames.some(f => f.origin === entry.frame)) throw refuse("not_found", `the frame this call was learned in (${entry.frame}) cannot be read right now`);
      if (frame) guard = entry.frame;
    }
    const res = await pageFetch(ctx, tab, { url: built.url, method: built.method, headers, body: built.body }, { origin: guard, frame });
    return { entryId: entry.id, ...(frame && frame.index > 0 ? { frame: frame.index, frameOrigin: frame.origin } : {}), ...(authNote ? { authNote } : {}), ...present({ method: built.method, url: built.url, status: res.status, mime: res.mime, responseHeaders: res.headers, responseBody: res.body }) };
  },
};

export default { name: "api", ops };
