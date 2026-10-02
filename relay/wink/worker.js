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

export default {
  /** @param {Request} req @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return dress(new Response("method not allowed", { status: 405 }));
    // The app's own sealed folders live under /release/ on app.vyre.run's twin of this page; nothing here is served from there.
    if (url.pathname.startsWith("/release/")) return dress(new Response("not found", { status: 404 }));
    return dress(await env.ASSETS.fetch(req));
  },
};
