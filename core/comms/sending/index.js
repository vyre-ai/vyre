// @ts-check
// sending: the firm's own sending service (Resend, Mailgun, Postmark, SendGrid or plain SMTP) behind ONE call, send({from,to,subject,html,text,replyTo}). A Space keeps the service's key in its
// Vault and picks one; Flows send their email through it. Vyre's own servers send no email: the request goes from this machine to the firm's account at the service, over the guarded client.
// `shape` is pure (the request a provider wants, so a test reads it); `send` makes it. Every message carries the same checks, in words, and no error text ever repeats the key.
import { httpFetch } from "../../../lib/http.js";
import { imapAdapter } from "../../mail/imap.js";

export const PROVIDERS = Object.freeze(["resend", "mailgun", "postmark", "sendgrid", "smtp"]);
/** What a person reads for each. */
export const LABELS = Object.freeze({ resend: "Resend", mailgun: "Mailgun", postmark: "Postmark", sendgrid: "SendGrid", smtp: "Your SMTP server" });
/** The most people one send may name. */
export const MAX_TO = 50;
const NEXT = "Open Settings, Connections and add the sending service key again.";
const EMAIL = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}$/;
const NAMED = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/;

/** @param {string} message @param {string} code */
const fail = (message, code) => Object.assign(new Error(message), { code });
/** @param {string} s */
const oneLine = s => !/[\r\n\u2028\u2029]/.test(s);
/** An address as text, with or without a display name: { name, email }. @param {unknown} v */
function parseAddress(v) {
  const s = String(v ?? "").trim();
  const m = NAMED.exec(s);
  const email = (m ? m[2] : s).trim();
  if (!oneLine(s) || !EMAIL.test(email)) return null;
  return { name: m && m[1] ? m[1].trim() : "", email };
}
/** @param {string} h */
const stripHtml = h => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, "\n").replace(/<[^>]*>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
/** @param {string} t */
const textToHtml = t => t.split(/\n{2,}/).map(p => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`).join("");

/**
 * The message, checked and filled in: a from inside the firm's own domain (the saved from address when none is given), every address real and on one line, a subject on one line, and a body in
 * both forms. A Flow cannot send as another domain through the firm's account.
 * @param {any} conn @param {any} m
 * @returns {{ from: string, to: string[], subject: string, html: string, text: string, replyTo?: string }}
 */
export function check(conn, m) {
  const saved = parseAddress(conn && conn.from);
  const domain = String(conn && conn.domain || (saved ? saved.email.split("@")[1] : "")).toLowerCase();
  const fromRaw = m.from === undefined || m.from === "" ? String(conn && conn.from || "") : String(m.from);
  const from = parseAddress(fromRaw);
  if (!from) throw fail("there is no from address: set one on the sending service in Settings, Connections", "bad_input");
  if (domain && from.email.split("@")[1].toLowerCase() !== domain) throw fail(`mail goes out from the firm's own domain, ${domain}; ${from.email} is not on it`, "bad_input");
  const list = (Array.isArray(m.to) ? m.to : String(m.to ?? "").split(/[,;]/)).map((/** @type {any} */ x) => String(x).trim()).filter(Boolean);
  if (!list.length) throw fail("say who to send to: to is an email address", "bad_input");
  if (list.length > MAX_TO) throw fail(`one send goes to at most ${MAX_TO} people`, "bad_input");
  const to = list.map((/** @type {string} */ x) => { const a = parseAddress(x); if (!a || a.name) throw fail(`${x.slice(0, 60)} is not an email address`, "bad_input"); return a.email; });
  const subject = String(m.subject ?? "");
  if (!oneLine(subject)) throw fail("the subject is one line", "bad_input");
  let html = typeof m.html === "string" ? m.html : "", text = typeof m.text === "string" ? m.text : "";
  if (!html.trim() && !text.trim()) throw fail("there is nothing to say: the message has no text", "bad_input");
  if (!text.trim()) text = stripHtml(html);
  if (!html.trim()) html = textToHtml(text);
  /** @type {string | undefined} */ let replyTo;
  if (m.replyTo !== undefined && m.replyTo !== "") { const r = parseAddress(m.replyTo); if (!r) throw fail(`${String(m.replyTo).slice(0, 60)} is not an email address`, "bad_input"); replyTo = r.name ? `${r.name} <${r.email}>` : r.email; }
  return { from: from.name ? `${from.name} <${from.email}>` : from.email, to, subject, html, text, ...(replyTo ? { replyTo } : {}) };
}

/**
 * The HTTP request a provider wants for this message. Pure: nothing is sent.
 * @param {any} conn { provider, apiKey, from, domain?, region? } @param {any} m the message (checked here) @param {{ idem?: string }} [o]
 * @returns {{ url: string, method: "POST", headers: Record<string, string>, body: string }}
 */
export function shape(conn, m, o = {}) {
  const p = String(conn && conn.provider);
  if (!PROVIDERS.includes(p) || p === "smtp") throw fail(`${p.slice(0, 40)} is not a sending service Vyre knows (it knows ${PROVIDERS.join(", ")})`, "bad_input");
  const k = String(conn.apiKey || "");
  const c = check(conn, m);
  const json = { "content-type": "application/json", accept: "application/json" };
  if (p === "resend") {
    return { url: "https://api.resend.com/emails", method: "POST", headers: { ...json, authorization: `Bearer ${k}`, ...(o.idem ? { "idempotency-key": o.idem } : {}) },
      body: JSON.stringify({ from: c.from, to: c.to, subject: c.subject, html: c.html, text: c.text, ...(c.replyTo ? { reply_to: c.replyTo } : {}) }) };
  }
  if (p === "mailgun") {
    const domain = String(conn.domain || (parseAddress(c.from) || { email: "@" }).email.split("@")[1]);
    const host = conn.region === "eu" ? "api.eu.mailgun.net" : "api.mailgun.net";
    const f = new URLSearchParams({ from: c.from, to: c.to.join(","), subject: c.subject, text: c.text, html: c.html });
    if (c.replyTo) f.set("h:Reply-To", c.replyTo);
    return { url: `https://${host}/v3/${encodeURIComponent(domain)}/messages`, method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`api:${k}`).toString("base64")}` }, body: f.toString() };
  }
  if (p === "postmark") {
    return { url: "https://api.postmarkapp.com/email", method: "POST", headers: { ...json, "x-postmark-server-token": k },
      body: JSON.stringify({ From: c.from, To: c.to.join(","), Subject: c.subject, HtmlBody: c.html, TextBody: c.text, ...(c.replyTo ? { ReplyTo: c.replyTo } : {}), MessageStream: String(conn.stream || "outbound") }) };
  }
  const from = /** @type {{ name: string, email: string }} */ (parseAddress(c.from)), reply = c.replyTo ? parseAddress(c.replyTo) : null;
  return { url: "https://api.sendgrid.com/v3/mail/send", method: "POST", headers: { ...json, authorization: `Bearer ${k}` },
    body: JSON.stringify({ personalizations: [{ to: c.to.map(email => ({ email })) }], from: { email: from.email, ...(from.name ? { name: from.name } : {}) }, subject: c.subject,
      content: [{ type: "text/plain", value: c.text }, { type: "text/html", value: c.html }], ...(reply ? { reply_to: { email: reply.email, ...(reply.name ? { name: reply.name } : {}) } } : {}) }) };
}

/** What a provider said, as one short line (its own words), with the key taken out. @param {any} body @param {string} secret */
function said(body, secret) {
  const b = body && typeof body === "object" ? body : {};
  const raw = typeof b.message === "string" ? b.message : typeof b.Message === "string" ? b.Message : Array.isArray(b.errors) && b.errors[0] && typeof b.errors[0].message === "string" ? b.errors[0].message
    : typeof b.error === "string" ? b.error : typeof body === "string" ? body : "";
  return scrub(raw, secret).replace(/\s+/g, " ").trim().slice(0, 160);
}
/** @param {string} s @param {string} secret */
const scrub = (s, secret) => (secret ? String(s).split(secret).join("\u2026") : String(s));

/**
 * Send one message through the firm's service. Returns { id, provider } (the service's own message id); a failure is an Error with a code (bad_input, auth, rate, refused, unavailable, network)
 * and words that say what to do next. The key is never in a message.
 * @param {any} conn @param {any} m @param {{ http?: typeof httpFetch, smtp?: { send: Function }, idem?: string }} [deps]
 * @returns {Promise<{ id: string, provider: string }>}
 */
export async function send(conn, m, deps = {}) {
  const p = String(conn && conn.provider), label = /** @type {any} */ (LABELS)[p] || p;
  const secret = String(conn && conn.apiKey || "");
  if (p === "smtp") {
    const c = check(conn, m);
    const host = String(conn.smtpHost || "");
    if (!host) throw fail("the SMTP server is not set: add it on the sending service in Settings, Connections", "bad_input");
    const tls = conn.security === "starttls" ? "starttls" : "implicit";
    const port = Number(conn.smtpPort) || undefined;
    const from = /** @type {{ email: string }} */ (parseAddress(c.from));
    const cfg = { address: from.email, username: String(conn.username || from.email), imap: { host, tls }, smtp: { host, ...(port ? { port } : {}), tls }, auth: { item: "sending", field: "password" } };
    const adapter = deps.smtp || imapAdapter();
    try {
      const r = await adapter.send(cfg, async () => secret, { to: c.to, subject: c.subject, body: c.text });
      return { id: String(r && (r.message_id || r.id) || ""), provider: p };
    } catch (e) { throw fail(`SMTP did not send: ${scrub(String(/** @type {Error} */ (e).message || e), secret).slice(0, 200)}`, /** @type {any} */ (e).code === "auth" ? "auth" : "refused"); }
  }
  const req = shape(conn, m, { idem: deps.idem });
  const http = deps.http || httpFetch;
  /** @type {Response} */ let r;
  try { r = await http(req.url, { method: req.method, headers: req.headers, body: req.body, timeoutMs: 20_000, maxBytes: 256 * 1024 }); }
  catch (e) { throw fail(`${label} could not be reached: ${scrub(String(/** @type {Error} */ (e).message || e), secret).slice(0, 160)}`, "network"); }
  const textBody = await r.text().catch(() => "");
  /** @type {any} */ let body = textBody;
  try { body = textBody ? JSON.parse(textBody) : {}; } catch { /* a plain-text answer */ }
  const status = r.status, id = (name) => r.headers.get(name) || "";
  const words = said(body, secret);
  if (status === 401 || status === 403) throw fail(`${label} refused the key. ${NEXT}`, "auth");
  if (status === 429) throw fail(`${label} says to slow down${words ? ` (${words})` : ""}. Nothing more was sent; try again in a few minutes.`, "rate");
  if (status >= 500) throw fail(`${label} is not answering (${status}). Nothing was sent; try again later.`, "unavailable");
  if (status < 200 || status >= 300 || (p === "postmark" && body && Number(body.ErrorCode) > 0)) throw fail(`${label} did not take the message${words ? `: ${words}` : ` (${status})`}`, "refused");
  const got = p === "resend" ? body.id : p === "mailgun" ? body.id : p === "postmark" ? body.MessageID : id("x-message-id");
  return { id: String(got || ""), provider: p };
}
