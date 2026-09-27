// @ts-check
// mail: Gmail v1 search, read, drafts and sends, shaped small for a model to read.
//
// Reads use gmail.readonly, drafts gmail.compose, and a send gmail.send alone, minted only when
// the Gate releases one. The message is built here by hand (RFC 822, plain text, base64 body),
// like the Gate's own Gmail sender, and for the same reasons: no CR or LF in any header (a newline
// in a subject is how one email becomes two), non-ASCII headers as RFC 2047 words, addresses
// checked one by one. This file does not import core/gate (modules never import each other's
// files), so it keeps its own small builder.

import { EMAIL } from "./accounts.js";

const MESSAGES = "/gmail/v1/users/me/messages";
const BODY_CAP = 20_000;
const META = ["From", "Reply-To", "To", "Cc", "Subject", "Date", "Message-ID", "References"];

/** @typedef {import("./api.js").Account} Account */

const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });
const noBreak = (v, what) => { if (/[\r\n]/.test(String(v))) throw bad(`${what} cannot contain a line break`); };

/** A list of addresses from a string, a comma list or an array; each one checked. */
export function addresses(v, what) {
  if (v === undefined || v === null || v === "") return [];
  const arr = (Array.isArray(v) ? v : String(v).split(",")).map(a => String(a).trim()).filter(Boolean);
  for (const a of arr) if (!EMAIL.test(a)) throw bad(`${what} must be email addresses; "${a.slice(0, 80)}" is not one`);
  return arr;
}

/** Plain ASCII as is, anything else as an RFC 2047 encoded word. */
const header = v => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

/**
 * Check a message's content, the same way before it is held and when it is released: the person
 * may have edited it in between.
 * @param {string[]} to @param {any} c
 */
export function checkMessage(to, c) {
  if (!to.length) throw bad("an email needs at least one address in to");
  addresses(to, "to"); addresses(c.cc, "cc"); addresses(c.bcc, "bcc");
  if (typeof c.subject !== "string") throw bad("an email needs a subject");
  if (typeof c.body !== "string") throw bad("an email needs a body");
  noBreak(c.subject, "subject");
  if (c.in_reply_to !== undefined && c.in_reply_to !== "") {
    if (!/^<[^<>\s]+>$/.test(String(c.in_reply_to))) throw bad("in_reply_to must be a Message-ID such as <abc@mail.example.com>");
  }
  if (c.thread_id !== undefined && c.thread_id !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(c.thread_id))) throw bad("thread_id must be a Gmail thread id");
}

/**
 * An RFC 822 message: a few headers and a base64 text body, as base64url for Gmail's `raw`.
 * @param {{ from?: string, to: string[], cc?: string[], bcc?: string[], subject: string, body: string, in_reply_to?: string, references?: string }} m
 */
export function rfc822(m) {
  const lines = [];
  if (m.from) { noBreak(m.from, "from"); lines.push(`From: ${m.from}`); }
  lines.push(`To: ${m.to.join(", ")}`);
  if (m.cc && m.cc.length) lines.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc && m.bcc.length) lines.push(`Bcc: ${m.bcc.join(", ")}`);
  noBreak(m.subject, "subject");
  lines.push(`Subject: ${header(m.subject)}`);
  if (m.in_reply_to) {
    noBreak(m.in_reply_to, "in_reply_to");
    const refs = m.references && !/[\r\n]/.test(m.references) ? `${m.references} ${m.in_reply_to}` : m.in_reply_to;
    lines.push(`In-Reply-To: ${m.in_reply_to}`, `References: ${refs}`);
  }
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "");
  const b64 = Buffer.from(m.body, "utf8").toString("base64");
  lines.push(...(b64.match(/.{1,76}/g) || [""]));
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** Text from HTML, enough to read: blocks become lines, tags go, entities are decoded. */
export function htmlToText(html) {
  const named = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };
  return String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (all, e) => {
      const k = e.toLowerCase();
      if (named[k]) return named[k];
      const n = k.startsWith("#x") ? parseInt(k.slice(2), 16) : k.startsWith("#") ? Number(k.slice(1)) : NaN;
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    })
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const decode = data => Buffer.from(String(data || ""), "base64url").toString("utf8");

/** The readable body of a Gmail payload: text/plain when there is one, else HTML made text. */
export function bodyOf(payload) {
  const plain = [], html = [], files = [];
  const walk = p => {
    if (!p) return;
    const type = String(p.mimeType || "").toLowerCase();
    if (p.filename) { files.push(String(p.filename)); return; }
    if (type === "text/plain" && p.body?.data) plain.push(decode(p.body.data));
    else if (type === "text/html" && p.body?.data) html.push(decode(p.body.data));
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  const text = plain.length ? plain.join("\n\n") : html.length ? htmlToText(html.join("\n")) : "";
  return { text: text.replace(/\r\n/g, "\n"), files };
}

const headersOf = payload => {
  const out = {};
  for (const h of payload?.headers || []) out[String(h.name).toLowerCase()] = String(h.value);
  return out;
};

/** Where the person opens a message in Gmail, signed in as the right account. */
const webUrl = (acct, id) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(acct.email)}#all/${encodeURIComponent(id)}`;
export const draftsUrl = acct => `https://mail.google.com/mail/?authuser=${encodeURIComponent(acct.email)}#drafts`;

