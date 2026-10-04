// @ts-check
// worker: serves app.vyre.run from static assets (ADR 0026 section 10, ADR 0027 section 4). Every
// response gets the same strict headers. The folders under /v/<sha>/ are content-addressed and
// never change, so they cache for a year. The loader, its signed manifest and sw.js are
// revalidated on every load. Any other path (such as /pair, whose fragment the browser keeps)
// gets the loader's index.html. No state, no cookies, nothing about any box.

export const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "font-src 'self'",
  "connect-src 'self' https://relay.vyre.run wss://relay.vyre.run https://*.ts.net wss://*.ts.net https://names.vyre.run", "manifest-src 'self'", "worker-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

export const SECURITY = Object.freeze({
  "content-security-policy": CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";

/** @param {Response} r @param {string} cache */
function dress(r, cache) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  out.headers.set("cache-control", cache);
  out.headers.delete("set-cookie");
  return out;
}

export default {
  /** @param {Request} req @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return dress(new Response("method not allowed", { status: 405 }), REVALIDATE);
    // The built app's own files are answered by the service worker, from the verified build. A
    // request that reaches here (no worker yet) is a 404, never the loader page.
    if (url.pathname.startsWith("/app/")) return dress(new Response("not found", { status: 404 }), REVALIDATE);
    if (url.pathname.startsWith("/v/")) {
      if (!/^\/v\/[a-f0-9]{40}\/[\w./@-]+$/.test(url.pathname) || url.pathname.includes("..")) return dress(new Response("not found", { status: 404 }), REVALIDATE);
      return dress(await env.ASSETS.fetch(req), IMMUTABLE);
    }
    const r = await env.ASSETS.fetch(req);
    if (r.status !== 404) return dress(r, REVALIDATE);
    // Anything else is the app's own route: the loader page, which keeps the URL fragment.
    return dress(await env.ASSETS.fetch(new Request(new URL("/index.html", url), req)), REVALIDATE);
  },
};
