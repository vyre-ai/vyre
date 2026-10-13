// @ts-check
// The weekly update list for vyre.run: a small Worker that takes a name and an email with a consent, keeps one row per
// address in Workers KV, and removes it again from a signed unsubscribe link. It sends nothing.
//
//   POST /api/updates                    { name, email, consent, source? }  JSON, or the plain HTML form
//   GET  /api/updates/unsubscribe?t=...  a page with one button (a mail scanner that opens the link must not unsubscribe anyone)
//   POST /api/updates/unsubscribe?t=...  deletes the row (also what a mail client's one-click unsubscribe sends)
//
// It sits on the vyre.run zone as a route, so the form posts to its own origin and no CORS is needed. The address never
// reaches a log: this file calls no console function, and the configuration turns Cloudflare's request logs off. A row is keyed
// by a keyed hash of the address, so the KV key list shows no address. See updates/worker/README.md.

import { CONSENT_VERSION } from "./consent.js";

const enc = new TextEncoder();
const MAX_BODY = 4096;
const NAME_MAX = 80;
const EMAIL_MAX = 254;
const SOURCE_RE = /^\/[a-z0-9/_-]{0,40}$/;
const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/;

/** @param {Uint8Array} bytes */
export const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** @param {string} s */
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** @param {string} secret @param {string[]} usage */
const hmacKey = (secret, usage) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
/** @param {string} secret @param {string} msg */
const mac = async (secret, msg) => new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(msg)));

/** The row id: a keyed hash of the lowercase address, so the KV key list holds no address. @param {string} secret @param {string} email */
export const subscriberId = async (secret, email) => b64url(await mac(secret, "id\n" + email)).slice(0, 32);
/** The unsubscribe token for a row id: the id, a dot and its MAC. A sender builds `/api/updates/unsubscribe?t=<token>` from it. @param {string} secret @param {string} id */
export const subscriberToken = async (secret, id) => id + "." + b64url(await mac(secret, "unsub\n" + id));
/** The row id a token names, or null when the token is not one this Worker signed. Constant-time on the MAC. @param {string} secret @param {unknown} token */
async function idFromToken(secret, token) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const [id, sig] = token.split(".");
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), unb64url(sig), enc.encode("unsub\n" + id));
  return ok ? id : null;
}

/** @param {string} email */
export function validEmail(email) {
  if (email.length > EMAIL_MAX) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return false;
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((l) => l.length <= 63 && LABEL_RE.test(l)) && /^[a-z]{2,}$/.test(labels[labels.length - 1]);
}