/** A message the way a model wants it in a list. */
export function shapeMessage(acct, m) {
  const h = headersOf(m.payload);
  return {
    id: String(m.id), thread_id: String(m.threadId || ""), account: acct.name,
    from: h.from || "", to: h.to || "", subject: h.subject || "(no subject)",
    date: h.date || (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : ""),
    snippet: htmlToText(String(m.snippet || "")), url: webUrl(acct, String(m.threadId || m.id)),
  };
}

/** One message in full, as text, within `cap` characters. */
function readable(acct, m, cap) {
  const h = headersOf(m.payload);
  const { text, files } = bodyOf(m.payload);
  const truncated = text.length > cap;
  return {
    ...shapeMessage(acct, m),
    ...(h.cc ? { cc: h.cc } : {}), ...(h["message-id"] ? { message_id: h["message-id"] } : {}),
    body: truncated ? text.slice(0, Math.max(0, cap)) : text, ...(truncated ? { truncated: true } : {}),
    ...(files.length ? { attachments: files } : {}),
  };
}

/**
 * @param {{ request: (acct: Account, req: import("./api.js").Request) => Promise<any> }} deps
 */
export function mail({ request }) {
  const meta = (acct, id) => request(acct, { api: "gmail", scope: "gmail.readonly", path: `${MESSAGES}/${encodeURIComponent(id)}`,
    query: { format: "metadata", metadataHeaders: META } });

  async function searchOne(acct, q, limit) {
    const r = await request(acct, { api: "gmail", scope: "gmail.readonly", path: MESSAGES, query: { q, maxResults: limit } });
    const ids = (r.messages || []).slice(0, limit);
    const full = await Promise.all(ids.map(x => meta(acct, x.id)));
    return full.map(m => ({ ...shapeMessage(acct, m), _at: Number(m.internalDate) || Date.parse(headersOf(m.payload).date || "") || 0 }));
  }

  return {
    meta,
    /** Messages matching a Gmail query, newest first, across the given accounts. */
    async search(accts, { q, limit = 10 }) {
      const errors = [];
      const lists = await Promise.all(accts.map(a => searchOne(a, q, limit).catch(e => { errors.push({ account: a.name, error: String(e.message || e) }); return []; })));
      if (errors.length === accts.length) throw Object.assign(new Error(errors.map(e => `${e.account}: ${e.error}`).join("; ")), { code: "google" });
      const messages = lists.flat().sort((a, b) => b._at - a._at).slice(0, limit).map(({ _at, ...m }) => m);
      return { messages, ...(errors.length ? { errors } : {}) };
    },

    /** One message, or a whole thread oldest first, as text within the cap. */
    async read(acct, { id, thread_id }) {
      if (thread_id) {
        const t = await request(acct, { api: "gmail", scope: "gmail.readonly", path: `/gmail/v1/users/me/threads/${encodeURIComponent(thread_id)}`, query: { format: "full" } });
        let left = BODY_CAP;
        const messages = (t.messages || []).map(m => { const r = readable(acct, m, left); left -= r.body.length; return r; });
        return { thread_id: String(t.id || thread_id), account: acct.name, messages };
      }
      const m = await request(acct, { api: "gmail", scope: "gmail.readonly", path: `${MESSAGES}/${encodeURIComponent(String(id))}`, query: { format: "full" } });
      return readable(acct, m, BODY_CAP);
    },

    /** A Gmail draft: it goes nowhere until the person sends it from Gmail. */
    async draft(acct, to, c) {
      const raw = rfc822({ from: acct.email, to, cc: addresses(c.cc, "cc"), bcc: addresses(c.bcc, "bcc"), subject: c.subject, body: c.body,
        in_reply_to: c.in_reply_to || undefined, references: c.references });
      const r = await request(acct, { api: "gmail", scope: "gmail.compose", method: "POST", path: "/gmail/v1/users/me/drafts",
        body: { message: { raw, ...(c.thread_id ? { threadId: c.thread_id } : {}) } } });
      return { draft_id: String(r.id), message_id: String(r.message?.id || ""), thread_id: String(r.message?.threadId || ""), account: acct.name, url: draftsUrl(acct) };
    },

    /** Send, with gmail.send alone. Only google.release calls this, with what the person approved. */
    async send(acct, to, c) {
      const raw = rfc822({ from: acct.email, to, cc: addresses(c.cc, "cc"), bcc: addresses(c.bcc, "bcc"), subject: c.subject, body: c.body,
        in_reply_to: c.in_reply_to || undefined });
      const r = await request(acct, { api: "gmail", scope: "gmail.send", method: "POST", path: `${MESSAGES}/send`,
        body: { raw, ...(c.thread_id ? { threadId: c.thread_id } : {}) } });
      return { sent: true, id: String(r.id || ""), thread_id: String(r.threadId || ""), account: acct.name };
    },
  };
}

/** The address inside "Dana Reyes <dana@harlowlegal.com>". */
export function addressOf(from) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(from || ""));
  const a = m ? m[1] : String(from || "").trim();
  return EMAIL.test(a) ? a : "";
}

/** The name part of a From header, or the address. */
export function nameOf(from) {
  const s = String(from || "");
  const m = /^\s*"?([^"<]*?)"?\s*</.exec(s);
  return (m && m[1].trim()) || addressOf(s) || s;
}
