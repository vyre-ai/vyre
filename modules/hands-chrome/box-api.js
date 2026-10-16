// @ts-check
// chrome.api on the box: learn / catalog / route / call over CDP (lib/siteops/apilearn.js + page.js).

import { learn, mergeCatalog, buildCall } from "../../lib/siteops/apilearn.js";
import { fetchExpression, STATE_EXPRESSION } from "../../lib/siteops/page.js";
import * as redact from "../../lib/siteops/redact.js";
import { captureNetwork } from "./cdp-capture.js";

const DEAD_AFTER = 2;
const STOP = new Set(["the", "and", "for", "with", "from", "all", "get", "list", "show", "read", "fetch", "find", "give", "that", "this"]);
const words = (/** @type {string} */ s) => String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.replace(/(ies)$/, "y").replace(/s$/, ""));
const scoreEntry = (/** @type {string[]} */ hint, /** @type {any} */ e) => {
  const have = new Set([...words(e.pathTemplate.replace(/\{[^}]*\}/g, " ")), ...Object.keys(e.query || {}).flatMap(words)]);
  return hint.filter(w => have.has(w)).length;
};

/** @param {import("./cdp-capture.js").CdpLike} cdp @param {string} sessionId */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r && r.exceptionDetails) throw Object.assign(new Error(String(r.exceptionDetails.text || "page script failed")), { code: "page" });
  return r && r.result ? r.result.value : undefined;
}

/** @param {any} req */
function maskRequest(req) {
  return redact.request ? redact.request(req) : req;
}

/**
 * @param {{ cdp: any, sessionId: string, catalogs: Map<string, any[]>, dead: Map<string, number> }} ctx
 */
export function createBoxApi(ctx) {
  const pageFetch = async (/** @type {any} */ built, /** @type {string} */ origin) => {
    const v = await evaluate(ctx.cdp, ctx.sessionId, fetchExpression(built, origin));
    if (!v) throw new Error("the page returned nothing");
    if (v.originMismatch) throw new Error(`the browser is now on ${v.originMismatch}, not ${origin}`);
    return { status: v.status, headers: v.headers || {}, body: v.body ?? "" };
  };

  return {
    async learn() {
      const cap = captureNetwork(ctx.cdp, ctx.sessionId, { full: true });
      await cap.start();
      await cap.settle();
      const recs = await cap.recordsForLearn();
      cap.stop();
      const fresh = learn(recs.map(r => ({ method: r.method, url: r.url, status: r.status, type: r.type, requestHeaders: r.requestHeaders, postData: r.postData })));
      for (const e of fresh) {
        const list = ctx.catalogs.get(e.origin) || [];
        ctx.catalogs.set(e.origin, mergeCatalog(list, [e]));
      }
      return { learned: fresh.length, entries: fresh.map(maskRequest) };
    },
    async catalog({ origin } = {}) {
      const entries = origin ? (ctx.catalogs.get(String(origin)) || []) : [...ctx.catalogs.values()].flat();
      return { entries: entries.map(maskRequest) };
    },
    async route({ hint, params, host }) {
      const hintWords = words(String(hint || ""));
      const origins = host ? [String(host)] : [...ctx.catalogs.keys()];
      let best = null, bestScore = 0;
      for (const o of origins) {
        for (const e of ctx.catalogs.get(o) || []) {
          if (e.method !== "GET") continue;
          const s = scoreEntry(hintWords, e);
          if (s > bestScore) { bestScore = s; best = e; }
        }
      }
      if (!best || bestScore === 0) return { route: "ui", why: "no learned GET matches that hint" };
      const built = buildCall(best, { path: params?.path, query: params?.query });
      try {
        const res = await pageFetch(built, best.origin);
        if (res.status >= 200 && res.status < 300) return { route: "api", entry: best.id, data: maskRequest({ status: res.status, body: String(res.body).slice(0, 50_000) }) };
        const fails = (ctx.dead.get(best.id) || 0) + 1;
        ctx.dead.set(best.id, fails);
        if (fails >= DEAD_AFTER) {
          const list = (ctx.catalogs.get(best.origin) || []).filter(x => x.id !== best.id);
          ctx.catalogs.set(best.origin, list);
        }
        return { route: "ui", why: `learned GET returned ${res.status}` };
      } catch (e) {
        return { route: "ui", why: /** @type {Error} */ (e).message };
      }
    },
    async call({ entry, args, approved }) {
      const all = [...ctx.catalogs.values()].flat();
      const e = all.find(x => x.id === entry);
      if (!e) throw Object.assign(new Error(`no catalog entry ${entry}`), { code: "not_found" });
      const write = !/^(GET|HEAD)$/i.test(e.method);
      if (write && !approved) return { held: true, why: "a write needs the person's approval (approved: true after they said yes)" };
      const built = buildCall(e, { path: args?.path, query: args?.query, body: args?.body });
      const res = await pageFetch(built, e.origin);
      return { ok: res.status >= 200 && res.status < 300, status: res.status, data: maskRequest({ body: String(res.body).slice(0, 50_000) }) };
    },
  };
}

export { STATE_EXPRESSION };
