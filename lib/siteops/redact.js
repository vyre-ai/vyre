// @ts-check
// redact: what a model may see of a browser's secrets, which is their names and never their values.
//
// Cookies, bearer tokens, session ids, CSRF tokens, API keys and passwords ride in headers, cookie
// jars, storage, JSON bodies, URLs and page text. Every result the extension sends back goes
// through here inside the browser, and the module runs it a second time on what arrives
// (defense in depth: a capability written later cannot forget). The rule is one-way and has no
// off switch: there is no argument that asks for a raw value. The vault's fill path is separate
// and never returns a value to the model at all.
//
// The tag left behind says what kind of thing was removed and how long it was, so a model can
// still reason ("the request carried a bearer token, 43 characters") without holding it.

import { locateSecrets } from "../credential-shapes.js";

export const MASK = "[redacted";

/** Header names whose value is a credential or identifies a session. Lowercase. */
const HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-csrf-token|x-xsrf-token|x-api-key|x-auth-token|x-access-token|x-amz-security-token|x-goog-api-key|x-goog-authuser|api-key|apikey|x-.*(token|secret|session|auth|key).*)$/i;

/** Object keys (JSON bodies, storage, cookies) that hold a secret whatever their value looks like. */
const KEY = /(^|[_\-.\s])(pass(word|wd|phrase)?|pwd|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|bearer|jwt|session([_-]?id)?|sid|csrf|xsrf|api[_-]?key|apikey|private[_-]?key|client[_-]?secret|auth(orization)?|credential|cookie|otp|pin|cvv|cvc|ssn|signature)([_\-.\s]|$)|(token|secret|password|apikey|api_key|sessionid|authorization)$/i;

/** decodeURIComponent that never throws: a page chooses these names and %zz is a legal thing to name a parameter. */
const safeDecode = (/** @type {string} */ k) => { const t = String(k).replace(/\+/g, " "); try { return decodeURIComponent(t); } catch { return t; } };

/** Query-string parameters that carry one. */
const PARAM = KEY;

/** Values that look like credentials wherever they turn up (a log line, a page, a URL path). */
const SHAPES = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g, "jwt"],
  [/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/g, "auth"],
  [/\b(?:sk|pk|rk|rq_live|rq_test|ghp|gho|ghu|ghs|github_pat|xox[abprs]|AKIA|AIza|ya29)[-_A-Za-z0-9.]{16,}/g, "key"],
  [/\b[A-Fa-f0-9]{32,}\b/g, "hex"],
  [/\b[A-Za-z0-9+_-]{40,}={0,2}(?![A-Za-z0-9+/_-])/g, "blob"],
];

/** @param {string} kind @param {unknown} value */
const tag = (kind, value) => `${MASK}:${kind}:${String(value).length}]`;

/** True when a name is one that always holds a secret. @param {string} name */
export const secretName = name => KEY.test(String(name)) || HEADER.test(String(name));

/** One string with every credential-shaped run replaced: first every shape the table of vendor keys knows (lib/credential-shapes.js, copied beside this file in the extension), then the generic runs above. @param {string} s */
export function text(s) {
  let out = String(s);
  const spans = locateSecrets(out);
  for (let i = spans.length - 1; i >= 0; i--) out = out.slice(0, spans[i].start) + tag("key", spans[i].value) + out.slice(spans[i].end);
  for (const [re, kind] of SHAPES) out = out.replace(re, m => (m.startsWith(MASK) ? m : tag(/** @type {string} */ (kind), m)));
  return out;
}

/** A header value. @param {string} name @param {unknown} value */
export const header = (name, value) => HEADER.test(String(name)) ? tag("header", value) : text(String(value));

/** Headers as an object or a [{name,value}] list; the shape in is the shape out. @param {any} h */
export function headers(h) {
  if (!h) return h;
  if (Array.isArray(h)) return h.map(x => ({ ...x, value: header(x.name, x.value) }));
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, header(k, v)]));
}

