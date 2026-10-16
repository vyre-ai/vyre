// @ts-check
// worker: serves web.vyre.run, the Vyre app on the web, from static assets (relay/web/README.md). The assets are the release's signed
// web export, laid out by scripts/build-web-out.mjs: the app's own files under /app/ (the export is built with base URL /app), and
// /vyre-build.json, which names the release, the signed manifest's hash and the hash of every inline script and style the page carries.
// The Content-Security-Policy is built from that file, so the page's own inline splash is allowed by its hash and nothing else inline is.
// No state, no cookies, no third-party script, nothing about any server or any person.

const BASE = "default-src 'none'; img-src 'self' data: blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; media-src 'self' blob:; "
  + "connect-src 'self' https://relay.vyre.run wss://relay.vyre.run https://names.vyre.run https://*.ts.net wss://*.ts.net; "
  + "frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** @param {{ scriptHashes?: string[], styleHashes?: string[] }} b */
export function cspFor(b) {
  const h = (/** @type {string[] | undefined} */ l) => (l || []).map(x => ` '${x}'`).join("");
  // Scripts stay strict: only the app's own files and the hash of each inline script. Styles allow inline: the app's component library (react-native-web) writes its style sheet and element styles at run
  // time, which a hash list cannot name (the rehearsal showed a blank page and "Refused to apply inline style"); the box's own /app/ policy allows the same. With default-src 'none', no image, font
  // or connection can be reached from a style, so the cost is the look of the page and nothing else. A hash in style-src would switch 'unsafe-inline' off, so none is listed.
  return `${BASE}; script-src 'self'${h(b.scriptHashes)}; style-src 'self' 'unsafe-inline'`;
}

export const SECURITY = Object.freeze({
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=(), interest-cohort=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
});

const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "no-cache";
const BUILD = "/vyre-build.json";

/** The build file, read once per deploy and held per assets binding. @type {WeakMap<object, Promise<any>>} */
const held = new WeakMap();

/** @param {{ fetch: (r: Request) => Promise<Response> }} assets @param {URL} url */
function buildOf(assets, url) {
  let p = held.get(assets);
  if (!p) { p = assets.fetch(new Request(new URL(BUILD, url))).then(r => (r.ok ? r.json() : null)).catch(() => null); held.set(assets, p); }
  return p;
}

/** @param {Response} r @param {string} cache @param {string} csp */
function dress(r, cache, csp) {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  out.headers.set("content-security-policy", csp);
  out.headers.set("cache-control", cache);
  out.headers.delete("set-cookie");
  return out;
}

export default {
  /** @param {Request} req @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    const build = await buildOf(env.ASSETS, url);
    // No build file means no release was laid out here: say so, never serve a page without its policy.
    if (!build) { held.delete(env.ASSETS); return dress(new Response("web.vyre.run has no release yet", { status: 503 }), REVALIDATE, cspFor({})); }
    const csp = cspFor(build);
    if (req.method !== "GET" && req.method !== "HEAD") return dress(new Response("method not allowed", { status: 405 }), REVALIDATE, csp);
    if (url.pathname === BUILD) return dress(await env.ASSETS.fetch(req), REVALIDATE, csp);
    if (url.pathname.includes("..")) return dress(new Response("not found", { status: 404 }), REVALIDATE, csp);
    if (url.pathname.startsWith("/app/")) {
      const r = await env.ASSETS.fetch(req);
      // A file the release does not have is a 404, never the page: a script that is missing must fail loudly.
      if (r.status === 404) return dress(new Response("not found", { status: 404 }), REVALIDATE, csp);
      return dress(r, url.pathname.startsWith("/app/_expo/static/") ? IMMUTABLE : REVALIDATE, csp);
    }
    // Every other path is a route of the app (/onboard, /join, ...): the app's page, which reads the path itself. The URL fragment never leaves the browser.
    const page = await env.ASSETS.fetch(new Request(new URL("/app/index.html", url), { method: req.method, headers: req.headers }));
    return dress(page, REVALIDATE, csp);
  },
};
