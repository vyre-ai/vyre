// @ts-check
// imap: the `imap` mail adapter (ADR 0016 decision 8). IMAP for search and read, SMTP for send,
// small clients on node:net and node:tls, no dependencies.
//
// Rules, and why:
// - TLS always, implicit or STARTTLS. Plain TCP is allowed only to a loopback host, which exists
//   for the test fakes; a password never crosses a network in the clear.
// - Reads never change the mailbox. INBOX is opened with EXAMINE (read-only) and every fetch is
//   BODY.PEEK, so searching and reading never set \Seen: the person's unread mail stays unread.
// - `test` proves the account works without sending: IMAP LOGIN and EXAMINE, SMTP AUTH and QUIT.
//   It never issues MAIL FROM, so a test cannot become a message.
// - A send carries Bcc only in RCPT TO. The transmitted headers are built without it, so no
//   recipient learns who else was copied.
// - One connection per call, always closed: LOGOUT or QUIT when the talk ended cleanly, then the
//   socket is destroyed. Every wait has a timeout and every response a size cap, so a slow or
//   hostile server cannot hang a call or fill memory.
// - The password is fetched per call through `password()` and never kept. Every error is
//   scrubbed of it (and of the base64 forms AUTH sends) before it leaves this file, because a
//   server can echo what it was sent. Errors carry `code`: auth, network, timeout, tls, smtp,
//   imap, stale, not_found, bad_input.
// - Message ids are `INBOX.<uidvalidity>.<uid>`. A UID means nothing once UIDVALIDITY changes, so
//   a read of an old id answers `stale` instead of showing a different message.

import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { scrub } from "../../lib/connectors/auth.js";
import { addresses, checkContent, htmlToText, rfc822Text, EMAIL } from "../../lib/connectors/message.js";

const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 6 * 1024 * 1024;
const MAX_BUFFER = MAX_RESPONSE + 64 * 1024;
const BODY_CAP = 20_000;
const SNIPPET_BYTES = 2000;
const SNIPPET_CHARS = 200;
const MAX_LIMIT = 100;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/;
const TLS_MODES = ["implicit", "starttls", "none"];
const HEADER_FIELDS = "FROM TO CC SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CRLF = Buffer.from("\r\n");

/** @param {string} code @param {string} message */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * @typedef {{ host: string, port?: number, tls?: "implicit" | "starttls" | "none" }} Endpoint
 * @typedef {{ address: string, username?: string, imap: Endpoint, smtp: Endpoint, auth: { item: string, field?: string } }} ImapConfig
 * @typedef {{ host: string, port: number, tls: "implicit" | "starttls" | "none" }} Resolved
 * @typedef {{ write: (d: string | Buffer) => any, on: Function, removeListener: Function, destroy: () => any, setNoDelay?: Function }} SocketLike
 * @typedef {{ connect?: (o: { host: string, port: number, tls: boolean, servername: string }) => SocketLike,
 *   upgrade?: (socket: SocketLike, servername: string) => SocketLike, timeout?: number, now?: () => number }} ImapDeps
 */

// ---------------------------------------------------------------- config

/** @param {"imap" | "smtp"} kind @param {any} e @returns {Resolved} */
function resolveEndpoint(kind, e) {
  const port = e.port;
  let mode = e.tls;
  if (!mode) {
    if (kind === "imap") mode = port === 143 ? "starttls" : "implicit";
    else mode = port === 587 || port === 25 ? "starttls" : "implicit";
  }
  const defPort = kind === "imap" ? (mode === "implicit" ? 993 : 143) : (mode === "implicit" ? 465 : 587);
  return { host: String(e.host).replace(/\.$/, ""), port: port ?? defPort, tls: mode };
}

/** @param {"imap" | "smtp"} kind @param {any} e */
function endpointProblem(kind, e) {
  if (!e || typeof e !== "object") return `${kind} needs a host`;
  if (typeof e.host !== "string" || !e.host) return `${kind}.host is required`;
  if (e.host !== "::1" && !HOSTNAME.test(e.host)) return `${kind}.host must be a host name such as mail.example.com, with no scheme, port or path`;
  if (e.port !== undefined && !(Number.isInteger(e.port) && e.port > 0 && e.port < 65536)) return `${kind}.port must be a port number`;
  if (e.tls !== undefined && !TLS_MODES.includes(e.tls)) return `${kind}.tls must be "implicit" or "starttls"`;
  const r = resolveEndpoint(kind, e);
  if (r.tls === "none" && !LOOPBACK.has(r.host.toLowerCase())) return `${kind} needs TLS ("implicit" or "starttls"); plain TCP is only for a loopback host`;
  return null;
}

/** The config with every default filled in. @param {ImapConfig} cfg */
function resolve(cfg) {
  return {
    address: cfg.address, username: cfg.username || cfg.address,
    imap: resolveEndpoint("imap", cfg.imap), smtp: resolveEndpoint("smtp", cfg.smtp),
  };
}