/** A URL with secret-named query parameters and token-shaped path segments masked. @param {string} u */
export function url(u) {
  const s = String(u);
  const q = s.indexOf("?");
  const h = s.indexOf("#");
  const cut = [q, h].filter(i => i >= 0).sort((a, b) => a - b)[0];
  const base = cut === undefined ? s : s.slice(0, cut);
  let rest = cut === undefined ? "" : s.slice(cut);
  rest = rest.replace(/([?&#;])([^=&#;]+)=([^&#;]*)/g, (m, sep, k, v) =>
    PARAM.test(safeDecode(k)) || text(v) !== v ? `${sep}${k}=${tag("param", v)}` : m);
  return base.split("/").map(text).join("/") + rest;
}

/**
 * Anything JSON-shaped, deep: secret-named keys lose their value, other strings lose credential-
 * shaped runs. Depth and size are bounded so a hostile page cannot make this the slow part.
 * @param {any} v @param {number} [depth]
 * @returns {any}
 */
export function value(v, depth = 0) {
  if (v == null || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "string") return text(v);
  if (depth > 12) return tag("deep", "");
  if (Array.isArray(v)) return v.slice(0, 2000).map(x => value(x, depth + 1));
  if (typeof v === "object") {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 2000)) {
      if (HEADER.test(k) && typeof x === "string") out[k] = tag("header", x);
      else if (KEY.test(k) && x != null && typeof x !== "object") out[k] = tag("secret", x);
      else if (KEY.test(k) && typeof x === "object") out[k] = tag("secret", JSON.stringify(x));
      else out[k] = value(x, depth + 1);
    }
    return out;
  }
  return String(v);
}

/** A body that may be JSON text, form-encoded or plain. @param {string} body @param {string} [mime] */
export function body(body, mime = "") {
  const s = String(body ?? "");
  const t = s.trimStart();
  if (/json/i.test(mime) || t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.stringify(value(JSON.parse(s))); } catch { /* fall through to text */ }
  }
  if (/x-www-form-urlencoded/i.test(mime) || /^[^\s=&]+=[^\s]*(&[^\s=&]+=[^\s]*)*$/.test(s)) {
    return s.replace(/(^|&)([^=&]+)=([^&]*)/g, (m, sep, k, v) => PARAM.test(safeDecode(k)) || text(v) !== v ? `${sep}${k}=${tag("param", v)}` : m);
  }
  return text(s);
}

/** Cookies: names, domains, flags and lifetimes survive; values never do. @param {any[]} list */
export const cookies = list => (list || []).map(c => ({ name: c.name, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly, sameSite: c.sameSite, session: !!c.session, expires: c.expires, value: tag("cookie", c.value ?? "") }));

/** A storage dump (localStorage, sessionStorage): every value goes, names stay. @param {Record<string, unknown>} o */
export const storage = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k, tag("storage", typeof v === "string" ? v : JSON.stringify(v))]));

/**
 * One captured network request as a model may read it. `raw` never leaves the browser.
 * @param {{ method?: string, url: string, status?: number, mime?: string, requestHeaders?: any, responseHeaders?: any, requestBody?: string, responseBody?: string, [k: string]: any }} r
 */
export function request(r) {
  const { requestHeaders, responseHeaders, requestBody, responseBody, ...rest } = r;
  return {
    ...rest,
    url: url(r.url),
    ...(requestHeaders ? { requestHeaders: headers(requestHeaders) } : {}),
    ...(responseHeaders ? { responseHeaders: headers(responseHeaders) } : {}),
    ...(requestBody !== undefined ? { requestBody: body(requestBody, headerOf(requestHeaders, "content-type")) } : {}),
    ...(responseBody !== undefined ? { responseBody: body(responseBody, r.mime || headerOf(responseHeaders, "content-type")) } : {}),
  };
}

/** @param {any} h @param {string} name */
function headerOf(h, name) {
  if (!h) return "";
  if (Array.isArray(h)) { const f = h.find(x => String(x.name).toLowerCase() === name); return f ? String(f.value) : ""; }
  const k = Object.keys(h).find(x => x.toLowerCase() === name);
  return k ? String(h[k]) : "";
}

/**
 * Run a redactor and, if it throws for any reason at all, mask the whole field instead of failing
 * or (worse) passing the raw value on. Callers on the daemon side wrap every redaction in this.
 * @param {() => any} fn @param {string} [what]
 */
export function guarded(fn, what = "unsafe") {
  try { return fn(); } catch { return tag(what, ""); }
}
