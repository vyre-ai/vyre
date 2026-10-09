// @ts-check
// signing: the public side of an app that signs documents (R032-02). An app host answers nobody without a ticket, except what its manifest lists here: the few routes a SIGNER's browser calls, matched
// exactly by method and path, and nothing else. A request on the list goes to the app WITHOUT the install's admin session (the proxy keeps that for the owner and admins) and comes back with Vyre's
// own look laid over the page and the app's licence credit in the footer. The pure parts are here; the proxy applies them.

const SEG = "[A-Za-z0-9_-]{1,80}";
/** A signed token in one segment (a storage key and its signature: base64 with = and --). Only `:blob` takes it. */
const BLOB = "[A-Za-z0-9_=%.-]{1,2400}";
/** The characters of a file path below a prefix (a signed file's name): letters, digits and a few marks, never a dot-dot. */
const REST = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.~%-]+(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.~%-]+)*";

/**
 * A route pattern as a regular expression: `:name` is one path segment (`:blob` also allows a signed token's = and .), a trailing `/*` is the rest of the path. Anything else must match as written.
 * @param {string} pattern @returns {RegExp}
 */
export function compile(pattern) {
  if (typeof pattern !== "string" || !/^\/[A-Za-z0-9_.:\/*-]{0,120}$/.test(pattern) || pattern.includes("..") || pattern.includes("//")) throw new Error(`not a signing route: ${String(pattern).slice(0, 60)}`);
  const parts = pattern.split("/").slice(1);
  const re = parts.map((p, i) => {
    if (p === "*") { if (i !== parts.length - 1) throw new Error("* may only end a route"); return `(?:${REST})`; }
    if (p.startsWith(":")) { if (!/^:[a-z][a-z0-9_]{0,20}$/.test(p)) throw new Error(`not a signing route: ${pattern}`); return p === ":blob" ? BLOB : SEG; }
    return p.replace(/[.]/g, "\\.");
  }).join("/");
  return new RegExp(`^/${re}$`);
}

/**
 * The manifest's `app.signing`: { routes: [{ methods, path }], redirects?: [{ from, to }] }. The matcher says whether a request is on the list; `redirect` gives the place a pretty link goes.
 * @param {{ routes?: { methods: string[], path: string }[], redirects?: { from: string, to: string }[] } | undefined | null} signing
 */
export function matcher(signing) {
  const routes = ((signing && signing.routes) || []).map(r => ({ methods: new Set(r.methods.map(m => m.toUpperCase())), re: compile(r.path) }));
  const redirects = ((signing && signing.redirects) || []).map(r => ({ re: compile(r.from), from: r.from, to: r.to }));
  return {
    /** @param {string} method @param {string} pathname */
    open: (method, pathname) => !/%(?:2e|2f|5c|00)/i.test(pathname) && routes.some(r => r.methods.has(String(method).toUpperCase()) && r.re.test(pathname)),
    /** @param {string} pathname @returns {string | null} */
    redirect(pathname) {
      for (const r of redirects) {
        if (!r.re.test(pathname)) continue;
        const names = [...r.from.matchAll(/:([a-z][a-z0-9_]*)/g)].map(m => m[1]);
        const segs = pathname.split("/").slice(1), src = r.from.split("/").slice(1);
        /** @type {Record<string, string>} */ const got = {};
        src.forEach((s, i) => { if (s.startsWith(":")) got[s.slice(1)] = segs[i]; });
        void names;
        return r.to.replace(/:([a-z][a-z0-9_]*)/g, (_m, n) => got[n] ?? "");
      }
      return null;
    },
  };
}

/** The credit every public page carries: legible, with a link to the source (the licence asks for it). */
export const CREDIT_HTML = '<div id="vyre-credit">Signatures by <a href="https://github.com/docusealco/docuseal" rel="noopener noreferrer">DocuSeal</a>, open source (AGPL-3.0)</div>';
/** The style of that credit, always sent, with or without a brand. */
export const CREDIT_CSS = "#vyre-credit{box-sizing:border-box;width:100%;padding:10px 16px;text-align:center;font:12px/1.4 system-ui,sans-serif;color:#555;background:transparent}#vyre-credit a{color:inherit;text-decoration:underline}";

/**
 * Lay Vyre's look over an HTML page: one stylesheet link before the head ends, the credit before the body ends. No script. A page with no head or body gets them at the ends.
 * @param {string} html @param {string} href
 */
export function dress(html, href) {
  const link = `<link rel="stylesheet" href="${href}">`;
  let out = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${link}</head>`) : link + html;
  out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, `${CREDIT_HTML}</body>`) : out + CREDIT_HTML;
  return out;
}

/** Headers every public page carries: the signing link is in the address, so it never travels as a referrer, the page is not indexed, and a page is never cached. @param {boolean} html */
export function publicHeaders(html) {
  return { "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow", "x-content-type-options": "nosniff", ...(html ? { "cache-control": "no-store" } : {}) };
}

/** Cookies from the signer's own browser, with ours taken out: only the app's own (its CSRF and session for that signer) go to the app. @param {string | undefined} header */
export function signerCookies(header) {
  return String(header || "").split(/;\s*/).filter(c => c && !/^vyre_/.test(c)).join("; ");
}

/** A Set-Cookie the app sent a signer, made safe to hand on: no Domain (it is ours now), Secure kept. @param {string} c */
export function handOn(c) {
  return c.split(";").filter((p, i) => i === 0 || !/^\s*domain\s*=/i.test(p)).join(";");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- the signed copy's link

import crypto from "node:crypto";

/** Where an expiring link to the signed copy lives on the app's host. */
export const SIGNED = "/signed/";
export const MAX_LINK_DAYS = 30;
const b64u = (/** @type {Buffer} */ b) => b.toString("base64url");
const mac = (/** @type {Buffer} */ key, /** @type {string} */ exp, /** @type {string} */ slug) => b64u(crypto.createHmac("sha256", key).update(`vyre-signed-link\n${exp}\n${slug}`).digest());

/**
 * A link to the signed copy of one document: the signer's slug and an end time, under a key only the box holds. The signing page's own address keeps working; this is the only way to the finished PDF.
 * @param {Buffer} key @param {string} slug @param {number} expiresMs
 */
export function mintLink(key, slug, expiresMs) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw new Error("not a signer's slug");
  const exp = String(Math.floor(expiresMs / 1000));
  return `${exp}.${slug}.${mac(key, exp, slug)}`;
}

/** @param {Buffer} key @param {string} token @param {number} now @returns {{ ok: true, slug: string } | { ok: false, expired: boolean }} */
export function checkLink(key, token, now) {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{1,80})\.([A-Za-z0-9_-]{43})$/.exec(String(token));
  if (!m) return { ok: false, expired: false };
  const want = Buffer.from(mac(key, m[1], m[2])), got = Buffer.from(m[3]);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return { ok: false, expired: false };
  return Number(m[1]) * 1000 > now ? { ok: true, slug: m[2] } : { ok: false, expired: true };
}

/** What the signed-copy answer looks like when the link has run out: plain, without the slug, and it says what to do. */
export const EXPIRED_HTML = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link expired</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem"><h1>This link has expired</h1><p>Links to a signed copy last 30 days. Ask whoever sent you the document for a new one.</p></body>';

/** The URLs of the signed files in the app's answer about a finished document, whatever its shape: every string that is a file path. @param {unknown} v @returns {string[]} */
export function filePaths(v) {
  /** @type {string[]} */ const out = [];
  const walk = (/** @type {any} */ x, d = 0) => { if (d > 5) return; if (typeof x === "string") { if (/^\/(?:file|blobs_proxy)\/[A-Za-z0-9_=%.-]+\/[A-Za-z0-9_.~%\/-]+$/.test(x) && !x.includes("..")) out.push(x); } else if (Array.isArray(x)) x.forEach(y => walk(y, d + 1)); else if (x && typeof x === "object") Object.values(x).forEach(y => walk(y, d + 1)); };
  walk(v);
  return [...new Set(out)];
}

/** The body that asks the signing app for one signature and tells it to send nothing itself: the person's own words go out through Comms. @param {number} templateId @param {string} email @param {string} [name] */
export function requestBody(templateId, email, name) {
  if (!Number.isInteger(templateId) || templateId < 1) throw new Error("template_id is the number of the signing template in Documents");
  if (!/^[^\s@<>,;]{1,64}@[^\s@<>,;]{1,255}$/.test(email)) throw new Error("email is the signer's address");
  return { template_id: templateId, send_email: false, submitters: [{ email, ...(name ? { name: String(name).slice(0, 120) } : {}) }] };
}

/** The signer's submission number and slug in the app's answer to a request, or null. @param {unknown} json @returns {{ submission: number, slug: string } | null} */
export function readRequest(json) {
  const first = Array.isArray(json) ? json[0] : json && typeof json === "object" && Array.isArray(/** @type {any} */ (json).submitters) ? /** @type {any} */ (json).submitters[0] : null;
  const n = first && Number(first.submission_id), slug = first && first.slug;
  return Number.isInteger(n) && n > 0 && typeof slug === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(slug) ? { submission: n, slug } : null;
}
