// @ts-check
// message: the pure parts of an email that every mail path shares (ADR 0016 decisions 6 and 8).
//
// Google, IMAP and SMTP, and Apps Script all build, check and read plain-text messages the same
// way, and for the same reasons: no CR or LF in any header (a newline in a subject is how one
// email becomes two), non-ASCII headers as RFC 2047 words, addresses checked one by one. No
// state, no I/O: a module imports this file the way it imports auth.js.

export const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const bad = msg => Object.assign(new Error(msg), { code: "bad_input" });
export const noBreak = (v, what) => { if (/[\r\n]/.test(String(v))) throw bad(`${what} cannot contain a line break`); };

/** A list of addresses from a string, a comma list or an array; each one checked. */
export function addresses(v, what) {
  if (v === undefined || v === null || v === "") return [];
  const arr = (Array.isArray(v) ? v : String(v).split(",")).map(a => String(a).trim()).filter(Boolean);
  for (const a of arr) if (!EMAIL.test(a)) throw bad(`${what} must be email addresses; "${a.slice(0, 80)}" is not one`);
  return arr;
}

/** Plain ASCII as is, anything else as an RFC 2047 encoded word. */
export const header = v => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

/**
 * Check a message's content, the same way before it is held and when it is released: the person
 * may have edited it in between.
 * @param {string[]} to @param {any} c
 */
export function checkContent(to, c) {
  if (!to.length) throw bad("an email needs at least one address in to");
  addresses(to, "to"); addresses(c.cc, "cc"); addresses(c.bcc, "bcc");
  if (typeof c.subject !== "string") throw bad("an email needs a subject");
  if (typeof c.body !== "string") throw bad("an email needs a body");
  noBreak(c.subject, "subject");
  if (c.in_reply_to !== undefined && c.in_reply_to !== "") {
    if (!/^<[^<>\s]+>$/.test(String(c.in_reply_to))) throw bad("in_reply_to must be a Message-ID such as <abc@mail.example.com>");
  }
}

/**
 * An RFC 822 message as text: a few headers and a base64 text body, lines ending in CRLF.
 * `date` and `message_id` are for SMTP, where the sender adds them; Gmail adds its own.
 * @param {{ from?: string, to: string[], cc?: string[], bcc?: string[], subject: string, body: string,
 *   in_reply_to?: string, references?: string, date?: Date, message_id?: string }} m
 */
export function rfc822Text(m) {
  const lines = [];
  if (m.from) { noBreak(m.from, "from"); lines.push(`From: ${m.from}`); }
  lines.push(`To: ${m.to.join(", ")}`);
  if (m.cc && m.cc.length) lines.push(`Cc: ${m.cc.join(", ")}`);
  if (m.bcc && m.bcc.length) lines.push(`Bcc: ${m.bcc.join(", ")}`);
  noBreak(m.subject, "subject");
  lines.push(`Subject: ${header(m.subject)}`);
  if (m.date) lines.push(`Date: ${m.date.toUTCString().replace("GMT", "+0000")}`);
  if (m.message_id) { noBreak(m.message_id, "message_id"); lines.push(`Message-ID: ${m.message_id}`); }
  if (m.in_reply_to) {
    noBreak(m.in_reply_to, "in_reply_to");
    const refs = m.references && !/[\r\n]/.test(m.references) ? `${m.references} ${m.in_reply_to}` : m.in_reply_to;
    lines.push(`In-Reply-To: ${m.in_reply_to}`, `References: ${refs}`);
  }
  lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "");
  const b64 = Buffer.from(m.body, "utf8").toString("base64");
  lines.push(...(b64.match(/.{1,76}/g) || [""]));
  return lines.join("\r\n");
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

/** The address inside "Dana Reyes <dana@northwind-bakery.example>". */
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

/**
 * The one query language of mail.search (ADR 0016 decision 8): plain words, `from:`, `to:`,
 * `subject:`, `newer_than:<n>d` and `is:unread`, with "double quotes" for a phrase. Gmail reads
 * the text as is; this parse is for backends that need the parts, such as IMAP SEARCH.
 * @param {string} q
 * @returns {{ words: string[], from: string[], to: string[], subject: string[], days?: number, unread: boolean }}
 */
export function parseQuery(q) {
  /** @type {{ words: string[], from: string[], to: string[], subject: string[], days?: number, unread: boolean }} */
  const out = { words: [], from: [], to: [], subject: [], unread: false };
  const re = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  for (const m of String(q || "").matchAll(re)) {
    if (m[1]) {
      const key = m[1].toLowerCase(), val = (m[2] ?? m[3] ?? "").trim();
      if (!val) continue;
      if (key === "from" || key === "to" || key === "subject") out[key].push(val);
      else if (key === "newer_than" && /^\d{1,4}d$/i.test(val)) out.days = Number(val.slice(0, -1));
      else if (key === "is" && val.toLowerCase() === "unread") out.unread = true;
      else out.words.push(`${m[1]}:${val}`);
    } else {
      const w = (m[4] ?? m[5] ?? "").trim();
      if (w) out.words.push(w);
    }
  }
  return out;
}
