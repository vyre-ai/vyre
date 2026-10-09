// @ts-check
// signing: the public side of an app that signs documents (R032-02). An app host answers nobody without a ticket, except what its manifest lists here: the few routes a SIGNER's browser calls, matched
// exactly by method and path, and nothing else. A request on the list goes to the app WITHOUT the install's admin session (the proxy keeps that for the owner and admins) and comes back with Vyre's
// own look laid over the page and the app's licence credit in the footer. The pure parts are here; the proxy applies them.

const SEG = "[A-Za-z0-9_-]{1,80}";
/** The characters of a file path below a prefix (a signed file's name): letters, digits and a few marks, never a dot-dot. */
const REST = "(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.~%-]+(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9_.~%-]+)*";

/**
 * A route pattern as a regular expression: `:name` is one path segment, a trailing `/*` is the rest of the path. Anything else must match as written.
 * @param {string} pattern @returns {RegExp}
 */
export function compile(pattern) {
  if (typeof pattern !== "string" || !/^\/[A-Za-z0-9_.:\/*-]{0,120}$/.test(pattern) || pattern.includes("..") || pattern.includes("//")) throw new Error(`not a signing route: ${String(pattern).slice(0, 60)}`);
  const parts = pattern.split("/").slice(1);
  const re = parts.map((p, i) => {
    if (p === "*") { if (i !== parts.length - 1) throw new Error("* may only end a route"); return `(?:${REST})`; }
    if (p.startsWith(":")) { if (!/^:[a-z][a-z0-9_]{0,20}$/.test(p)) throw new Error(`not a signing route: ${pattern}`); return SEG; }
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
