// @ts-check
// senders: how a released item actually leaves, with the credential added at the last moment.
//
// A sender is configured by the person in config.json, never by a model: its type, the vault
// item that authenticates it (or a relayed pass, so the value never reaches this box), and for
// http the exact origins it may reach. Each type knows three things: what content it takes, a
// one-line summary for the held list, and how to send. The credential is fetched inside send()
// and exists only in that frame; whatever comes back is scrubbed of it before anyone sees it.
//
// Rules, and why:
// - A vault placeholder in a URL is refused. A value in a URL lands in access logs and proxies.
// - Redirects are never followed. A redirect would carry the credential to a host nobody allowed.
// - Origins match exactly: scheme, host and port. A wildcard is a way to reach a host you control.
// - No CR or LF in a mail header. A newline in a subject is how one email becomes two.
// This file deliberately does not import core/vault (modules never import each other's files),
// so it keeps its own small substitute. Scrubbing is lib/scrub.js, shared.

import { scrub, scrubAll } from "../../lib/scrub.js";

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const PLACEHOLDER = /\{\{\s*vault(?:\.([A-Za-z0-9_-]+))?\s*\}\}/g;
const HAS_PLACEHOLDER = /\{\{\s*vault(?:\.[A-Za-z0-9_-]+)?\s*\}\}/;
const TIMEOUT_MS = 30_000;
const MAX_BYTES = 2_000_000;

/**
 * @typedef {{ type: string, vault?: string, field?: string, pass?: { owner?: string, item: string },
 *   hosts?: string[], kinds?: string[], from?: string, base?: string }} SenderConfig
 * @typedef {{ fetchCredential: (item: string, field?: string) => Promise<string>, relay: (input: any) => Promise<any>,
 *   fetch?: typeof fetch }} SendDeps
 */

const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const isStr = v => typeof v === "string";
const noBreak = (v, what) => { if (/[\r\n]/.test(v)) throw new Error(`${what} cannot contain a line break`); };


/** True only when `url` is http(s) and its origin is exactly one of `hosts`. */
export function allowedOrigin(url, hosts) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return (hosts || []).some(h => { try { return new URL(h).origin === u.origin; } catch { return false; } });
}

/** The field names a request's placeholders ask for; "" is the item's default field. */
function wanted(request) {
  const out = new Set();
  const scan = s => { for (const m of String(s).matchAll(PLACEHOLDER)) out.add(m[1] || ""); };
  for (const v of Object.values(request.headers || {})) scan(v);
  if (isStr(request.body)) scan(request.body);
  return [...out];
}

/** Put values into header values and the body. `fields[""]` is the default field. */
function substitute(request, fields) {
  const fill = s => String(s).replace(PLACEHOLDER, (_, f) => fields[f || ""]);
  const out = { ...request };
  if (request.headers) out.headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k, fill(v)]));
  if (isStr(request.body)) out.body = fill(request.body);
  return out;
}

/** Check a request's shape and where placeholders sit. Throws a readable reason. */
function checkRequest(r, hosts) {
  if (!r || typeof r !== "object" || !isStr(r.url)) throw new Error("content needs a url");
  if (HAS_PLACEHOLDER.test(r.url)) throw new Error("a vault placeholder cannot go in the url: a value there ends up in access logs. Put it in a header or the body");
  if (!allowedOrigin(r.url, hosts)) throw new Error(`${r.url} is not one of this sender's hosts`);
  if (r.method !== undefined && !/^[A-Za-z]+$/.test(String(r.method))) throw new Error("method must be a word like POST");
  if (r.headers !== undefined) {
    if (!r.headers || typeof r.headers !== "object" || Array.isArray(r.headers)) throw new Error("headers must be an object");
    for (const [k, v] of Object.entries(r.headers)) {
      if (HAS_PLACEHOLDER.test(k)) throw new Error("a vault placeholder cannot go in a header name");
      if (!isStr(v)) throw new Error(`header ${k} must be a string`);
      noBreak(k + v, `header ${k}`);
    }
  }
  if (r.body !== undefined && r.body !== null && !isStr(r.body)) throw new Error("body must be a string");
}

/**
 * Send one request: redirects off, a timeout, a cap on the response size.
 * @param {{ method?: string, url: string, headers?: Record<string, string>, body?: string }} request
 * @param {typeof fetch} [f]
 */
export async function sendRequest(request, f = fetch) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS);
  try {
    const res = await f(request.url, { method: (request.method || "GET").toUpperCase(), headers: request.headers, body: request.body ?? undefined, redirect: "manual", signal: ctl.signal });
    let body = "", size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { ctl.abort(); await reader.cancel().catch(() => {}); throw new Error(`response is larger than ${MAX_BYTES} bytes`); }
        body += dec.decode(value, { stream: true });
      }
      body += dec.decode();
    }
    return { status: res.status, body };
  } catch (e) {
    if (timedOut) throw new Error(`no response within ${TIMEOUT_MS} ms`);
    throw e;
  } finally { clearTimeout(timer); }
}

/**
 * Send `request` with the sender's credential: fetched here and substituted, or left as
 * placeholders for the owner's Vyre to fill when the sender uses a relayed pass.
 * @param {SenderConfig} s @param {any} request @param {SendDeps} deps
 * @returns {Promise<{ status: number, body: string }>}
 */