// ---------------------------------------------------------------- the wire

/** Why a socket failed, as one of our codes. */
function classify(e, secure) {
  const c = String(e?.code || "");
  if (e?.code && ["auth", "network", "timeout", "tls", "smtp", "imap", "stale", "not_found", "bad_input"].includes(c)) return e;
  const tlsish = /^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|ERR_OSSL|HOSTNAME_MISMATCH)/.test(c) || e?.library === "SSL routines" || (secure && /EPROTO/.test(c));
  if (tlsish) return fail("tls", `TLS failed: ${e.message}`);
  return fail("network", `connection failed: ${e?.message || c || "closed"}`);
}

/** Bytes in, lines and counted bytes out, with one waiter at a time and a timeout on each wait. */
class Wire {
  /** @param {SocketLike} socket @param {number} timeout @param {boolean} secure */
  constructor(socket, timeout, secure) {
    this.timeout = timeout;
    this.buf = Buffer.alloc(0);
    /** @type {null | { n: number, resolve: (b: Buffer) => void, reject: (e: Error) => void, timer: any }} */
    this.waiter = null;
    /** @type {Error | null} */
    this.err = null;
    this.handlers = {
      data: d => {
        this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : Buffer.from(d);
        if (this.buf.length > MAX_BUFFER) return this.die(fail("imap", "the server sent more than this client accepts in one response"));
        this.pump();
      },
      error: e => this.die(classify(e, this.secure)),
      close: () => this.die(fail("network", "the server closed the connection")),
    };
    this.attach(socket, secure);
  }

  /** @param {SocketLike} socket @param {boolean} secure */
  attach(socket, secure) {
    this.socket = socket; this.secure = secure;
    for (const [k, f] of Object.entries(this.handlers)) socket.on(k, f);
  }

  detach() {
    for (const [k, f] of Object.entries(this.handlers)) this.socket.removeListener(k, f);
  }

  /** @param {Error} e */
  die(e) {
    if (!this.err) this.err = e;
    const w = this.waiter;
    if (w) { this.waiter = null; clearTimeout(w.timer); w.reject(this.err); }
  }

  pump() {
    const w = this.waiter;
    if (!w) return;
    let out = null;
    if (w.n < 0) {
      const i = this.buf.indexOf(10);
      if (i >= 0) {
        out = this.buf.subarray(0, i > 0 && this.buf[i - 1] === 13 ? i - 1 : i);
        this.buf = this.buf.subarray(i + 1);
      }
    } else if (this.buf.length >= w.n) {
      out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
    }
    if (out) { this.waiter = null; clearTimeout(w.timer); w.resolve(Buffer.from(out)); }
  }

  /** @param {number} n -1 for a line @returns {Promise<Buffer>} */
  wait(n) {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.die(fail("timeout", `the server did not answer within ${Math.round(this.timeout / 1000)}s`));
        this.close();
      }, this.timeout);
      this.waiter = { n, resolve, reject, timer };
      this.pump();
    });
  }

  line() { return this.wait(-1); }
  /** @param {number} n */
  bytes(n) { return this.wait(n); }

  /** @param {string | Buffer} d */
  write(d) {
    if (this.err) throw this.err;
    this.socket.write(d);
  }

  /** Swap the plain socket for a TLS one (STARTTLS). Nothing may be buffered at that point. */
  upgrade(upgradeFn, servername) {
    if (this.buf.length) throw fail("tls", "the server sent data before the TLS handshake");
    this.detach();
    this.attach(upgradeFn(this.socket, servername), true);
  }

  close() {
    if (!this.err) this.err = fail("network", "connection closed");
    try { this.socket.destroy(); } catch { /* already gone */ }
  }
}

/** @param {Resolved} ep @param {ImapDeps} deps */
function open(ep, deps) {
  const connect = deps.connect || (o => o.tls
    ? tls.connect({ host: o.host, port: o.port, servername: o.servername || undefined })
    : net.connect({ host: o.host, port: o.port }));
  const servername = net.isIP(ep.host) ? "" : ep.host;
  let socket;
  try { socket = connect({ host: ep.host, port: ep.port, tls: ep.tls === "implicit", servername }); }
  catch (e) { throw classify(e, ep.tls === "implicit"); }
  return new Wire(socket, deps.timeout ?? TIMEOUT_MS, ep.tls === "implicit");
}

const defaultUpgrade = (socket, servername) => tls.connect({ socket: /** @type {any} */ (socket), servername: servername || undefined });

/** Every form of the secret a server could echo back. */
function secretsOf(user, pass) {
  return [pass, Buffer.from(`\0${user}\0${pass}`).toString("base64"), Buffer.from(pass).toString("base64")];
}

