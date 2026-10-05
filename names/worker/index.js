// @ts-check
// The Vyre name directory on Cloudflare (docs/work/tailnet.md, plan sections 3.1 and 3.6c): a Worker
// at names.vyre.run that holds the only vyre.run DNS credential. A box never sees it. One Durable
// Object holds every name, so a claim, a limit and a recovery can never race.
//
//   POST   /v1/names/claim           {name}                bind a name to the caller's route for good
//   POST   /v1/names/point           {name, ip}            A record, tailnet IPv4 (100.64.0.0/10) only
//   POST   /v1/names/publish         {name}                A record, the public IPv4 this request came from (a box that serves its own network gate)
//   POST   /v1/names/acme            {name, token}         _acme-challenge.<name> TXT, or {own:true, token}
//   DELETE /v1/names/acme            {name} or {own:true}  clear it
//   POST   /v1/names/recover         {name, code, next}    a 72-hour pending rebind to the caller's route
//   POST   /v1/names/recover/cancel  {name}                the current owner's route cancels it
//   POST   /v1/names/code            {name, next}          the owner replaces the recovery code (and cancels a pending one)
//   POST   /v1/names/release         {name}                give the name up (a tombstone if it was ever pointed)
//   GET    /v1/names/mine                                  this route's name, its state, notices
//   GET    /v1/names/check?name=                           ok, taken, reserved, invalid, mine
//   POST   /v1/names/admin/rebind    {name, route}        support only: move a name to a route at once; needs the ADMIN_SECRET header
//   GET    /health
//
// Identity: the box's relay route key (ADR 0026), Ed25519. Every call but check carries
// x-vyre-route, x-vyre-pub, x-vyre-ts, x-vyre-nonce and x-vyre-sig, a signature over
// AUTH_TAG, the route, the time, the nonce, the method, the path and query, and the body's
// sha256. The route id must be the hash of the key (core/relay/wire.js routeId), the clock within
// 60 seconds, and the nonce unused. No dependencies: WebCrypto only.
//
// Nothing here serves user content, sets a cookie or reads one. CORS is narrow: `GET /v1/ids/resolve` and the name availability check `GET /v1/names/check` are public read-only data and answer any origin (no credentials). `POST /v1/ids/claim`,
// `/v1/ids/append` and `/v1/ids/update` carry their own proof (the identity's own signature is the authentication), so they also accept the Vyre app's origins (env.APP_ORIGINS, default
// https://app.vyre.run) and answer that exact origin. Every other state-changing request that carries a foreign Origin (a browser's) is refused; a box sends none.

/** Repeats what core/names/rules.js and core/names/directory.js use; names/worker/worker.test.js checks they match. */
export const AUTH_TAG = "vyre-names-v1";
export const CODE_TAG = "vyre-names-code";
export const ZONE_TAG = "vyre-acme-zone";
export const ROUTE_RE = /^[a-z2-7]{26}$/;
const DAY = 86_400_000;
const HOUR = 3_600_000;
export const LIMITS = Object.freeze({
  /** names one route may hold */
  perRoute: 1,
  /** claims from one address a day */
  claimsPerIp: 5,
  /** claims in a day, everyone (env.GLOBAL_CLAIMS_PER_DAY overrides) */
  claimsGlobal: 500,
  /** ACME challenge writes per route a day */
  acmePerRoute: 10,
  /** point calls per route a day */
  pointPerRoute: 30,
  /** recover attempts per name a day, right or wrong */
  recoverPerName: 5,
  /** recover attempts per address a day */
  recoverPerIp: 20,
  /** a claimed name that is never pointed lapses */
  lapseMs: 7 * DAY,
  /** how long a recovery waits, so a live owner can cancel it */
  recoverMs: 72 * HOUR,
  /** TXT records held at one challenge label */
  txtPerLabel: 4,
  skewMs: 60_000,
  body: 4096,
});

// ---- names ----

const NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/** Words no one gets: the old list, then ours, surfaces and teams, then account-shaped words. */
export const RESERVED = new Set([
  "www", "api", "app", "admin", "mail", "docs", "status", "blog", "help", "support", "deck", "vyre",
  "root", "ns1", "ns2", "dev", "staging", "test", "download", "install", "login", "auth", "directory",
  "relay", "setup", "phone", "acme", "names", "team", "account", "secure", "billing", "signin", "signup",
  "password", "verify", "update", "security", "webmaster", "postmaster", "hostmaster", "abuse", "noreply", "ftp", "smtp", "imap", "pop",
  "capsule", "glass", "chat", "desktop", "mobile", "web", "surface", "artifacts", "sessions", "computers", "agent", "agents", "box", "server",
  "tailnet", "vault", "platform", "launch", "assistant", "integrator", "reviewer", "sight", "iq", "main", "lead", "nexus",
  "tailscale", "cloudflare", "letsencrypt", "zerossl", "railway",
]);
/** Brands. A hyphen-separated part that is one of these refuses the whole name. */
export const BRANDS = new Set([
  "google", "gmail", "youtube", "apple", "icloud", "microsoft", "outlook", "office", "azure", "amazon", "aws", "meta", "facebook", "instagram", "whatsapp",
  "paypal", "stripe", "venmo", "github", "gitlab", "openai", "anthropic", "claude", "chatgpt", "netflix", "twitter", "linkedin", "telegram", "signal",
  "dropbox", "slack", "zoom", "adobe", "ebay", "coinbase", "binance", "chase", "wellsfargo", "bankofamerica", "citibank", "visa", "mastercard", "amex",
  "samsung", "tesla", "spotify", "steam", "discord", "reddit", "tiktok", "yahoo", "uber", "airbnb", "shopify", "docusign", "walmart", "usps", "fedex", "irs",
]);

