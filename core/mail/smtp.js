// @ts-check
// smtp: a small SMTP submission client (RFC 5321, 3207, 4954) and the message it sends (RFC 5322,
// 2045, 2047). TLS from the first byte ("tls", port 465) or STARTTLS ("starttls", port 587); a
// login never crosses the wire in the clear, so there is no plain mode. AUTH PLAIN or LOGIN,
// whichever the server offers. Nothing here logs, and no error carries the password or the lines
// that held it.

import crypto from "node:crypto";
import { connect, MailError } from "./wire.js";

export { MailError };

export const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const b64 = s => Buffer.from(s, "utf8").toString("base64");

/**
 * A reply: its code, and its lines without the code.
 * @param {import("./wire.js").Wire} w @returns {Promise<{ code: number, lines: string[] }>}
 */
async function reply(w) {
  const lines = [];
  for (;;) {
    const line = await w.readLine();
    const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!m) throw new MailError(`the SMTP server sent something that is not a reply: ${line.slice(0, 80)}`, "protocol");
    lines.push(m[3]);
    if (m[2] !== "-") return { code: Number(m[1]), lines };
    if (lines.length > 200) throw new MailError("the SMTP server sent a reply of over 200 lines", "protocol");
  }
}

/** Send a command (or nothing, for the greeting) and expect one of `ok`. `shown` replaces the command in errors. */
async function step(w, command, ok, shown = command) {
  if (command !== null) w.writeLine(command);
  const r = await reply(w);
  if (!ok.includes(r.code)) {
    throw new MailError(`the SMTP server refused ${shown ? shown.split(" ")[0] : "the connection"}: ${r.code} ${r.lines.join(" ").slice(0, 200)}`, "refused");
  }
  return r;
}

/**
 * Connect, say hello, start TLS if asked, and log in. Returns the open wire.
 * @param {{ host: string, port: number, security: "tls"|"starttls", username: string, password: string, ca?: string, timeout?: number }} o
 */
async function open(o) {
  if (o.security !== "tls" && o.security !== "starttls") throw new MailError("security must be tls or starttls", "bad_input");
  const w = await connect({ host: o.host, port: o.port, tls: o.security === "tls", ca: o.ca, timeout: o.timeout, what: "the SMTP server" });
  try {
    await step(w, null, [220]);
    let caps = (await step(w, "EHLO [127.0.0.1]", [250])).lines.slice(1);
    if (o.security === "starttls") {
      if (!caps.some(c => /^STARTTLS\b/i.test(c))) throw new MailError("the SMTP server does not offer STARTTLS, so the login would go in the clear; use security tls or another port", "tls");
      await step(w, "STARTTLS", [220]);
      await w.startTls({ host: o.host, ca: o.ca });
      caps = (await step(w, "EHLO [127.0.0.1]", [250])).lines.slice(1);
    }
    const auth = caps.map(c => /^AUTH[ =](.*)$/i.exec(c)).find(Boolean);
    const mechs = auth ? auth[1].toUpperCase().split(/\s+/) : [];
    const refused = r => new MailError(`the SMTP server refused the login for ${o.username}: ${r}`, "auth");
    const expect = async (line, ok) => {
      w.writeLine(line);
      const r = await reply(w);
      if (!ok.includes(r.code)) throw refused(`${r.code} ${r.lines.join(" ").slice(0, 200)}`);
      return r;
    };
    if (mechs.includes("PLAIN")) {
      await expect(`AUTH PLAIN ${b64(`\0${o.username}\0${o.password}`)}`, [235]);
    } else if (mechs.includes("LOGIN")) {
      await expect("AUTH LOGIN", [334]);
      await expect(b64(o.username), [334]);
      await expect(b64(o.password), [235]);
    } else {
      throw new MailError(`the SMTP server offers no login Vyre speaks (it offers ${mechs.join(", ") || "none"}; Vyre speaks PLAIN and LOGIN)`, "auth");
    }
    return w;
  } catch (e) { w.close(); throw e; }
}

/** QUIT, and close whatever the answer. */
async function quit(w) {
  try { w.writeLine("QUIT"); await reply(w); } catch {} finally { w.close(); }
}

/** Log in and out: does this account's SMTP side work? */
export async function probe(o) {
  const w = await open(o);
  await quit(w);
  return { ok: true };
}

/**
 * Send one message. `raw` is the whole RFC 5322 message with CRLF line ends.
 * @param {Parameters<typeof open>[0]} o @param {{ from: string, to: string[], raw: string }} m
 */
