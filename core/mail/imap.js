// @ts-check
// imap: a small IMAP4rev1 client (RFC 3501), read-only. It logs in (LOGIN, or AUTHENTICATE PLAIN
// when the server offers it), opens a mailbox with EXAMINE so nothing is marked read, searches by
// UID, fetches envelopes and flags, and fetches one whole message with BODY.PEEK[]. Literals
// ({n} then n bytes) are read and written as the protocol says. No command logs, and no error
// carries the password or the line that held it.

import { connect, MailError } from "./wire.js";

export { MailError };

// ---- reading responses ----

/**
 * One response: its text lines and, between them, the literals each line announced.
 * @param {import("./wire.js").Wire} w @returns {Promise<{ text: string, parts: (string|Buffer)[] }>}
 */
export async function readResponse(w) {
  const parts = [];
  let text = "";
  for (;;) {
    const line = await w.readLine();
    parts.push(line);
    text += line;
    const m = /\{(\d{1,10})\+?\}$/.exec(line);
    if (!m) return { text, parts };
    const n = Number(m[1]);
    if (n > 50 << 20) throw new MailError("the IMAP server sent a literal over 50 MB", "protocol");
    parts.push(await w.readBytes(n));
    text += " <literal> ";
  }
}

/** @typedef {string|Buffer|null|Value[]} Value */

/**
 * Parse a response's parts into values: atoms and quoted strings as strings, literals as Buffers,
 * NIL as null, parenthesised lists as arrays. A bracketed section (BODY[HEADER.FIELDS (X)]) stays
 * inside its atom.
 * @param {(string|Buffer)[]} parts @returns {Value[]}
 */
export function parse(parts) {
  let pi = 0, pos = 0;
  const cur = () => /** @type {string} */ (parts[pi]);
  const top = [];
  const stack = [top];
  const push = v => stack[stack.length - 1].push(v);
  while (pi < parts.length) {
    const s = cur();
    if (pos >= s.length) { pi += 2; pos = 0; continue; }
    const c = s[pos];
    if (c === " ") { pos++; continue; }
    if (c === "(") { const l = []; push(l); stack.push(l); pos++; continue; }
    if (c === ")") { if (stack.length > 1) stack.pop(); pos++; continue; }
    if (c === "\"") {
      let out = "";
      pos++;
      while (pos < s.length && s[pos] !== "\"") {
        if (s[pos] === "\\" && pos + 1 < s.length) pos++;
        out += s[pos++];
      }
      pos++;
      push(out);
      continue;
    }
    if (c === "{") {
      const m = /^\{(\d+)\+?\}$/.exec(s.slice(pos));
      if (m && Buffer.isBuffer(parts[pi + 1])) { push(parts[pi + 1]); pi += 2; pos = 0; continue; }
    }
    let atom = "";
    let depth = 0;
    while (pos < s.length) {
      const ch = s[pos];
      if (ch === "[") depth++;
      else if (ch === "]") depth = Math.max(0, depth - 1);
      else if (!depth && (ch === " " || ch === "(" || ch === ")")) break;
      atom += ch;
      pos++;
    }
    push(atom.toUpperCase() === "NIL" ? null : atom);
  }
  return top;
}

const str = v => (v == null ? "" : Buffer.isBuffer(v) ? v.toString("utf8") : Array.isArray(v) ? "" : String(v));

// ---- writing commands ----