/** The same error, scrubbed of every secret. @param {any} e @param {string[]} secrets */
function clean(e, secrets) {
  const code = e && typeof e.code === "string" && /^[a-z_]+$/.test(e.code) ? e.code : "network";
  const msg = scrub(e && e.message ? e.message : String(e), secrets);
  return fail(code, msg);
}

// ---------------------------------------------------------------- IMAP

/** An IMAP string: quoted when it can be, a literal otherwise. @returns {string | { lit: Buffer }} */
function astring(s) {
  const v = String(s);
  if (/^[\x01-\x09\x0b\x0c\x0e-\x7f]*$/.test(v) && v.length < 1000) return `"${v.replace(/[\\"]/g, m => "\\" + m)}"`;
  return { lit: Buffer.from(v, "utf8") };
}

/**
 * One value of an IMAP response: a list, a quoted string, a literal (Buffer), NIL or an atom.
 * Atoms keep bracketed sections whole: BODY[HEADER.FIELDS (FROM TO)]<0>.
 * @param {Buffer} b @param {number} i @returns {[any, number]}
 */
function parseValue(b, i) {
  while (b[i] === 32) i++;
  const c = b[i];
  if (c === 40) { // (
    const out = [];
    i++;
    for (;;) {
      while (b[i] === 32) i++;
      if (i >= b.length) throw fail("imap", "the server sent an unfinished list");
      if (b[i] === 41) return [out, i + 1];
      const [v, j] = parseValue(b, i);
      out.push(v); i = j;
    }
  }
  if (c === 34) { // "
    const bytes = [];
    i++;
    while (i < b.length && b[i] !== 34) {
      if (b[i] === 92) i++;
      bytes.push(b[i]); i++;
    }
    return [Buffer.from(bytes).toString("utf8"), i + 1];
  }
  if (c === 123) { // {n}\r\n
    const end = b.indexOf(125, i);
    const n = Number(b.subarray(i + 1, end).toString("latin1").replace("+", ""));
    const start = end + 3;
    if (!Number.isInteger(n) || start + n > b.length) throw fail("imap", "the server sent a broken literal");
    return [b.subarray(start, start + n), start + n];
  }
  let j = i;
  while (j < b.length && b[j] !== 32 && b[j] !== 40 && b[j] !== 41 && b[j] !== 13 && b[j] !== 10) {
    if (b[j] === 91) { // [ ... ] as part of the atom
      let depth = 0;
      for (; j < b.length; j++) { if (b[j] === 91) depth++; else if (b[j] === 93 && --depth === 0) break; }
    }
    j++;
  }
  const atom = b.subarray(i, j).toString("latin1");
  return [atom.toUpperCase() === "NIL" ? null : atom, j];
}

/** @param {Buffer} resp an untagged FETCH response @returns {null | Record<string, any>} */
function parseFetch(resp) {
  const m = /^\* (\d+) FETCH /i.exec(resp.subarray(0, 40).toString("latin1"));
  if (!m) return null;
  const [list] = parseValue(resp, m[0].length);
  if (!Array.isArray(list)) return null;
  /** @type {Record<string, any>} */
  const out = {};
  for (let k = 0; k + 1 < list.length; k += 2) {
    const key = String(list[k]).toUpperCase();
    const short = key.startsWith("BODY[HEADER") ? "HEADER" : key.startsWith("BODY[TEXT]") ? "TEXT" : key.startsWith("BODY[]") ? "BODY" : key;
    out[short] = list[k + 1];
  }
  return out;
}

class Imap {
  /** @param {Wire} wire */
  constructor(wire) { this.wire = wire; this.n = 0; this.caps = new Set(); }

  /** One response: a line, and any literals it announces. */
  async response() {
    const chunks = [];
    let total = 0;
    for (;;) {
      const l = await this.wire.line();
      chunks.push(l); total += l.length;
      const m = /\{(\d+)\}$/.exec(l.subarray(Math.max(0, l.length - 24)).toString("latin1"));
      if (!m) break;
      const n = Number(m[1]);
      if (total + n > MAX_RESPONSE) throw fail("imap", "the server sent more than this client accepts in one response");
      chunks.push(CRLF, await this.wire.bytes(n));
      total += n + 2;
    }
    return Buffer.concat(chunks);
  }

  /** @param {Buffer} r */
  static text(r) { return r.subarray(0, 2000).toString("latin1"); }

