// @ts-check
// worker: serves wink.vyre.run from static assets, the twin of relay/app/worker.js. The page is one screen with a Pair button, so
// there is nothing to route: the sealed build (relay/wink/release.js) is answered as it is, every response carries the same strict
// headers from relay/wink/headers.js, and everything is revalidated on every load (the files are not content-addressed; the
// signed manifest and the service worker decide what the browser trusts). An unknown path is a 404, never the page. No state, no
// cookies, nothing about any box.

import { HEADERS } from "./headers.js";

const REVALIDATE = "no-cache";

/** @param {Response} r @param {string} [cache] */
function dress(r, cache = REVALIDATE) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(HEADERS)) out.headers.set(k, v);
  out.headers.set("cache-control", cache);
  out.headers.delete("set-cookie");
  return out;
}

const NOT_FOUND = () => dress(new Response("not found", { status: 404 }));
/** A redirect is never an answer here: the assets binding would only send one for a path it rewrote. Any 3xx is refused except 304, a cache hit. */
const redirect = (/** @type {number} */ s) => s >= 300 && s < 400 && s !== 304;

/**
 * The path exactly as it was sent: after the host, before the query. Refused when it is anything but a plain path of plain
 * segments: an empty segment ("//"), a backslash, an encoded slash, backslash or dot, or a dot segment.
 * @param {string} rawUrl
 */
export function plainPath(rawUrl) {
  const p = rawUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0] || "/";
  if (!p.startsWith("/") || p.includes("//") || p.includes("\\") || /%(2f|5c|2e|00)/i.test(p)) return null;
  if (p.split("/").some(s => s === "." || s === "..")) return null;
  return p;
}

export default {
  /** @param {Request} req @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(req, env) {
    if (req.method !== "GET" && req.method !== "HEAD") return dress(new Response("method not allowed", { status: 405 }));
    const p = plainPath(req.url);
    if (p === null) return NOT_FOUND();
    // The app's own sealed folders live under /release/ on app.vyre.run's twin of this page; nothing here is served from there.
    if (p.startsWith("/release/")) return NOT_FOUND();
    // The assets binding does no HTML handling (wrangler.toml html_handling = "none"), so the page's one route is mapped here.
    const asset = p === "/" ? new Request(new URL("/index.html", req.url), req) : req;
    const r = await env.ASSETS.fetch(asset);
    return redirect(r.status) ? NOT_FOUND() : dress(r);
  },
};