/** A string as an IMAP quoted string, or a literal when it cannot be one. @param {string} s */
export function astring(s) {
  s = String(s);
  if (/^[\x20-\x7e]*$/.test(s) && !/["\\]/.test(s) && s.length < 1000) return `"${s}"`;
  return { literal: Buffer.from(s, "utf8") };
}

// ---- the search mapping ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A query in words to UID SEARCH criteria: `from:dana`, `subject:"engagement letter"`,
 * `since:2026-09-01`, `unseen`, and any other word as TEXT. Nothing is ALL. Returns the criteria
 * as command pieces (strings and literals) and whether it needs CHARSET UTF-8.
 * @param {string} [q] @returns {{ criteria: (string|{literal: Buffer})[], utf8: boolean }}
 */
export function searchCriteria(q) {
  const out = [];
  let utf8 = false;
  const value = v => {
    if (!/^[\x00-\x7f]*$/.test(v)) utf8 = true;
    return astring(v);
  };
  const re = /(\w+):(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
  for (const m of String(q || "").matchAll(re)) {
    const key = m[1] ? m[1].toLowerCase() : null;
    const v = key ? (m[2] ?? m[3] ?? "") : (m[4] ?? m[5] ?? "");
    if (key === "from" || key === "to" || key === "subject") { out.push(key.toUpperCase(), value(v)); continue; }
    if (key === "since" || key === "before") {
      const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      if (!d || Number(d[2]) < 1 || Number(d[2]) > 12) throw new MailError(`${key}: takes a date such as 2026-09-01`, "bad_input");
      out.push(key.toUpperCase(), `${Number(d[3])}-${MONTHS[Number(d[2]) - 1]}-${d[1]}`);
      continue;
    }
    if (!key && /^(unseen|unread)$/i.test(v) && !m[4]) { out.push("UNSEEN"); continue; }
    if (!key && /^seen$/i.test(v) && !m[4]) { out.push("SEEN"); continue; }
    if (!v) continue;
    // An unknown key:value is words too.
    out.push("TEXT", value(key ? `${m[1]}:${v}` : v));
  }
  return { criteria: out.length ? out : ["ALL"], utf8 };
}

// ---- the client ----

export class Imap {
  /** @param {import("./wire.js").Wire} w */
  constructor(w) { this.w = w; this.n = 0; /** @type {string[]} */ this.caps = []; }

  /**
   * Connect and log in.
   * @param {{ host: string, port: number, security: "tls"|"starttls", username: string, password: string, ca?: string, timeout?: number }} o
   */
  static async open(o) {
    if (o.security !== "tls" && o.security !== "starttls") throw new MailError("security must be tls or starttls", "bad_input");
    const w = await connect({ host: o.host, port: o.port, tls: o.security === "tls", ca: o.ca, timeout: o.timeout, what: "the IMAP server" });
    const c = new Imap(w);
    try {
      const hello = await readResponse(w);
      if (!/^\* (OK|PREAUTH)\b/i.test(hello.text)) throw new MailError(`the IMAP server did not greet: ${hello.text.slice(0, 120)}`, "protocol");
      await c.capability(hello.text);
      if (o.security === "starttls") {
        if (!c.caps.includes("STARTTLS")) throw new MailError("the IMAP server does not offer STARTTLS, so the login would go in the clear; use security tls or another port", "tls");
        await c.command(["STARTTLS"]);
        await w.startTls({ host: o.host, ca: o.ca });
        c.caps = [];
        await c.capability("");
      }
      await c.login(o.username, o.password);
      return c;
    } catch (e) { w.close(); throw e; }
  }

  /** Capabilities from a greeting's [CAPABILITY ...], or asked for. @param {string} text */
  async capability(text) {
    const m = /\[CAPABILITY ([^\]]*)\]/i.exec(text);
    if (m) { this.caps = m[1].toUpperCase().split(/\s+/); return; }
    const r = await this.command(["CAPABILITY"]);
    const line = r.untagged.find(u => /^\* CAPABILITY /i.test(u.text));
    this.caps = line ? line.text.replace(/^\* CAPABILITY /i, "").toUpperCase().split(/\s+/) : [];
  }

  /** @param {string} username @param {string} password */
  async login(username, password) {
    const refused = t => new MailError(`the IMAP server refused the login for ${username}: ${t}`, "auth");
    try {
      if (this.caps.includes("AUTH=PLAIN")) {
        await this.command(["AUTHENTICATE PLAIN"], { continuation: Buffer.from(`\0${username}\0${password}`, "utf8").toString("base64"), secret: true });
      } else {
        if (this.caps.includes("LOGINDISABLED")) throw new MailError("the IMAP server allows no LOGIN here and offers no AUTHENTICATE PLAIN", "auth");
        await this.command(["LOGIN", astring(username), astring(password)], { secret: true });
      }
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err.code === "refused") throw refused(err.said);
      throw e;
    }
    // Capabilities often change once logged in.
    this.caps = [];
  }

  /**
   * Run a command: pieces are joined by spaces; a { literal } piece is sent as {n} and its bytes
   * once the server says go ahead. `continuation` answers one "+" with a line (AUTHENTICATE).
   * `secret`: the command held a login, so a refusal says only the server's words.
   * @param {(string|{literal: Buffer})[]} pieces
   * @param {{ continuation?: string, secret?: boolean }} [opts]
   */
  async command(pieces, { continuation, secret = false } = {}) {
    const tag = `V${++this.n}`;
    const w = this.w;
    /** @type {{ text: string, parts: (string|Buffer)[] }[]} */
    const untagged = [];
    const until = async () => {
      for (;;) {
        const r = await readResponse(w);
        if (r.text.startsWith("+")) return r;
        if (r.text.startsWith(tag + " ")) return r;
        untagged.push(r);
      }
    };
    let line = tag;
    for (const p of pieces) {
      if (typeof p === "string") { line += " " + p; continue; }
      w.writeLine(`${line} {${p.literal.length}}`);
      const go = await until();
      if (!go.text.startsWith("+")) throw this.failed(go.text, tag, pieces, secret);
      w.write(p.literal);
      line = "";
    }
    w.writeLine(line);
    let done = await until();
    if (done.text.startsWith("+")) {
      if (continuation === undefined) { w.writeLine("*"); done = await until(); }
      else { w.writeLine(continuation); done = await until(); }
      if (done.text.startsWith("+")) { w.writeLine("*"); done = await until(); }
    }
    const status = /^\S+ (OK|NO|BAD)\b ?(.*)$/i.exec(done.text);
    if (!status || status[1].toUpperCase() !== "OK") throw this.failed(done.text, tag, pieces, secret);
    return { untagged, text: status[2] };
  }

  failed(text, tag, pieces, secret) {
    const said = text.slice(tag.length + 1).replace(/^(NO|BAD)\s*/i, "").slice(0, 200);
    const what = typeof pieces[0] === "string" ? pieces[0].split(" ")[0] : "a command";
    return Object.assign(new MailError(secret ? said : `the IMAP server refused ${what}: ${said}`, "refused"), { said });
  }

  /** Open a mailbox read-only. Returns its UIDVALIDITY and message count. @param {string} mailbox */
  async examine(mailbox = "INBOX") {
    const r = await this.command(["EXAMINE", astring(mailbox)]);
    let exists = 0, uidvalidity = "";
    for (const u of r.untagged) {
      const e = /^\* (\d+) EXISTS/i.exec(u.text);
      if (e) exists = Number(e[1]);
      const v = /\[UIDVALIDITY (\d+)\]/i.exec(u.text);
      if (v) uidvalidity = v[1];
    }
    return { exists, uidvalidity };
  }

  /** UIDs matching a query, as numbers. @param {string} [q] */
  async search(q) {
    const { criteria, utf8 } = searchCriteria(q);
    const r = await this.command(["UID SEARCH", ...(utf8 ? ["CHARSET UTF-8"] : []), ...criteria]);
    const uids = [];
    for (const u of r.untagged) {
      if (!/^\* SEARCH\b/i.test(u.text)) continue;
      for (const n of u.text.replace(/^\* SEARCH/i, "").trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(Number(n));
    }
    return uids;
  }

  /**
   * FETCH responses for a UID set, each as a map of item name to value.
   * @param {number[]} uids @param {string} items
   */
  async fetch(uids, items) {
    if (!uids.length) return [];
    const r = await this.command([`UID FETCH ${uids.join(",")} ${items}`]);
    const out = [];
    for (const u of r.untagged) {
      const v = parse(u.parts);
      if (v[0] !== "*" || String(v[2]).toUpperCase() !== "FETCH" || !Array.isArray(v[3])) continue;
      const list = v[3];
      /** @type {Record<string, Value>} */
      const m = {};
      for (let i = 0; i + 1 < list.length; i += 2) m[String(list[i]).toUpperCase()] = list[i + 1];
      out.push(m);
    }
    return out;
  }

  /** Envelopes and flags, newest UID first. @param {number[]} uids */
  async envelopes(uids) {
    const rows = await this.fetch(uids, "(UID FLAGS ENVELOPE)");
    return rows.map(r => ({ uid: Number(str(r.UID)), flags: Array.isArray(r.FLAGS) ? r.FLAGS.map(str) : [], envelope: envelope(r.ENVELOPE) }))
      .sort((a, b) => b.uid - a.uid);
  }

  /** One whole message, without marking it read. @param {number} uid @returns {Promise<Buffer|null>} */
  async body(uid) {
    const rows = await this.fetch([uid], "(UID BODY.PEEK[])");
    const row = rows.find(r => Number(str(r.UID)) === uid) || rows[0];
    if (!row) return null;
    const key = Object.keys(row).find(k => k.startsWith("BODY["));
    const v = key ? row[key] : null;
    return v == null ? null : Buffer.isBuffer(v) ? v : Buffer.from(str(v), "utf8");
  }

  async logout() {
    try { await this.command(["LOGOUT"]); } catch {} finally { this.w.close(); }
  }
}

// ---- envelopes ----

/** An ENVELOPE list to plain fields. @param {Value} e */
export function envelope(e) {
  const l = Array.isArray(e) ? e : [];
  const addrs = v => (Array.isArray(v) ? v : []).filter(Array.isArray).map(a => {
    const name = decodeWords(str(a[0]));
    const email = a[2] != null && a[3] != null ? `${str(a[2])}@${str(a[3])}` : "";
    return name && email ? `${name} <${email}>` : email || name;
  }).filter(Boolean);
  return {
    date: str(l[0]), subject: decodeWords(str(l[1])), from: addrs(l[2]), to: addrs(l[5]), cc: addrs(l[6]),
    in_reply_to: str(l[8]), message_id: str(l[9]),
  };
}

/** Decode RFC 2047 encoded words ("=?UTF-8?B?...?="). @param {string} s */
export function decodeWords(s) {
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (_, cs, enc, text) => {
    const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64")
      : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return decodeCharset(bytes, cs);
  });
}

/** @param {Buffer} bytes @param {string} [charset] */
export function decodeCharset(bytes, charset = "utf-8") {
  try { return new TextDecoder(String(charset).toLowerCase().replace(/^us-ascii$/, "utf-8")).decode(bytes); } catch { return bytes.toString("utf8"); }
}