/** ASCII lookalikes, folded before the reserved check: rn to m, 0 to o, 1 to l, and i to l so "login" and "log1n" meet. @param {string} n */
export const fold = n => n.replace(/rn/g, "m").replace(/0/g, "o").replace(/[1i]/g, "l");
const FOLDED = new Set([...RESERVED, ...BRANDS].map(fold));
const BRAND_FOLDED = new Set([...BRANDS, "vyre"].map(fold));

/**
 * @param {unknown} raw
 * @returns {{ name: string, status: "ok"|"invalid"|"reserved", why: string|null }}
 */
export function verdict(raw) {
  const name = String(raw ?? "").trim().toLowerCase();
  const bad = why => ({ name, status: /** @type {const} */ ("invalid"), why });
  if (name.length < 3) return bad("at least 3 characters");
  if (name.length > 32) return bad("at most 32 characters");
  if (name.startsWith("xn--") || name.includes("xn--")) return bad("no punycode names");
  if (name.startsWith("-") || name.endsWith("-")) return bad("no dash at the start or end");
  if (name.includes("--")) return bad("no double dashes");
  if (!NAME_RE.test(name)) return bad("letters, digits or dashes, starting with a letter");
  const forms = new Set([name, fold(name)]);
  for (const f of [...forms]) forms.add(f.replace(/-/g, ""));
  const taken = { name, status: /** @type {const} */ ("reserved"), why: "that name is reserved" };
  for (const f of forms) {
    if (FOLDED.has(fold(f))) return taken;
    for (const part of f.split("-")) if (BRAND_FOLDED.has(fold(part))) return taken;
  }
  return { name, status: "ok", why: null };
}


/**
 * A public IPv4 a box may publish for itself: the address the request came from, never private, loopback, link-local, CGNAT (100.64.0.0/10 is the tailnet's), documentation, multicast or reserved.
 * @param {unknown} raw @returns {string|null}
 */
export function publicIpv4(raw) {
  const s = String(raw ?? "");
  const p = s.split(".");
  if (p.length !== 4 || !p.every(x => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)) return null;
  const [a, b, c] = p.map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
  if (a === 100 && b >= 64 && b <= 127) return null;
  if (a === 169 && b === 254) return null;
  if (a === 172 && b >= 16 && b <= 31) return null;
  if (a === 192 && b === 168) return null;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return null;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return null;
  if (a === 203 && b === 0 && c === 113) return null;
  return s;
}

/**
 * Only the tailnet's own address space: 100.64.0.0/10 as A and fd7a:115c:a1e0::/48 as AAAA.
 * Anything else, private ranges, IPv4-mapped forms, zone ids and odd spellings included, is null.
 * @param {unknown} raw @returns {{ type: "A"|"AAAA", ip: string }|null}
 */
export function tailnetIp(raw) {
  const s = String(raw ?? "");
  if (/^[0-9.]+$/.test(s)) {
    const p = s.split(".");
    if (p.length !== 4 || !p.every(x => /^(0|[1-9]\d{0,2})$/.test(x) && Number(x) <= 255)) return null;
    const [a, b] = p.map(Number);
    return a === 100 && b >= 64 && b <= 127 ? { type: "A", ip: s } : null;
  }
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.length > 39) return null;
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const side = h => h === "" ? [] : h.split(":");
  const head = side(halves[0]), tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every(g => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const n = groups.map(g => parseInt(g, 16));
  if (n[0] !== 0xfd7a || n[1] !== 0x115c || n[2] !== 0xa1e0) return null;
  // Canonical text: lowercase, the longest run of zero groups as "::".
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (n[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && n[j] === 0) j++;
    if (j - i > best[1]) best = [i, j - i];
    i = j;
  }
  const hex = n.map(x => x.toString(16));
  const ip = best[1] >= 2 ? `${hex.slice(0, best[0]).join(":")}::${hex.slice(best[0] + best[1]).join(":")}` : hex.join(":");
  return { type: "AAAA", ip };
}

