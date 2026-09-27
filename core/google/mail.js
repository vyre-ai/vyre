// @ts-check
// mail: Gmail v1 search, read, drafts and sends, shaped small for a model to read.
//
// Reads use gmail.readonly, drafts gmail.compose, and a send gmail.send alone, minted only when
// the Gate releases one. The message is built by hand (RFC 822, plain text, base64 body) with the
// shared parts in lib/connectors/message.js, for the reasons given there. This file does not
// import core/gate (modules never import each other's files).

import { addresses, checkContent, rfc822Text, htmlToText, addressOf, nameOf } from "../../lib/connectors/message.js";

export { addresses, htmlToText, addressOf, nameOf };

const MESSAGES = "/gmail/v1/users/me/messages";
const BODY_CAP = 20_000;
const META = ["From", "Reply-To", "To", "Cc", "Subject", "Date", "Message-ID", "References"];

/** @typedef {import("./api.js").Account} Account */

const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });

/**
 * Check a message's content, the same way before it is held and when it is released: the person
 * may have edited it in between. A Gmail thread id is the one Gmail-only field.
 * @param {string[]} to @param {any} c
 */
export function checkMessage(to, c) {
  checkContent(to, c);
  if (c.thread_id !== undefined && c.thread_id !== "" && !/^[A-Za-z0-9_-]{1,64}$/.test(String(c.thread_id))) throw bad("thread_id must be a Gmail thread id");
}

/** An RFC 822 message as base64url, for Gmail's `raw`. @param {Parameters<typeof rfc822Text>[0]} m */
export const rfc822 = m => Buffer.from(rfc822Text(m), "utf8").toString("base64url");

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