const HEAD = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
/** @param {number} status @param {unknown} body */
const json = (status, body, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEAD, "content-type": "application/json; charset=utf-8", ...extra } });
const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A small page in the site's colours, for the people who post the form without script and for the unsubscribe link. @param {number} status @param {string} title @param {string} bodyHtml */
function page(status, title, bodyHtml) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(title)}</title><style>
:root{--bg:#F4F1EA;--ink:#141311;--ink2:#4a463f;--line:#DCD7CC;--accent:#5B3FD0}
@media (prefers-color-scheme:dark){:root{--bg:#0E0D0C;--ink:#F1EEE6;--ink2:#B3AEA4;--line:#2B2926;--accent:#B8A4FF}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:400 17px/1.55 "Instrument Sans","Helvetica Neue",Arial,sans-serif}
main{max-width:30em;width:100%}h1{font-size:28px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px}p{margin:0 0 16px;color:var(--ink2)}
a{color:var(--accent)}button{font:500 13px/1 ui-monospace,Menlo,monospace;letter-spacing:.09em;text-transform:uppercase;height:44px;padding:0 22px;border:1px solid var(--ink);background:var(--ink);color:var(--bg);cursor:pointer}
</style></head><body><main>${bodyHtml}</main></body></html>`;
  return new Response(html, { status, headers: { ...HEAD, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
const back = '<p><a href="https://vyre.run/">Back to vyre.run</a></p>';

/** @param {any} env */
const origin = (env) => (typeof env.ORIGIN === "string" && env.ORIGIN) || "https://vyre.run";

/** Reads the body as JSON or as an HTML form. Null when it is neither, too large or malformed. @param {Request} req */
async function readBody(req) {
  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && type !== "application/x-www-form-urlencoded") return null;
  const len = Number(req.headers.get("content-length") || 0);
  if (len > MAX_BODY) return { tooLarge: true };
  // Read the stream with a running cap, so a chunked body with no content-length is never read past MAX_BODY.
  let text = "";
  if (req.body) {
    const reader = req.body.getReader(), dec = new TextDecoder();
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > MAX_BODY) { try { await reader.cancel(); } catch { /* already closed */ } return { tooLarge: true }; }
      text += dec.decode(value, { stream: true });
    }
    text += dec.decode();
  }
  try {
    if (type === "application/json") {
      const v = JSON.parse(text);
      return v && typeof v === "object" && !Array.isArray(v) ? { fields: v, form: false } : null;
    }
    return { fields: Object.fromEntries(new URLSearchParams(text)), form: true };
  } catch { return null; }
}

/** @param {unknown} v */
const str = (v) => (typeof v === "string" ? v : "");
/** @param {unknown} v */
const agreed = (v) => v === true || v === "on" || v === "true" || v === "yes" || v === "1";

/** @param {Request} req @param {any} env */
async function signup(req, env) {
  const site = req.headers.get("origin");
  if (site && site !== origin(env)) return json(403, { error: "This form only works from vyre.run." });
  if (req.headers.get("sec-fetch-site") === "cross-site") return json(403, { error: "This form only works from vyre.run." });
  const body = await readBody(req);
  if (!body) return json(415, { error: "Send the form or JSON." });
  if ("tooLarge" in body) return json(413, { error: "That request is too large." });
  const { fields, form } = body;
  /** @param {number} status @param {string} error */
  const fail = (status, error) => form ? page(status, "Not saved", `<h1>Not saved</h1><p>${esc(error)}</p><p><a href="https://vyre.run/updates/">Back to the form</a></p>`) : json(status, { error });

  // A bot that fills the hidden field gets the same answer as a person, and nothing is stored.
  if (str(fields.website) !== "") return form ? done() : json(200, { data: { ok: true } });

  if (!agreed(fields.consent)) return fail(400, "Tick the box to say you want the weekly email.");
  const name = str(fields.name).replace(/\s+/g, " ").trim();
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f<>]/.test(name)) return fail(400, "Enter your name, up to 80 characters.");
  const email = str(fields.email).trim().toLowerCase();
  if (!validEmail(email)) return fail(400, "Enter a valid email address.");
  const source = SOURCE_RE.test(str(fields.source)) ? str(fields.source) : "/";

  const secret = env.UPDATES_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !env.UPDATES) return fail(503, "The list is not open yet. Try again later.");

  const who = req.headers.get("cf-connecting-ip") || "unknown";
  if (env.UPDATES_LIMITER && !(await env.UPDATES_LIMITER.limit({ key: who })).success) return fail(429, "Too many tries. Wait a minute.");

  // One row per address. A second signup changes nothing and answers the same, so the form cannot be used to find out who is on the list.
  const key = "s:" + await subscriberId(secret, email);
  if (!(await env.UPDATES.get(key))) {
    await env.UPDATES.put(key, JSON.stringify({ email, name, created_at: new Date().toISOString(), consent_version: CONSENT_VERSION, source, confirmed_at: null }));
  }
  return form ? done() : json(200, { data: { ok: true } });
}
const done = () => page(200, "You are on the list", `<h1>You are on the list.</h1><p>One email a week, at most, with what changed in Vyre. Every email has a link to leave.</p>${back}`);

/** @param {Request} req @param {URL} url @param {any} env */
async function unsubscribe(req, url, env) {
  const secret = env.UPDATES_SECRET;
  if (typeof secret !== "string" || secret.length < 32 || !env.UPDATES) return page(503, "Not available", "<h1>Not available</h1><p>Try again later.</p>" + back);
  const who = req.headers.get("cf-connecting-ip") || "unknown";
  if (env.UPDATES_LIMITER && !(await env.UPDATES_LIMITER.limit({ key: who })).success) return page(429, "Too many tries", "<h1>Too many tries</h1><p>Wait a minute and try again.</p>");
  let token = url.searchParams.get("t");
  if (req.method === "POST" && !token) {
    const b = await readBody(req);
    if (b && "fields" in b) token = str(b.fields.t) || null;
  }
  const id = await idFromToken(secret, token);
  if (!id) return page(400, "Link not valid", "<h1>This link is not valid.</h1><p>Use the link in the latest email, or write to <a href=\"mailto:privacy@vyre.run\">privacy@vyre.run</a> and ask to be removed.</p>" + back);
  if (req.method === "GET") {
    return page(200, "Leave the weekly update", `<h1>Leave the weekly update?</h1><p>This removes your name and email from the list.</p><form method="post" action="/api/updates/unsubscribe"><input type="hidden" name="t" value="${esc(token || "")}"><button type="submit">Remove me</button></form>${back}`);
  }
  await env.UPDATES.delete("s:" + id);
  return page(200, "You are off the list", `<h1>You are off the list.</h1><p>Your name and email are deleted. No more email from this list.</p>${back}`);
}

export default {
  /** @param {Request} req @param {any} env */
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/api/updates") {
      if (req.method !== "POST") return json(405, { error: "POST only." }, { allow: "POST" });
      return signup(req, env);
    }
    if (path === "/api/updates/unsubscribe") {
      if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "GET or POST only." }, { allow: "GET, POST" });
      return unsubscribe(req, url, env);
    }
    return json(404, { error: "Not found." });
  },
};