  /**
   * Send a tagged command and gather its untagged responses. NO and BAD are errors.
   * @param {(string | { lit: Buffer })[]} parts @param {string} what for messages
   * @param {{ onContinue?: () => string }} [o]
   */
  async cmd(parts, what, o = {}) {
    const tag = `V${++this.n}`;
    const untagged = [];
    let total = 0;
    const done = async (r) => {
      const t = Imap.text(r);
      if (!t.startsWith(tag + " ")) return false;
      const status = t.slice(tag.length + 1).split(" ")[0].toUpperCase();
      if (status !== "OK") throw fail("imap", `${what} refused: ${t.slice(tag.length + 1, 300)}`);
      return true;
    };
    const untilContinue = async () => {
      for (;;) {
        const r = await this.response();
        if (r[0] === 43) return; // +
        if (await done(r)) throw fail("imap", `${what}: the server did not ask for the rest of the command`);
        untagged.push(r);
      }
    };
    // Text up to each literal, then its {n} marker, then wait for "+" before the bytes.
    let pending = tag;
    for (const p of parts) {
      pending += " ";
      if (typeof p === "string") { pending += p; continue; }
      this.wire.write(`${pending}{${p.lit.length}}\r\n`);
      await untilContinue();
      this.wire.write(p.lit);
      pending = "";
    }
    this.wire.write(`${pending}\r\n`);
    for (;;) {
      const r = await this.response();
      if (r[0] === 43 && o.onContinue) { this.wire.write(o.onContinue() + "\r\n"); continue; }
      if (await done(r)) break;
      total += r.length;
      if (total > MAX_RESPONSE) throw fail("imap", "the server sent more than this client accepts in one response");
      untagged.push(r);
    }
    return untagged;
  }

  /** @param {Buffer[]} untagged */
  takeCaps(untagged) {
    for (const r of untagged) {
      const m = /^\* CAPABILITY (.*)$/i.exec(Imap.text(r));
      if (m) this.caps = new Set(m[1].toUpperCase().split(/\s+/));
    }
  }

  async greet() {
    const g = Imap.text(await this.response());
    if (/^\* BYE/i.test(g)) throw fail("imap", `the server refused the connection: ${g.slice(0, 200)}`);
    if (!/^\* (OK|PREAUTH)/i.test(g)) throw fail("imap", "the server did not greet as an IMAP server");
    this.takeCaps(await this.cmd(["CAPABILITY"], "CAPABILITY"));
  }

  async starttls(upgradeFn, servername) {
    if (!this.caps.has("STARTTLS")) throw fail("tls", "the IMAP server does not offer STARTTLS");
    await this.cmd(["STARTTLS"], "STARTTLS");
    this.wire.upgrade(upgradeFn, servername);
    this.takeCaps(await this.cmd(["CAPABILITY"], "CAPABILITY"));
  }

  /** @param {string} user @param {string} pass */
  async login(user, pass) {
    try {
      if (this.caps.has("LOGINDISABLED")) {
        if (!this.caps.has("AUTH=PLAIN")) throw fail("auth", "the server disables LOGIN and does not offer AUTHENTICATE PLAIN");
        const b64 = Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64");
        await this.cmd(["AUTHENTICATE", "PLAIN"], "AUTHENTICATE", { onContinue: () => b64 });
      } else {
        await this.cmd(["LOGIN", astring(user), astring(pass)], "LOGIN");
      }
    } catch (e) {
      if (e.code === "imap") throw fail("auth", `the IMAP server refused the login for ${user}`);
      throw e;
    }
  }

  /** EXAMINE INBOX: read-only, and the UIDVALIDITY that makes ids mean something. */
  async examine() {
    const u = await this.cmd(["EXAMINE", "INBOX"], "EXAMINE INBOX");
    for (const r of u) {
      const m = /\[UIDVALIDITY (\d+)\]/i.exec(Imap.text(r));
      if (m) return m[1];
    }
    throw fail("imap", "the server did not give a UIDVALIDITY for INBOX");
  }

  async logout() {
    try { await this.cmd(["LOGOUT"], "LOGOUT"); } catch { /* closing anyway */ }
  }
}

/** Run `fn` inside one logged-in IMAP connection, always closed. */
async function withImap(cfg, password, deps, fn) {
  const r = resolve(cfg);
  const pass = String(await password());
  const secrets = secretsOf(r.username, pass);
  let wire, s;
  try {
    wire = open(r.imap, deps);
    s = new Imap(wire);
    await s.greet();
    if (r.imap.tls === "starttls") await s.starttls(deps.upgrade || defaultUpgrade, net.isIP(r.imap.host) ? "" : r.imap.host);
    await s.login(r.username, pass);
    const out = await fn(s);
    await s.logout();
    return out;
  } catch (e) {
    if (s && wire && !wire.err && e?.code !== "imap") await s.logout();
    throw clean(e, secrets);
  } finally {
    wire?.close();
  }
}

/** An INTERNALDATE, "17-Jul-2026 02:44:25 -0700", as ms, or NaN. @param {unknown} v */
function internalDate(v) {
  const m = /^\s*(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(String(v || ""));
  if (!m) return NaN;
  const mon = MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase());
  if (mon < 0) return NaN;
  const off = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000;
  return Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - off;
}