// ---- bytes ----

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648 base32, lowercase, no padding. @param {Uint8Array} buf */
export function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
/** @param {Uint8Array} bytes */
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** @param {string} s @returns {Uint8Array|null} */
function unb64url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)); } catch { return null; }
}
const enc = new TextEncoder();
const hex = /** @param {ArrayBuffer} b */ b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const sha256 = /** @param {string} s */ async s => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
/** The route id: the first 26 base32 characters of sha256 of the route key. @param {Uint8Array} pub */
export async function routeId(pub) { return base32(new Uint8Array(await crypto.subtle.digest("SHA-256", pub))).slice(0, 26); }
/** The label under acme.<zone> a route's own-domain challenges go to. @param {string} route */
export async function routeHash(route) { return base32(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${ZONE_TAG}\n${route}`)))).slice(0, 26); }
/** @param {string} name @param {string} code the recovery code, dashes and case ignored */
export const codeHash = (name, code) => sha256(`${CODE_TAG}\n${name}\n${String(code).toLowerCase().replace(/[^a-z2-7]/g, "")}`);
/** Equal strings, in time that depends only on length. */
function same(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  if (x.length !== y.length || x.length === 0) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/** The bytes a box signs. @param {{ route: string, ts: string|number, nonce: string, method: string, target: string, bodyHash: string }} m */
export const authMessage = m => enc.encode(`${AUTH_TAG}\n${m.route}\n${m.ts}\n${m.nonce}\n${m.method}\n${m.target}\n${m.bodyHash}`);

/** @param {Uint8Array} pub @param {Uint8Array} message @param {Uint8Array} sig */
async function verifyRoute(pub, message, sig) {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try { return await crypto.subtle.verify({ name: "Ed25519" }, await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]), sig, message); } catch { return false; }
}

const err = (status, code, message) => ({ status, code, message });
const headers = () => ({ "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: headers() });
const fail = e => reply(e.status, { error: { code: e.code, message: e.message } });

/** The routes a browser page of the Vyre app may call: signed by the identity's own key, so the Origin check adds nothing. */
const APP_OPS = new Set(["idClaim", "idAppend", "idUpdate"]);
const appOrigins = env => new Set(String((env && env.APP_ORIGINS) || "https://app.vyre.run").split(",").map(x => x.trim()).filter(Boolean));
/** The CORS headers for this request on this route, or null. resolve: any origin, never credentials. App routes: the exact allowed origin only. */
function corsHeaders(request, env, op) {
  const origin = request.headers.get("origin");
  if (op === "idResolve" || op === "check") return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
  if (APP_OPS.has(op) && origin !== null && appOrigins(env).has(origin)) return { "access-control-allow-origin": origin, "vary": "origin", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
  return null;
}

// ---- the Worker ----

import { idOps, ID_ROUTES, SELF_PROVEN } from "./ids.js";

const ROUTES = {
  "POST /v1/names/claim": "claim", "POST /v1/names/point": "point", "POST /v1/names/publish": "publish", "POST /v1/names/acme": "acme", "DELETE /v1/names/acme": "acmeClear",
  "POST /v1/names/recover": "recover", "POST /v1/names/recover/cancel": "cancel", "POST /v1/names/code": "code", "POST /v1/names/release": "release",
  "GET /v1/names/mine": "mine", "GET /v1/names/check": "check",
  "POST /v1/names/admin/rebind": "adminRebind",
  ...ID_ROUTES,
};

export default {
  /** @param {Request} request @param {any} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    // A preflight is answered for the CORS routes only; the route a preflight asks about is the one in the Access-Control-Request-Method header.
    if (request.method === "OPTIONS") {
      const asked = request.headers.get("access-control-request-method") || "";
      const op = /** @type {Record<string, string>} */ (ROUTES)[`${asked} ${url.pathname}`];
      const cors = op ? corsHeaders(request, env, op) : null;
      return cors ? new Response(null, { status: 204, headers: cors }) : new Response(null, { status: 405 });
    }
    const op0 = /** @type {Record<string, string>} */ (ROUTES)[`${request.method} ${url.pathname}`];
    const res = await route(request, env, url);
    const cors = op0 ? corsHeaders(request, env, op0) : null;
    if (!cors) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(cors)) if (k === "vary" || k === "access-control-allow-origin" || k === "access-control-allow-methods" || k === "access-control-allow-headers" || k === "access-control-max-age") out.headers.set(k, v);
    return out;
  },
  /** The hourly sweep: finish recoveries that came due, lapse unpointed names, drop old counters. @param {any} _event @param {any} env */
  async scheduled(_event, env) {
    await env.DIRECTORY.get(env.DIRECTORY.idFromName("v1")).fetch("https://directory/op", { method: "POST", body: JSON.stringify({ op: "sweep" }) });
  },
};

/** @param {Request} request @param {any} env @param {URL} url */
async function route(request, env, url) {
  {
    if (url.pathname === "/health") return new Response('{"ok":true}', { headers: headers() });
    const op = /** @type {Record<string, string>} */ (ROUTES)[`${request.method} ${url.pathname}`];
    if (!op) return new Response(null, { status: url.pathname.startsWith("/v1/names/") ? 405 : 404 });
    const changes = request.method !== "GET";
    if (changes) {
      // A browser adds Origin to a cross-site POST or DELETE. This service has no page and no
      // browser caller, so any Origin that is not exactly its own is refused, and so is a
      // request the browser marks cross-site.
      const origin = request.headers.get("origin");
      // The Vyre app's origins may call the routes that carry their own proof (APP_OPS): the identity's signature authenticates, and the Origin must match one exactly.
      const fromApp = APP_OPS.has(op) && origin !== null && appOrigins(env).has(origin);
      if (!fromApp) {
        if (origin !== null && origin !== (env.ORIGIN || "https://names.vyre.run")) return fail(err(403, "origin", "not for browsers"));
        if (request.headers.get("sec-fetch-site") === "cross-site") return fail(err(403, "origin", "not for browsers"));
      }
      if (!/^application\/json\b/i.test(request.headers.get("content-type") || "")) return fail(err(415, "content_type", "send application/json"));
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (env.NAMES_LIMITER) {
      const { success } = await env.NAMES_LIMITER.limit({ key: ip });
      if (!success) return fail(err(429, "rate_limited", "slow down"));
    }
    const text = changes ? await request.text() : "";
    if (text.length > LIMITS.body) return fail(err(413, "too_big", "request too large"));
    let body = {};
    if (text) {
      try { body = JSON.parse(text); } catch { return fail(err(400, "bad_request", "not JSON")); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return fail(err(400, "bad_request", "expected an object"));
    }
    const query = Object.fromEntries(url.searchParams);
    let auth = null;
    if (op === "adminRebind") {
      // Support only. Not signed with a route key: the Worker secret is the authority. With no secret set the
      // operation does not exist; a missing and a wrong header answer the same.
      const given = request.headers.get("x-vyre-admin") || "";
      if (!env.ADMIN_SECRET || String(env.ADMIN_SECRET).length < 32) return fail(err(404, "not_found", "not available"));
      if (!given || !same(await sha256(given), await sha256(String(env.ADMIN_SECRET)))) return fail(err(401, "unauthorized", "not authorised"));
      auth = { admin: true };
    } else if (!SELF_PROVEN.has(op) && (op !== "check" || request.headers.has("x-vyre-sig"))) {
      auth = await authenticate(request, url, text, Number(env.NOW ? env.NOW() : Date.now()));
      if (!auth) return fail(err(401, "unauthorized", "sign the request with the route key"));
    }
    const res = await env.DIRECTORY.get(env.DIRECTORY.idFromName("v1")).fetch("https://directory/op", {
      method: "POST", body: JSON.stringify({ op, ip, auth, body, query }) });
    return new Response(res.body, { status: res.status, headers: headers() });
  }
}

/** @param {Request} request @param {URL} url @param {string} text @param {number} now @returns {Promise<{route: string, nonce: string, ts: number}|null>} */
async function authenticate(request, url, text, now) {
  const h = n => request.headers.get(n) || "";
  const route = h("x-vyre-route"), ts = h("x-vyre-ts"), nonce = h("x-vyre-nonce");
  const pub = unb64url(h("x-vyre-pub")), sig = unb64url(h("x-vyre-sig"));
  if (!ROUTE_RE.test(route) || !/^\d{10,16}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !pub || !sig) return null;
  if (Math.abs(now - Number(ts)) > LIMITS.skewMs) return null;
  if (pub.length !== 32 || await routeId(pub) !== route) return null;
  const message = authMessage({ route, ts, nonce, method: request.method, target: url.pathname + url.search, bodyHash: await sha256(text) });
  return await verifyRoute(pub, message, sig) ? { route, nonce, ts: Number(ts) } : null;
}

// ---- Cloudflare DNS, fenced to the zone and to three record types ----

/** @param {any} env */
export function dnsFor(env) {
  const zone = env.ZONE || "vyre.run";
  const api = env.CF_API || "https://api.cloudflare.com/client/v4";
  const doFetch = env.CF_FETCH || globalThis.fetch.bind(globalThis);
  const guard = (fqdn, type) => {
    if (!fqdn.endsWith("." + zone) || !/^[a-z0-9_.-]+$/.test(fqdn) || !["A", "AAAA", "TXT", "CAA"].includes(type)) throw new Error("refused: outside the zone");
    return fqdn;
  };
  async function call(method, path, body) {
    let res;
    try {
      res = await doFetch(api + path, { method, headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new Error(`dns ${method} failed: network`); }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !data || data.success === false) throw new Error(`dns ${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    return data.result;
  }
  const base = `/zones/${env.CF_ZONE_ID}/dns_records`;
  async function list(fqdn, type) {
    guard(fqdn, type);
    const found = await call("GET", `${base}?${new URLSearchParams({ name: fqdn, type, per_page: "100" })}`);
    return (found || []).filter(r => r.name === fqdn && r.type === type);
  }
  return {
    zone,
    list,
    /** One A or AAAA record for fqdn, DNS only, the given content. */
    async point(fqdn, type, content) {
      const [first, ...extra] = await list(fqdn, type);
      const rec = { type, name: fqdn, content, proxied: false, ttl: 60 };
      if (first) { if (first.content !== content) await call("PUT", `${base}/${first.id}`, rec); } else await call("POST", base, rec);
      for (const r of extra) await call("DELETE", `${base}/${r.id}`);
    },
    /** Add a TXT value unless it is there; keep at most `cap` records at the label. */
    async addTxt(fqdn, value, cap) {
      const quoted = `"${value}"`;
      const have = await list(fqdn, "TXT");
      if (have.some(r => r.content === quoted)) return;
      for (const r of have.slice(0, Math.max(0, have.length - cap + 1))) await call("DELETE", `${base}/${r.id}`);
      await call("POST", base, { type: "TXT", name: fqdn, content: quoted, ttl: 60 });
    },
    /** The CAA records at fqdn: issue and issuewild both name one ACME account, nothing else may issue. */
    async setCaa(fqdn, value) {
      for (const r of await list(fqdn, "CAA")) await call("DELETE", `${base}/${r.id}`);
      for (const tag of ["issue", "issuewild"]) { guard(fqdn, "CAA"); await call("POST", base, { type: "CAA", name: fqdn, data: { flags: 0, tag, value }, content: `0 ${tag} "${value}"`, ttl: 60 }); }
    },
    async clear(fqdn, type) { for (const r of await list(fqdn, type)) await call("DELETE", `${base}/${r.id}`); },
  };
}

// ---- the Durable Object ----

const NOTICES = 20;

/**
 * Every name, in one object. Keys:
 *   n/<name>          { name, route|null, state: claimed|live|tombstone, claimedAt, everPointed, pointedAt, ips, codeHash, pending, notices, log }
 *   r/<route>         the one name a route holds
 *   p/<route>         the name a route has a pending recovery for
 *   c/<kind>/<day>/<key>   a day's counter
 *   nc/<route>/<nonce>     a used signature nonce
 * Requests run one at a time, so a check followed by a write cannot interleave with another call.
 */
export class Directory {
  /** @param {any} ctx @param {any} env */
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.q = Promise.resolve();
    this.now = () => Number(env.NOW ? env.NOW() : Date.now());
  }
  /** @param {Request} request */
  fetch(request) {
    const run = this.q.then(() => this.handle(request));
    this.q = run.then(() => {}, () => {});
    return run;
  }
  get store() { return this.ctx.storage; }

  /** @param {Request} request */
  async handle(request) {
    const { op, ip, auth, body, query } = await request.json();
    try {
      if (op === "sweep") { await this.sweep(); return reply(200, { data: { ok: true } }); }
      if (auth && !auth.admin && !await this.fresh(auth)) return fail(err(401, "unauthorized", "that request was already used"));
      const data = await /** @type {any} */ (this)["op_" + op](body || {}, auth, ip, query || {});
      return reply(200, { data });
    } catch (e) {
      const x = /** @type {any} */ (e);
      if (x && x.status && x.code) return fail(x);
      console.error("names: " + String(x && x.message).split(String(this.env.CF_API_TOKEN || "\0")).join("[token]"));
      return fail(err(502, "unavailable", "the directory could not finish that; try again"));
    }
  }

  /** A signature is good once. The nonce list is trimmed at most once a minute. @param {{route: string, nonce: string, ts: number}} a */
  async fresh(a) {
    const key = `nc/${a.route}/${a.nonce}`;
    if (await this.store.get(key)) return false;
    await this.store.put(key, a.ts);
    const last = (await this.store.get("nc-trim")) || 0;
    if (this.now() - last > 60_000) {
      await this.store.put("nc-trim", this.now());
      const old = [...(await this.store.list({ prefix: "nc/" }))].filter(([, ts]) => this.now() - ts > 2 * LIMITS.skewMs + 1000).map(([k]) => k);
      for (let i = 0; i < old.length; i += 100) await this.store.delete(old.slice(i, i + 100));
    }
    return true;
  }

  day() { return Math.floor(this.now() / DAY); }
  /** Add one to a day's counter; refuse when it was already at max. @param {string} kind @param {string} key @param {number} max @param {string} [message] */
  async count(kind, key, max, message = "too many today; try again tomorrow") {
    const k = `c/${kind}/${this.day()}/${key}`;
    const n = (await this.store.get(k)) || 0;
    if (n >= max) throw err(429, "rate_limited", message);
    await this.store.put(k, n + 1);
    return n + 1;
  }

  // -- records --

  /** The record for a name after the lazy rules: a recovery that came due lands, an unpointed claim past its week lapses. @param {string} name */
  async load(name) {
    let rec = await this.store.get(`n/${name}`);
    if (!rec) return null;
    if (rec.pending && rec.pending.eta <= this.now()) rec = await this.land(rec);
    if (rec.state === "claimed" && !rec.everPointed && this.now() - rec.claimedAt > LIMITS.lapseMs) { await this.drop(rec); return null; }
    return rec;
  }
  /** @param {any} rec */
  async save(rec) { await this.store.put(`n/${rec.name}`, rec); }
  /** Forget a name that never went live. @param {any} rec */
  async drop(rec) {
    await this.unpend(rec);
    await this.store.delete(`n/${rec.name}`);
    if (rec.route && await this.store.get(`r/${rec.route}`) === rec.name) await this.store.delete(`r/${rec.route}`);
    await this.wipeDns(rec);
  }
  /** A and AAAA and challenge records, best effort: a failure is retried by the sweep. @param {any} rec */
  async wipeDns(rec) {
    const dns = dnsFor(this.env), fq = `${rec.name}.${dns.zone}`;
    try {
      await dns.clear(fq, "A"); await dns.clear(fq, "AAAA"); await dns.clear(`_acme-challenge.${fq}`, "TXT");
      if (rec.dirty) { rec.dirty = false; await this.save(rec); }
    } catch (e) {
      if (await this.store.get(`n/${rec.name}`)) { rec.dirty = true; await this.save(rec); } else await this.store.put(`d/${rec.name}`, this.now());
    }
  }
  /** The 72 hours are up and nobody cancelled: the name moves to the new route. @param {any} rec */
  async land(rec) {
    const p = rec.pending;
    await this.unpend(rec);
    if (await this.store.get(`r/${p.route}`)) { this.note(rec, "recovery-void", { reason: "route already holds a name" }); await this.save(rec); return rec; }
    if (rec.route && await this.store.get(`r/${rec.route}`) === rec.name) await this.store.delete(`r/${rec.route}`);
    await this.store.put(`r/${p.route}`, rec.name);
    await this.store.delete(`m/${p.route}`); // the route holds a name again: the old "moved" note no longer applies
    rec.route = p.route;
    rec.codeHash = p.next;
    rec.state = rec.everPointed ? "live" : "claimed";
    rec.claimedAt = this.now();
    rec.ips = {};
    this.note(rec, "recovered", {});
    await this.save(rec);
    await this.wipeDns(rec);
    return rec;
  }
  /** @param {any} rec @param {string} kind @param {object} extra */
  note(rec, kind, extra) {
    rec.notices = [...(rec.notices || []), { id: crypto.randomUUID(), kind, at: this.now(), ...extra }].slice(-NOTICES);
  }
  /** The name this route holds, if it does. @param {string} route */
  async held(route) {
    let name = await this.store.get(`r/${route}`);
    if (!name) {
      // A recovery may have come due for this route: loading its name lands it.
      const pending = await this.store.get(`p/${route}`);
      if (pending) { await this.load(pending); name = await this.store.get(`r/${route}`); }
    }
    return name ? this.load(name) : null;
  }
  /** Take a pending rebind off a record and its index entry. @param {any} rec */
  async unpend(rec) {
    if (rec.pending) await this.store.delete(`p/${rec.pending.route}`);
    rec.pending = null;
  }
  /** The caller's own live record for a name, or a refusal that says the same for missing and not yours. @param {any} b @param {{route: string}} a */
  async owned(b, a) {
    const v = verdict(b.name);
    const rec = v.status === "invalid" ? null : await this.load(v.name);
    if (!rec || rec.route !== a.route || rec.state === "tombstone") throw err(403, "not_yours", "that name is not held by this server");
    return rec;
  }

  // -- operations --

  async op_check(_b, auth, _ip, q) {
    const v = verdict(q.name);
    if (v.status !== "ok") return { name: v.name, status: v.status, why: v.why };
    const rec = await this.load(v.name);
    if (!rec) {
      // One namespace: a name an identity holds is taken here too.
      const id = await this.idLoad(v.name);
      if (!id) return { name: v.name, status: "ok", why: null };
      if (auth && Array.isArray(id.eids) && id.eids.includes(auth.route)) return { name: v.name, status: "mine", why: null };
      return { name: v.name, status: "taken", why: "someone else has that name" };
    }
    if (auth && rec.route === auth.route) return { name: v.name, status: "mine", why: null };
    return { name: v.name, status: "taken", why: "someone else has that name" };
  }

  async op_claim(b, a, ip) {
    const v = verdict(b.name);
    if (v.status === "invalid") throw err(400, "invalid", v.why || "not a name");
    if (v.status === "reserved") throw err(403, "reserved", "that name is reserved");
    const held = await this.held(a.route);
    if (held) {
      if (held.name === v.name) return { name: v.name, mine: true, code: null };
      throw err(409, "one_per_route", `this server already holds ${held.name}`);
    }
    await this.count("ip", ip, Number(this.env.CLAIMS_PER_IP_PER_DAY) || LIMITS.claimsPerIp, "too many names claimed from this address today");
    const max = Number(this.env.GLOBAL_CLAIMS_PER_DAY) || LIMITS.claimsGlobal;
    const total = await this.count("all", "all", max, "the directory is busy today; try again tomorrow").catch(e => {
      console.warn(`names: ALERT the daily claim ceiling (${max}) is reached`);
      throw e;
    });
    if (total === max) console.warn(`names: ALERT the daily claim ceiling (${max}) is now reached`);
    if (await this.load(v.name) || await this.idLoad(v.name)) throw err(409, "taken", "someone else has that name");
    const raw = new Uint8Array(16);
    crypto.getRandomValues(raw);
    const code = base32(raw).slice(0, 26).replace(/(.{4})(?=.)/g, "$1-");
    const rec = { name: v.name, route: a.route, state: "claimed", claimedAt: this.now(), everPointed: false, pointedAt: null, ips: {}, codeHash: await codeHash(v.name, code), pending: null, notices: [], log: [] };
    await this.save(rec);
    await this.store.put(`r/${a.route}`, v.name);
    await this.store.delete(`m/${a.route}`); // the route holds a name again: the old "moved" note no longer applies
    return { name: v.name, mine: true, code };
  }

  async op_point(b, a) {
    const rec = await this.owned(b, a);
    const t = tailnetIp(b.ip);
    if (!t) throw err(400, "not_tailnet", "only tailnet addresses (100.64.0.0/10, fd7a:115c:a1e0::/48) can be published");
    // IPv4 only: a rebind-filtering resolver (Pi-hole, dnsmasq --stop-dns-rebind) drops an fd7a:: AAAA answer, so a name
    // that carried one would need a router setting the person cannot be asked to change. The A record always passes.
    if (t.type !== "A") throw err(400, "ipv4_only", "only the IPv4 tailnet address (100.64.0.0/10) is published for a name");
    await this.count("point", a.route, LIMITS.pointPerRoute);
    const dns = dnsFor(this.env);
    const fq = `${rec.name}.${dns.zone}`;
    await dns.point(fq, t.type, t.ip);
    // A name that was pointed before this rule may still carry an AAAA: it goes, so a rebind-filtering resolver has nothing to drop
    // and the own-zone availability check never reads a stale AAAA as someone else's. Best effort: the sweep clears it too.
    await dns.clear(fq, "AAAA").catch(() => {});
    rec.everPointed = true; rec.state = "live"; rec.pointedAt = this.now(); rec.ips = { [t.type]: t.ip };
    await this.save(rec);
    return { name: rec.name, fqdn: `${rec.name}.${dns.zone}`, type: t.type, ip: t.ip };
  }

  /** The box serves its own network gate on a public address: the name's A record becomes the public IPv4 this request came from. It is the caller's own observed address, never one it names. */
  async op_publish(b, a, ip) {
    const rec = await this.owned(b, a);
    const addr = publicIpv4(ip);
    if (!addr) throw err(400, "not_public", "this request did not come from a public IPv4 address, so there is nothing to publish");
    await this.count("point", a.route, LIMITS.pointPerRoute);
    const dns = dnsFor(this.env);
    const fq = `${rec.name}.${dns.zone}`;
    await dns.point(fq, "A", addr);
    await dns.clear(fq, "AAAA").catch(() => {});
    rec.everPointed = true; rec.state = "live"; rec.pointedAt = this.now(); rec.ips = { A: addr };
    await this.save(rec);
    return { name: rec.name, fqdn: fq, type: "A", ip: addr };
  }

  /** Where a challenge goes: under the name for a name, under <routehash>.acme for the person's own domain. */
  async target(b, a) {
    const dns = dnsFor(this.env);
    if (b.own === true) {
      if (!await this.held(a.route)) throw err(403, "not_yours", "claim a name first");
      return `${await routeHash(a.route)}.acme.${dns.zone}`;
    }
    const rec = await this.owned(b, a);
    return `_acme-challenge.${rec.name}.${dns.zone}`;
  }
  async op_acme(b, a) {
    const fqdn = await this.target(b, a);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(String(b.token || ""))) throw err(400, "bad_token", "not an ACME challenge value");
    await this.count("acme", a.route, LIMITS.acmePerRoute, "too many challenges today");
    await dnsFor(this.env).addTxt(fqdn, b.token, LIMITS.txtPerLabel);
    return { fqdn };
  }
  async op_acmeClear(b, a) {
    const fqdn = await this.target(b, a);
    await dnsFor(this.env).clear(fqdn, "TXT");
    return { fqdn };
  }

  async op_release(b, a) {
    const rec = await this.owned(b, a);
    await this.store.delete(`r/${a.route}`);
    if (!rec.everPointed) { await this.drop(rec); return { name: rec.name, tombstone: false }; }
    // Ever live: it can never be anyone else's. Only the recovery code moves it.
    await this.unpend(rec);
    Object.assign(rec, { state: "tombstone", route: null, ips: {} });
    this.note(rec, "released", {});
    await this.save(rec);
    await this.wipeDns(rec);
    return { name: rec.name, tombstone: true };
  }

  /** The new route asks to take a name over. The answer never says whether the name exists. */
  async op_recover(b, a, ip) {
    const v = verdict(b.name);
    await this.count("rip", ip, LIMITS.recoverPerIp, "too many recovery attempts from this address today");
    await this.count("rname", v.name, LIMITS.recoverPerName, "too many recovery attempts for that name today");
    const refused = () => err(403, "refused", "that name and code do not match");
    if (v.status === "invalid" || !/^[0-9a-f]{64}$/.test(String(b.next || ""))) throw refused();
    const rec = await this.load(v.name);
    const ok = rec && same(rec.codeHash, await codeHash(v.name, String(b.code || "")));
    if (rec) { rec.log = [...(rec.log || []), { at: this.now(), ok: Boolean(ok), route: a.route.slice(0, 8) }].slice(-50); await this.save(rec); }
    if (!ok) throw refused();
    if (rec.route === a.route) throw err(409, "already_yours", "this server already holds that name");
    if (await this.store.get(`r/${a.route}`)) throw err(409, "one_per_route", "this server already holds a name");
    if (rec.pending) {
      if (rec.pending.route === a.route) return { name: rec.name, pendingUntil: rec.pending.eta };
      throw err(409, "pending", "another recovery of that name is already waiting");
    }
    rec.pending = { route: a.route, at: this.now(), eta: this.now() + LIMITS.recoverMs, next: b.next };
    await this.store.put(`p/${a.route}`, rec.name);
    this.note(rec, "recovery-pending", { eta: rec.pending.eta, by: a.route.slice(0, 8) });
    await this.save(rec);
    return { name: rec.name, pendingUntil: rec.pending.eta };
  }
  async op_cancel(b, a) {
    const rec = await this.owned(b, a);
    if (!rec.pending) return { name: rec.name, cancelled: false };
    await this.unpend(rec);
    this.note(rec, "recovery-cancelled", {});
    await this.save(rec);
    return { name: rec.name, cancelled: true };
  }
  async op_code(b, a) {
    const rec = await this.owned(b, a);
    if (!/^[0-9a-f]{64}$/.test(String(b.next || ""))) throw err(400, "bad_code", "send the hash of the new code");
    rec.codeHash = b.next;
    await this.unpend(rec);
    this.note(rec, "code-replaced", {});
    await this.save(rec);
    return { name: rec.name };
  }

  async op_mine(_b, a) {
    const rec = await this.held(a.route);
    if (!rec) {
      const moved = await this.store.get(`m/${a.route}`);
      return moved ? { name: null, moved } : { name: null };
    }
    const dns = dnsFor(this.env);
    return { name: rec.name, fqdn: `${rec.name}.${dns.zone}`, state: rec.state, pointed: rec.everPointed, ips: rec.ips,
      pending: rec.pending ? { at: rec.pending.at, eta: rec.pending.eta } : null, notices: rec.notices || [], acmeZone: `${await routeHash(a.route)}.acme.${dns.zone}` };
  }

  /**
   * Support only (the ADMIN_SECRET header, checked by the Worker): move a name to another route at once, with no
   * 72-hour wait, for a person whose old server is gone. It writes an admin-rebind notice to the name's log, keeps
   * the recovery code as it is, leaves a note for the old route (so its devices are told if the server is still
   * reachable), and wipes the old DNS records so the new box publishes its own address.
   * @param {any} b @param {{admin?: boolean}} a
   */
  async op_adminRebind(b, a) {
    if (!a || !a.admin) throw err(401, "unauthorized", "not authorised");
    const v = verdict(String(b.name || ""));
    if (v.status === "invalid") throw err(400, "bad_request", "not a name");
    const route = String(b.route || "");
    if (!ROUTE_RE.test(route)) throw err(400, "bad_request", "not a route");
    const rec = await this.load(v.name);
    if (!rec) throw err(404, "no_such_name", "nobody holds that name");
    if (rec.route === route) throw err(409, "already_yours", "that route already holds the name");
    if (await this.store.get(`r/${route}`)) throw err(409, "one_per_route", "that route already holds a name");
    const old = rec.route;
    await this.unpend(rec);
    if (old && await this.store.get(`r/${old}`) === rec.name) await this.store.delete(`r/${old}`);
    if (old) await this.store.put(`m/${old}`, { name: rec.name, at: this.now() });
    await this.store.put(`r/${route}`, rec.name);
    await this.store.delete(`m/${route}`); // the route holds a name again: the old "moved" note no longer applies
    Object.assign(rec, { route, state: rec.everPointed ? "live" : "claimed", claimedAt: this.now(), ips: {} });
    this.note(rec, "admin-rebind", { from: old ? old.slice(0, 8) : null, to: route.slice(0, 8) });
    await this.save(rec);
    await this.wipeDns(rec);
    return { name: rec.name, route: route.slice(0, 8), state: rec.state };
  }

  /** Land what came due, lapse what expired, retry DNS cleanups, drop yesterday's counters. */
  async sweep() {
    for (const [, rec] of await this.store.list({ prefix: "n/" })) {
      const now = await this.load(rec.name);
      if (now && now.dirty) await this.wipeDns(now);
    }
    for (const [key] of await this.store.list({ prefix: "d/" })) {
      const name = key.slice(2);
      await this.wipeDns({ name });
      await this.store.delete(key);
    }
    const stale = [...(await this.store.list({ prefix: "c/" })).keys()].filter(k => Number(k.split("/")[2]) < this.day() - 1);
    for (let i = 0; i < stale.length; i += 100) await this.store.delete(stale.slice(i, i + 100));
  }
}

Object.assign(Directory.prototype, idOps);