export async function send(o, { from, to, raw }) {
  if (!EMAIL.test(from)) throw new MailError("the From address is not an email address", "bad_input");
  if (!to.length) throw new MailError("a message needs at least one recipient", "bad_input");
  for (const a of to) if (!EMAIL.test(a)) throw new MailError(`${a} is not an email address`, "bad_input");
  const w = await open(o);
  try {
    await step(w, `MAIL FROM:<${from}>`, [250]);
    for (const a of to) await step(w, `RCPT TO:<${a}>`, [250, 251], `RCPT TO:<${a}>`);
    await step(w, "DATA", [354]);
    w.write(dotStuff(raw) + ".\r\n");
    const done = await step(w, null, [250], "the message");
    return { accepted: to, response: `${done.code} ${done.lines.join(" ")}`.slice(0, 200) };
  } finally { await quit(w); }
}

/** CRLF line ends, a final CRLF, and a leading dot doubled on every line (RFC 5321 4.5.2). @param {string} raw */
export function dotStuff(raw) {
  let s = String(raw).replace(/\r?\n/g, "\r\n");
  if (!s.endsWith("\r\n")) s += "\r\n";
  return s.replace(/(^|\r\n)\./g, "$1..");
}

// ---- the message ----

/** Refuse a header value that could start another header. @param {string} name @param {unknown} v */
function headerValue(name, v) {
  const s = String(v ?? "");
  if (/[\r\n]/.test(s)) throw new MailError(`the ${name} has a line break in it, which could add headers; refused`, "bad_input");
  return s;
}

/** RFC 2047 encoded words for a non-ASCII header value, folded so no line passes 76 characters. @param {string} s */
export function encodeWord(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = "";
  for (const ch of s) {
    // 45 bytes of UTF-8 is 60 base64 characters, and "=?UTF-8?B?" + "?=" makes 72.
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map(w => `=?UTF-8?B?${b64(w)}?=`).join("\r\n ");
}

/** Quoted-printable (RFC 2045 6.7), with CRLF line ends and soft breaks at 76. @param {string} text */
export function quotedPrintable(text) {
  const out = [];
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    const bytes = Buffer.from(line, "utf8");
    let enc = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      enc += plain ? String.fromCharCode(b) : "=" + b.toString(16).toUpperCase().padStart(2, "0");
    }
    // Soft breaks, never inside an =XX.
    while (enc.length > 76) {
      let cut = 75;
      if (enc[cut - 1] === "=") cut -= 1;
      else if (enc[cut - 2] === "=") cut -= 2;
      out.push(enc.slice(0, cut) + "=");
      enc = enc.slice(cut);
    }
    out.push(enc);
  }
  return out.join("\r\n");
}

/** RFC 5322 date: "Sun, 27 Sep 2026 10:00:00 +0000". @param {Date} d */
export const mailDate = d => d.toUTCString().replace(/GMT$/, "+0000");

/**
 * The whole message, headers checked. `to` and `cc` are address lists; `references` a string of
 * Message-IDs. Returns { raw, message_id }.
 * @param {{ from: string, to: string[], cc?: string[], subject: string, body: string, in_reply_to?: string, references?: string, date?: Date, message_id?: string }} m
 */
export function buildMessage(m) {
  const from = headerValue("From", m.from);
  if (!EMAIL.test(from)) throw new MailError("the From address is not an email address", "bad_input");
  const list = (name, v) => (v || []).map(a => {
    const s = headerValue(name, a).trim();
    if (!EMAIL.test(s)) throw new MailError(`${s} in ${name} is not an email address`, "bad_input");
    return s;
  });
  const to = list("To", m.to), cc = list("Cc", m.cc);
  if (!to.length) throw new MailError("a message needs at least one recipient in To", "bad_input");
  const subject = headerValue("Subject", m.subject);
  const id = headerValue("Message-ID", m.message_id || `<${crypto.randomBytes(12).toString("hex")}@${from.split("@")[1]}>`);
  const msgid = v => {
    const s = headerValue("In-Reply-To", v).trim();
    if (!/^(<[^<>\s]+>\s*)+$/.test(s)) throw new MailError("In-Reply-To and References take Message-IDs such as <abc@harlow.example>", "bad_input");
    return s.replace(/\s+/g, " ");
  };
  const h = [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    ...(cc.length ? [`Cc: ${cc.join(", ")}`] : []),
    `Subject: ${encodeWord(subject)}`,
    `Date: ${mailDate(m.date || new Date())}`,
    `Message-ID: ${id}`,
  ];
  if (m.in_reply_to) {
    const irt = msgid(m.in_reply_to);
    const refs = m.references ? msgid(m.references) : "";
    h.push(`In-Reply-To: ${irt}`, `References: ${refs.includes(irt) ? refs : [refs, irt].filter(Boolean).join(" ")}`);
  }
  h.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable");
  return { raw: h.join("\r\n") + "\r\n\r\n" + quotedPrintable(String(m.body ?? "")) + "\r\n", message_id: id };
}