/** An IMAP date, "7-Sep-2026". @param {number} ms */
const imapDate = ms => { const d = new Date(ms); return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`; };

/**
 * The UID SEARCH criteria for a parsed query.
 * @param {ReturnType<typeof import("../../lib/connectors/message.js").parseQuery>} q @param {number} now
 * @returns {(string | { lit: Buffer })[]}
 */
export function searchCriteria(q, now) {
  /** @type {(string | { lit: Buffer })[]} */
  const out = [];
  const add = (key, vals) => { for (const v of vals || []) { if (/[\r\n]/.test(v)) throw fail("bad_input", "a search term cannot contain a line break"); out.push(key, astring(v)); } };
  add("FROM", q.from); add("TO", q.to); add("SUBJECT", q.subject); add("TEXT", q.words);
  if (q.days !== undefined) out.push("SINCE", imapDate(now - q.days * 86_400_000));
  if (q.unread) out.push("UNSEEN");
  if (!out.length) out.push("ALL");
  const wide = out.some(p => typeof p !== "string" || /[^\x00-\x7f]/.test(p));
  return wide ? ["CHARSET", "UTF-8", ...out] : out;
}

// ---------------------------------------------------------------- MIME

/** Text in a charset, falling back to UTF-8, then Latin-1. @param {Buffer} buf @param {string} [cs] */
function decodeCharset(buf, cs) {
  const label = String(cs || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
  if (label === "utf-8" || label === "utf8" || label === "us-ascii" || label === "ascii") {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return buf.toString("latin1"); }
  }
  try { return new TextDecoder(label).decode(buf); } catch { /* unknown label */ }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { return buf.toString("latin1"); }
}

/** @param {string} s */
function qpBytes(s, underscoreSpace) {
  const out = [];
  const t = s.replace(/=\r?\n/g, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
    else if (underscoreSpace && ch === "_") out.push(32);
    else out.push(t.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

/** Header text with RFC 2047 encoded words decoded, and raw 8-bit bytes read as UTF-8 or Latin-1. @param {string} raw latin1 */
export function decodeHeader(raw) {
  const s = decodeCharset(Buffer.from(raw, "latin1"), "utf-8");
  return s
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1")
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (all, cs, enc, text) => {
      try {
        const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : qpBytes(text, true);
        return decodeCharset(bytes, String(cs).split("*")[0]);
      } catch { return all; }
    });
}

/** @param {Buffer} buf @returns {{ headers: Record<string, string[]>, body: Buffer }} */
function splitMessage(buf) {
  let i = buf.indexOf("\r\n\r\n"), skip = 4;
  const j = buf.indexOf("\n\n");
  if (i < 0 || (j >= 0 && j < i)) { i = j; skip = 2; }
  const head = (i < 0 ? buf : buf.subarray(0, i)).toString("latin1");
  const body = i < 0 ? Buffer.alloc(0) : buf.subarray(i + skip);
  /** @type {Record<string, string[]>} */
  const headers = {};
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const k = line.indexOf(":");
    if (k <= 0) continue;
    const name = line.slice(0, k).trim().toLowerCase();
    (headers[name] ||= []).push(line.slice(k + 1).trim());
  }
  return { headers, body };
}

/** "text/plain; charset=utf-8; name*=utf-8''a%20b.pdf" as a value and params. @param {string} v */
function parseParams(v) {
  const s = String(v || "");
  const semi = s.indexOf(";");
  const value = (semi < 0 ? s : s.slice(0, semi)).trim().toLowerCase();
  /** @type {Record<string, string>} */
  const params = {};
  const re = /;\s*([^=\s;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  const cont = {};
  for (const m of s.matchAll(re)) {
    let key = m[1].toLowerCase();
    let val = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] || "").trim();
    const star = /^(.+?)(?:\*(\d+))?(\*)?$/.exec(key);
    if (star && (star[2] !== undefined || star[3])) {
      const base = star[1];
      if (star[3]) {
        const x = /^([^']*)'[^']*'(.*)$/.exec(val);
        const cs = x ? x[1] : (cont[base]?.cs || "utf-8");
        const pct = x ? x[2] : val;
        try { val = decodeCharset(Buffer.from(pct.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"), cs); } catch { /* keep */ }
        (cont[base] ||= { cs, parts: [] }).cs = cs;
      }
      (cont[base] ||= { cs: "utf-8", parts: [] }).parts[Number(star[2] || 0)] = val;
      continue;
    }
    params[key] = decodeHeader(val);
  }
  for (const [k, c] of Object.entries(cont)) params[k] = c.parts.filter(p => p !== undefined).join("");
  return { value, params };
}

/** @param {Buffer} body @param {string} cte */
function decodeTransfer(body, cte) {
  const e = String(cte || "").trim().toLowerCase();
  if (e === "base64") {
    const t = body.toString("latin1").replace(/[^A-Za-z0-9+/]/g, "");
    return Buffer.from(t.slice(0, t.length - (t.length % 4)), "base64");
  }
  if (e === "quoted-printable") return qpBytes(body.toString("latin1"), false);
  return body;
}

/**
 * The readable parts of a MIME message: text/plain preferred, else HTML as text, and the names of
 * attachments. Lenient: a cut-off message (a partial fetch, a snippet) still gives what it has.
 * @param {Buffer} raw
 */
export function parseMessage(raw) {
  const top = splitMessage(raw);
  const plain = [], html = [], files = [];
  const walk = (part, depth) => {
    const ct = parseParams((part.headers["content-type"] || ["text/plain"])[0]);
    const cd = parseParams((part.headers["content-disposition"] || [""])[0]);
    const name = cd.params.filename || ct.params.name || "";
    if (ct.value.startsWith("multipart/") && ct.params.boundary && depth < 20) {
      const kids = splitParts(part.body, ct.params.boundary);
      for (const k of kids) walk(splitMessage(k), depth + 1);
      return;
    }
    if (cd.value === "attachment" || name || (!ct.value.startsWith("text/") && ct.value !== "")) {
      if (name || cd.value === "attachment" || ct.value === "message/rfc822") files.push(name || (ct.value === "message/rfc822" ? "message.eml" : "attachment"));
      return;
    }
    const text = decodeCharset(decodeTransfer(part.body, (part.headers["content-transfer-encoding"] || [""])[0]), ct.params.charset);
    if (ct.value === "text/html") html.push(text);
    else plain.push(text);
  };
  walk(top, 0);
  const text = plain.length ? plain.join("\n\n") : html.length ? htmlToText(html.join("\n")) : "";
  return { headers: top.headers, text: text.replace(/\r\n/g, "\n"), files };
}

/** The parts of a multipart body, between its boundary lines. @param {Buffer} body @param {string} boundary */
function splitParts(body, boundary) {
  const s = body.toString("latin1");
  const delim = `--${boundary}`;
  const out = [];
  let pos = s.startsWith(delim) ? 0 : s.indexOf(`\n${delim}`);
  if (pos < 0) return out;
  if (pos > 0) pos += 1;
  for (;;) {
    const lineEnd = s.indexOf("\n", pos);
    if (s.startsWith(`${delim}--`, pos) || lineEnd < 0) break;
    const start = lineEnd + 1;
    let next = s.indexOf(`\n${delim}`, start);
    const end = next < 0 ? s.length : next;
    let chunk = s.slice(start, end);
    if (chunk.endsWith("\r")) chunk = chunk.slice(0, -1);
    out.push(Buffer.from(chunk, "latin1"));
    if (next < 0) break;
    pos = next + 1;
  }
  return out;
}

const first = (h, k) => (h[k] && h[k][0] ? decodeHeader(h[k][0]) : "");

// ---------------------------------------------------------------- SMTP

/**
 * A message as the body of SMTP DATA: CRLF line ends, lines starting with a dot doubled, and the
 * final "." line.
 * @param {string} text
 */
export function smtpData(text) {
  const lines = String(text).replace(/\r\n|\r|\n/g, "\n").replace(/\n$/, "").split("\n");
  return lines.map(l => (l.startsWith(".") ? "." + l : l)).join("\r\n") + "\r\n.\r\n";
}

class Smtp {
  /** @param {Wire} wire */
  constructor(wire) { this.wire = wire; this.ext = new Map(); }

  /** One reply, all its lines. */
  async reply() {
    const lines = [];
    let total = 0;
    for (;;) {
      const l = (await this.wire.line()).toString("utf8");
      total += l.length;
      if (lines.length > 500 || total > 256 * 1024) throw fail("smtp", "the server sent an overlong reply");
      const m = /^(\d{3})(?:([ -])(.*))?$/.exec(l);
      if (!m) throw fail("smtp", `the server sent something that is not an SMTP reply: ${l.slice(0, 120)}`);
      lines.push(m[3] || "");
      if (m[2] !== "-") return { code: Number(m[1]), lines, text: `${m[1]} ${lines.join(" ").slice(0, 300)}` };
    }
  }

  /** Send a line and expect a 2xx or 3xx reply. @param {string | null} line @param {string} step */
  async step(line, step, code = "smtp") {
    if (line !== null) this.wire.write(line + "\r\n");
    const r = await this.reply();
    if (r.code >= 400) throw fail(code, `SMTP ${step} refused: ${r.text}`);
    return r;
  }

  async ehlo() {
    const r = await this.step("EHLO [127.0.0.1]", "EHLO");
    this.ext = new Map();
    for (const l of r.lines.slice(1)) {
      const [k, ...rest] = l.trim().split(/[\s=]+/);
      this.ext.set(k.toUpperCase(), rest.map(x => x.toUpperCase()));
    }
  }

  async auth(user, pass) {
    const mechs = this.ext.get("AUTH") || [];
    if (mechs.includes("PLAIN")) {
      await this.step(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass}`, "utf8").toString("base64")}`, "AUTH PLAIN", "auth");
    } else if (mechs.includes("LOGIN")) {
      await this.step("AUTH LOGIN", "AUTH LOGIN", "auth");
      await this.step(Buffer.from(user, "utf8").toString("base64"), "AUTH LOGIN user", "auth");
      await this.step(Buffer.from(pass, "utf8").toString("base64"), "AUTH LOGIN password", "auth");
    } else {
      throw fail("smtp", `SMTP AUTH: the server offers no PLAIN or LOGIN (${mechs.join(" ") || "no AUTH at all"})`);
    }
  }
}

/** Run `fn` inside one authenticated SMTP connection, always closed. */
async function withSmtp(cfg, password, deps, fn) {
  const r = resolve(cfg);
  const pass = String(await password());
  const secrets = secretsOf(r.username, pass);
  let wire;
  try {
    wire = open(r.smtp, deps);
    const s = new Smtp(wire);
    await s.step(null, "greeting");
    await s.ehlo();
    if (r.smtp.tls === "starttls") {
      if (!s.ext.has("STARTTLS")) throw fail("tls", "the SMTP server does not offer STARTTLS");
      await s.step("STARTTLS", "STARTTLS", "tls");
      wire.upgrade(deps.upgrade || defaultUpgrade, net.isIP(r.smtp.host) ? "" : r.smtp.host);
      await s.ehlo();
    }
    await s.auth(r.username, pass);
    const out = await fn(s);
    try { wire.write("QUIT\r\n"); await s.reply(); } catch { /* closing anyway */ }
    return out;
  } catch (e) {
    throw clean(e, secrets);
  } finally {
    wire?.close();
  }
}

// ---------------------------------------------------------------- the adapter

/** @param {ImapDeps} [deps] */
export function imapAdapter(deps = {}) {
  const now = deps.now || Date.now;

  /** @param {any} cfg @returns {string | null} */
  function check(cfg) {
    if (!cfg || typeof cfg !== "object") return "an imap account needs a config";
    if (typeof cfg.address !== "string" || !EMAIL.test(cfg.address)) return "address must be an email address";
    if (cfg.username !== undefined && (typeof cfg.username !== "string" || !cfg.username || /[\r\n\0]/.test(cfg.username))) return "username must be a non-empty string on one line";
    const p = endpointProblem("imap", cfg.imap) || endpointProblem("smtp", cfg.smtp);
    if (p) return p;
    if (!cfg.auth || typeof cfg.auth.item !== "string" || !cfg.auth.item) return "auth.item must name the vault item that holds the password";
    if (cfg.auth.field !== undefined && (typeof cfg.auth.field !== "string" || !cfg.auth.field)) return "auth.field must be a field name";
    return null;
  }

  const ensure = cfg => { const p = check(cfg); if (p) throw fail("bad_input", p); };

  return {
    check,

    /** @param {ImapConfig} cfg */
    items: cfg => [cfg.auth.item],

    /**
     * A harmless round trip on both protocols; never a send.
     * @param {ImapConfig} cfg @param {() => Promise<string>} password
     */
    async test(cfg, password) {
      ensure(cfg);
      let pass;
      try { pass = String(await password()); } catch (e) { return { ok: false, can: { search: false, read: false, send: false }, error: String(e?.message || e), code: e?.code || "auth" }; }
      const once = async () => pass;
      const errors = [];
      let code;
      let reads = false, send = false;
      try { await withImap(cfg, once, deps, s => s.examine()); reads = true; }
      catch (e) { errors.push(`IMAP: ${e.message}`); code ||= e.code; }
      try { await withSmtp(cfg, once, deps, async () => {}); send = true; }
      catch (e) { errors.push(`SMTP: ${e.message}`); code ||= e.code; }
      const can = { search: reads, read: reads, send };
      return reads && send ? { ok: true, can } : { ok: false, can, error: errors.join("; "), code };
    },

    /**
     * @param {ImapConfig} cfg @param {() => Promise<string>} password
     * @param {{ query: ReturnType<typeof import("../../lib/connectors/message.js").parseQuery>, limit?: number }} o
     */
    async search(cfg, password, { query, limit }) {
      ensure(cfg);
      const lim = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || 20));
      const criteria = searchCriteria(query || { words: [], from: [], to: [], subject: [], unread: false }, now());
      return withImap(cfg, password, deps, async s => {
        const validity = await s.examine();
        const found = await s.cmd(["UID", "SEARCH", ...criteria], "UID SEARCH");
        const uids = [];
        for (const r of found) {
          const m = /^\* SEARCH\s*(.*)$/i.exec(r.toString("latin1"));
          if (m) for (const n of m[1].trim().split(/\s+/)) if (/^\d+$/.test(n)) uids.push(Number(n));
        }
        const pick = [...new Set(uids)].sort((a, b) => b - a).slice(0, lim);
        if (!pick.length) return [];
        const fetched = await s.cmd(["UID", "FETCH", pick.join(","),
          `(UID INTERNALDATE BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})] BODY.PEEK[TEXT]<0.${SNIPPET_BYTES}>)`], "UID FETCH");
        const rows = [];
        for (const r of fetched) {
          const f = parseFetch(r);
          if (!f || !f.UID) continue;
          const head = Buffer.isBuffer(f.HEADER) ? f.HEADER : Buffer.from(String(f.HEADER || ""), "utf8");
          const text = Buffer.isBuffer(f.TEXT) ? f.TEXT : Buffer.from(String(f.TEXT || ""), "utf8");
          const h = splitMessage(head).headers;
          const bare = head.toString("latin1").replace(/[\r\n]+$/, "");
          const snippet = parseMessage(Buffer.concat([Buffer.from(bare + "\r\n\r\n", "latin1"), text])).text
            .replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
          const internal = internalDate(f.INTERNALDATE);
          const dateHeader = first(h, "date");
          rows.push({
            id: `INBOX.${validity}.${f.UID}`,
            from: first(h, "from"), to: first(h, "to"), subject: first(h, "subject") || "(no subject)",
            date: dateHeader || (Number.isFinite(internal) ? new Date(internal).toISOString() : ""),
            snippet,
            _at: Number.isFinite(internal) ? internal : (Date.parse(dateHeader) || 0),
            _uid: Number(f.UID),
          });
        }
        return rows.sort((a, b) => b._uid - a._uid).map(({ _uid, ...row }) => row);
      });
    },

    /**
     * @param {ImapConfig} cfg @param {() => Promise<string>} password @param {{ id: string }} o
     */
    async read(cfg, password, { id }) {
      ensure(cfg);
      const m = /^INBOX\.(\d{1,10})\.(\d{1,10})$/.exec(String(id || ""));
      if (!m) throw fail("bad_input", "id must be an IMAP message id such as INBOX.1712.42");
      const [, want, uid] = m;
      return withImap(cfg, password, deps, async s => {
        const validity = await s.examine();
        if (validity !== want) throw fail("stale", "that message id is from before the mailbox was rebuilt; search again for a fresh id");
        const got = await s.cmd(["UID", "FETCH", uid, `(UID RFC822.SIZE BODY.PEEK[]<0.${MAX_RESPONSE - 65536}>)`], "UID FETCH");
        const f = got.map(parseFetch).find(x => x && String(x.UID) === uid);
        if (!f || !f.BODY) throw fail("not_found", "no message with that id in INBOX");
        const raw = Buffer.isBuffer(f.BODY) ? f.BODY : Buffer.from(String(f.BODY), "utf8");
        const cut = Number(f["RFC822.SIZE"]) > raw.length;
        const msg = parseMessage(raw);
        const h = msg.headers;
        const truncated = cut || msg.text.length > BODY_CAP;
        const cc = first(h, "cc"), mid = first(h, "message-id");
        return {
          id: String(id), from: first(h, "from"), to: first(h, "to"), ...(cc ? { cc } : {}),
          subject: first(h, "subject") || "(no subject)", date: first(h, "date"),
          ...(mid ? { message_id: mid } : {}),
          body: msg.text.slice(0, BODY_CAP), ...(truncated ? { truncated: true } : {}),
          ...(msg.files.length ? { attachments: msg.files } : {}),
        };
      });
    },

    /**
     * @param {ImapConfig} cfg @param {() => Promise<string>} password
     * @param {{ to: string | string[], cc?: string | string[], bcc?: string | string[], subject: string, body: string,
     *   in_reply_to?: string, references?: string }} c
     */
    async send(cfg, password, c) {
      ensure(cfg);
      const to = addresses(c.to, "to"), cc = addresses(c.cc, "cc"), bcc = addresses(c.bcc, "bcc");
      checkContent(to, { ...c, cc, bcc });
      if (c.references !== undefined && (typeof c.references !== "string" || /[\r\n]/.test(c.references))) throw fail("bad_input", "references must be Message-IDs on one line");
      const domain = cfg.address.split("@").pop();
      const message_id = `<${crypto.randomBytes(12).toString("hex")}.${now().toString(36)}@${domain}>`;
      const text = rfc822Text({
        from: cfg.address, to, cc, subject: c.subject, body: c.body,
        in_reply_to: c.in_reply_to || undefined, references: c.references || undefined,
        date: new Date(now()), message_id,
      });
      const seen = new Set();
      const rcpt = [...to, ...cc, ...bcc].filter(a => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      await withSmtp(cfg, password, deps, async s => {
        await s.step(`MAIL FROM:<${cfg.address}>`, "MAIL FROM");
        for (const a of rcpt) await s.step(`RCPT TO:<${a}>`, `RCPT TO ${a}`);
        await s.step("DATA", "DATA");
        await s.step(smtpData(text).replace(/\r\n$/, ""), "message");
      });
      return { sent: true, message_id };
    },
  };
}