async function withCredential(s, request, deps) {
  if (s.pass) {
    const r = await deps.relay({ item: s.pass.item, ...(s.pass.owner ? { owner: s.pass.owner } : {}), request });
    return { status: Number(r && r.status) || 0, body: typeof r?.body === "string" ? r.body : JSON.stringify(r?.body ?? "") };
  }
  const values = [];
  try {
    const fields = {};
    for (const f of wanted(request)) {
      const v = await deps.fetchCredential(/** @type {string} */ (s.vault), f || s.field || undefined);
      if (!isStr(v) || !v) throw new Error(`the vault gave nothing for ${s.vault}${f ? "." + f : ""}`);
      fields[f] = v; values.push(v);
    }
    const out = await sendRequest(substitute(request, fields), deps.fetch);
    return { status: out.status, body: scrub(out.body, values) };
  } catch (e) {
    throw new Error(scrub(/** @type {Error} */ (e).message || String(e), values));
  }
}

/** Encode a header value: plain ASCII as is, anything else as an RFC 2047 word. */
const header = v => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

/**
 * An RFC 822 message, by hand: a few headers and a base64 text body.
 * @param {{ from?: string, to: string[], cc?: string[], bcc?: string[], subject: string, body: string, in_reply_to?: string }} m
 */
export function rfc822(m) {
  const lines = [];
  if (m.from) lines.push(`From: ${m.from}`);
  lines.push(`To: ${m.to.join(", ")}`);
  if (m.cc && m.cc.length) lines.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc && m.bcc.length) lines.push(`Bcc: ${m.bcc.join(", ")}`);
  lines.push(`Subject: ${header(m.subject)}`);
  if (m.in_reply_to) lines.push(`In-Reply-To: ${m.in_reply_to}`, `References: ${m.in_reply_to}`);
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "");
  const b64 = Buffer.from(m.body, "utf8").toString("base64");
  lines.push(...(b64.match(/.{1,76}/g) || [""]));
  return lines.join("\r\n");
}

const list = (v, what) => {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  for (const a of arr) { if (!isStr(a) || !EMAIL.test(a)) throw new Error(`${what} must be email addresses; "${a}" is not one`); }
  return arr;
};

/**
 * The sender types. `content` is what the tool listing tells Claude each takes.
 * @type {Record<string, { kinds: string[], content: Record<string, string>,
 *   recipients?: (to: string[], content: any) => string[],
 *   check: (to: string[], content: any, s: SenderConfig) => void, summary: (to: string[], content: any) => string,
 *   send: (to: string[], content: any, s: SenderConfig, deps: SendDeps) => Promise<any> }>}
 */
export const TYPES = {
  gmail: {
    kinds: ["send"],
    content: { subject: "string", body: "string (plain text)", cc: "email[]?", bcc: "email[]?", in_reply_to: "Message-ID?" },
    check(to, c) {
      if (!to.length) throw new Error("an email needs at least one address in to");
      list(to, "to"); list(c.cc, "cc"); list(c.bcc, "bcc");
      if (!isStr(c.subject)) throw new Error("an email needs a subject");
      if (!isStr(c.body)) throw new Error("an email needs a body");
      noBreak(c.subject, "subject");
      if (c.in_reply_to !== undefined) { if (!isStr(c.in_reply_to)) throw new Error("in_reply_to must be a Message-ID"); noBreak(c.in_reply_to, "in_reply_to"); }
    },
    summary: (to, c) => cut(String(c.subject || "(no subject)"), 120),
    // Every real destination, so what the person said covers all of them: cc and bcc go out too.
    recipients: (to, c) => [...to, ...list(c.cc, "cc"), ...list(c.bcc, "bcc")],
    async send(to, c, s, deps) {
      const raw = Buffer.from(rfc822({ from: s.from, to, cc: list(c.cc, "cc"), bcc: list(c.bcc, "bcc"), subject: c.subject, body: c.body, in_reply_to: c.in_reply_to }), "utf8").toString("base64url");
      const base = String(s.base || "https://gmail.googleapis.com").replace(/\/+$/, "");
      const r = await withCredential(s, { method: "POST", url: `${base}/gmail/v1/users/me/messages/send`,
        headers: { authorization: "Bearer {{vault}}", "content-type": "application/json" }, body: JSON.stringify({ raw }) }, deps);
      if (r.status < 200 || r.status >= 300) throw new Error(`gmail answered ${r.status}: ${cut(r.body, 200)}`);
      let out = {};
      try { out = JSON.parse(r.body); } catch {}
      return { status: r.status, id: out.id ?? null, threadId: out.threadId ?? null };
    },
  },
  http: {
    kinds: ["send", "spend", "delete"],
    content: { method: "GET|POST|PUT|PATCH|DELETE", url: "one of the sender's hosts", headers: "object? ({{vault}} goes here)", body: "string? ({{vault}} may go here)" },
    check(to, c, s) { checkRequest(c, s.hosts || []); },
    summary: (to, c) => cut(`${String(c.method || "GET").toUpperCase()} ${c.url}`, 120),
    async send(to, c, s, deps) {
      checkRequest(c, s.hosts || []);
      const r = await withCredential(s, { method: c.method || "GET", url: c.url, ...(c.headers ? { headers: c.headers } : {}), ...(c.body != null ? { body: c.body } : {}) }, deps);
      if (r.status < 200 || r.status >= 300) throw new Error(`${new URL(c.url).origin} answered ${r.status}: ${cut(r.body, 200)}`);
      return { status: r.status, body: cut(r.body, 2000) };
    },
  },
};

/** Check a sender's config. Returns a problem or null. @param {string} name @param {any} s */
export function problem(name, s) {
  if (!s || typeof s !== "object") return `sender ${name} must be an object`;
  if (!TYPES[s.type]) return `sender ${name} has type "${s.type}"; the types are ${Object.keys(TYPES).join(", ")}`;
  if (!s.vault && !(s.pass && isStr(s.pass.item))) return `sender ${name} needs a vault item or a pass`;
  if (s.type === "http" && !(Array.isArray(s.hosts) && s.hosts.length)) return `sender ${name} needs hosts: the exact origins it may reach`;
  return null;
}

export { scrubAll };

export { scrub };
