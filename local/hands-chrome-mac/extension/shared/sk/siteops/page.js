// GENERATED from lib/siteops/page.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// page: what a browser that signs for an operation has to do on the page, written once for every rung that has a page: read the page's own storage, resolve a credential reference where the
// request is signed, and make the request with the page's own fetch. The person's Chrome (the extension) and the box's own browser (the agent's computer, over CDP) both use this, so a
// reference means the same thing on both. PURE: it builds expressions and reads plain data; running the expression is the rung's.

import { walk } from "./codec.js";
import { leafName, matches, parseCookieHeader } from "./learn.js";

/** Pages where being sent means the login is gone or a challenge is in the way. */
export const LOGIN_PATH = /\/(login|signin|sign_in|sign-in|accounts\/login|uas\/login|authwall|checkpoint|ServiceLogin)(\/|$|\?)/i;

/** The page's storage and cookies the browser can read, as one value. Runs in the page; the result stays with the rung and is never returned to a caller. */
export const STATE_EXPRESSION = `(() => { const dump = s => { const o = {}; try { for (let i = 0; i < s.length; i++) { const k = s.key(i); const v = s.getItem(k); if (v && v.length < 20000) o[k] = v; } } catch (e) {} return o; };
  const c = {}; document.cookie.split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) c[p.slice(0, i).trim()] = p.slice(i + 1).trim(); });
  return { origin: location.origin, url: location.href, cookie: c, local: dump(localStorage), session: dump(sessionStorage) }; })()`;

/** Request headers a browser sets itself: a page's fetch never takes them from a script. */
export const BROWSER_SET = new Set(["cookie", "host", "content-length", "connection", "user-agent", "origin", "referer", "accept-encoding", "priority", "upgrade-insecure-requests"]);

/**
 * A fetch made by the page, as an expression: the page's cookies sign it, and it refuses to run when the page is no longer on the site it was meant for.
 * @param {{ url: string, method: string, headers: Record<string, string>, body?: string }} req @param {string} origin @param {number} [max] longest body kept, in characters
 */
export function fetchExpression(req, origin, max = 1_000_000) {
  /** @type {Record<string, string>} */ const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) { const n = k.toLowerCase(); if (!BROWSER_SET.has(n) && !n.startsWith("sec-") && !n.startsWith(":")) headers[k] = v; }
  const payload = { url: req.url, init: { method: req.method || "GET", headers, credentials: "include", ...(req.body != null && !/^(GET|HEAD)$/i.test(req.method || "GET") ? { body: req.body } : {}) }, origin, max };
  return `(async (P) => {
    if (P.origin && location.origin !== P.origin) return { originMismatch: location.origin };
    const r = await fetch(P.url, P.init);
    const t = await r.text();
    return { status: r.status, mime: (r.headers.get("content-type") || "").split(";")[0], headers: Object.fromEntries(r.headers), body: t.slice(0, P.max) };
  })(${JSON.stringify(payload)})`;
}

/** A JSON-path read inside a stored JSON string: "a/b/0". @param {string} text @param {string} path */
function jsonLeaf(text, path) {
  try {
    let cur = JSON.parse(text);
    for (const k of path.split("/").filter(Boolean)) { if (cur == null || typeof cur !== "object") return undefined; cur = cur[k]; }
    return typeof cur === "string" ? cur : undefined;
  } catch { return undefined; }
}

/**
 * The resolver for an operation's credential references, from the page's state and the newest requests of the site. `recent` is newest first: { method, url, headers (any case), body? }.
 * A cookie the page can read, or one a recent request carried; a storage entry (by key, or key/path inside a JSON entry); the newest request's header or field of that name. Undefined when none
 * holds it: nothing is invented.
 * @param {{ cookie: Record<string, string>, local: Record<string, string>, session: Record<string, string> }} state
 * @param {{ method: string, url: string, headers?: Record<string, string>, body?: string }[]} recent @param {any} op
 * @returns {(ref: string) => string | undefined}
 */
export function resolverFor(state, recent, op) {
  return ref => {
    const i = ref.indexOf(":");
    const kind = ref.slice(0, i), name = ref.slice(i + 1);
    if (kind === "cookie") {
      if (state.cookie[name] !== undefined) return state.cookie[name];
      for (const r of recent) { const c = parseCookieHeader(String(Object.entries(r.headers || {}).find(([k]) => k.toLowerCase() === "cookie")?.[1] || "")); if (c[name] !== undefined) return c[name]; }
      return undefined;
    }
    const base = name.replace(/@.*$/, "");
    for (const store of [state.local, state.session]) {
      if (store[base] !== undefined) return store[base];
      for (const k of Object.keys(store)) if (base.startsWith(k + "/")) { const v = jsonLeaf(store[k], base.slice(k.length + 1)); if (v !== undefined) return v; }
    }
    const lc = base.toLowerCase();
    for (const r of recent) {
      const h = Object.entries(r.headers || {}).find(([k]) => k.toLowerCase() === lc);
      if (h) return String(h[1]);
    }
    // a field of a recent request of the same operation, then of any request of the site
    for (const pool of [recent.filter(r => matches(op.match, { method: r.method, url: r.url, headers: {} })), recent]) {
      for (const r of pool) {
        const leaf = walk({ method: r.method, url: r.url, headers: {}, ...(r.body !== undefined ? { body: r.body } : {}) }).find(l => !l.container && l.type === "string" && leafName(l.at) === base && l.value.length >= 8);
        if (leaf) return leaf.value;
      }
    }
    return undefined;
  };
}

/** The path a trigger ended on when it is a sign-in or checkpoint page the trigger did not mean to reach, else undefined. @param {string} finalUrl @param {string} triggerUrl */
export function loginWall(finalUrl, triggerUrl) {
  let path = "", want = "";
  try { path = new URL(finalUrl).pathname; want = new URL(triggerUrl).pathname; } catch { return undefined; }
  return LOGIN_PATH.test(path) && !LOGIN_PATH.test(want) ? path : undefined;
}
