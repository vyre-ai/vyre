// @ts-check
// A minimal IMAP client for one job: hear about new mail without polling (0.2 plan: vault.md
// "Push credentials", watchers.md 3.8). XOAUTH2 login, SELECT INBOX, IDLE, and a headers-only
// UID FETCH for what arrived. It reads no body, sets no flag and writes nothing to the mailbox
// (BODY.PEEK, and only the five header fields below).
//
// Rules, and why:
// - Light by default (SPEC principle 8). IDLE holds one socket and costs nothing while it waits.
//   IDLE is ended and re-issued every 29 minutes (RFC 2177 says a server may drop a client that
//   idles for 30). A server with no IDLE gets a NOOP every `noopMs`, never faster than 60 s.
// - No missed mail across a drop: the next UID to expect is kept between connections while the
//   mailbox's UIDVALIDITY is the same, and each new SELECT fetches whatever arrived meanwhile.
//   The first connection starts at UIDNEXT, so old mail is never announced.
// - The access token is handed in per (re)connect by `auth()` and never stored, logged or put in
//   an error: every message leaves scrubbed of it.
// - A refused login is not retried (it would only fail again and, for Gmail, count against the
//   account); it ends the watch with code "auth" so the owner can ask for a new consent. A
//   too-many-connections answer backs off at the longest delay, once per try, not in a tight loop.
// - The socket comes from `connect`, a seam, so tests need no TLS. The default is node:tls.

import tls from "node:tls";
import { scrub } from "./auth.js";

export const IDLE_MS = 29 * 60_000;
export const MIN_NOOP_MS = 60_000;
export const HEADER_FIELDS = ["FROM", "TO", "SUBJECT", "DATE", "MESSAGE-ID"];
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 5 * 60_000;
const STEADY_MS = 60_000;
const MAX_CATCH_UP = 200;
const MAX_LITERAL = 256 * 1024;
const CMD_TIMEOUT_MS = 60_000;

const fail = (msg, code = "failed") => Object.assign(new Error(msg), { code });

/** The XOAUTH2 initial response (Google's SASL mechanism): user and bearer token, base64. */
export const xoauth2 = (user, token) => Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`).toString("base64");

/** The default connect: TLS on the real port, with TCP keepalive so a silent NAT drop is noticed. */
export function tlsConnect({ host, port }) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: host }, () => { s.setKeepAlive(true, 60_000); resolve(s); });
    s.once("error", reject);
  });
}

// ---- response parsing ----

/**
 * Split a byte stream into IMAP responses: a line, with any {n} literal on it read as n raw
 * bytes, and the rest of the line after it. Yields { line, literals } where each literal sits in
 * `line` as {n}.
 */
export class Reader {
  #buf = Buffer.alloc(0);
  /** @param {(r: { line: string, literals: Buffer[] }) => void} onResponse */
  constructor(onResponse) { this.onResponse = onResponse; this.parts = ""; this.literals = []; this.need = 0; }

  /** @param {Buffer} chunk */
  push(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      if (this.need) {
        if (this.#buf.length < this.need) return;
        this.literals.push(this.#buf.subarray(0, this.need));
        this.#buf = this.#buf.subarray(this.need);
        this.need = 0;
      }
      const i = this.#buf.indexOf("\r\n");
      if (i < 0) { if (this.#buf.length > MAX_LITERAL) throw fail("a line from the server is too long", "protocol"); return; }
      const text = this.#buf.subarray(0, i).toString("utf8");
      this.#buf = this.#buf.subarray(i + 2);
      this.parts += text;
      const m = /\{(\d+)\}$/.exec(text);
      if (m) {
        const n = Number(m[1]);
        if (n > MAX_LITERAL) throw fail("a message part from the server is too large", "protocol");
        this.need = n;
        continue;
      }
      const r = { line: this.parts, literals: this.literals };
      this.parts = ""; this.literals = [];
      this.onResponse(r);
    }
  }
}

const clean = (s, n = 200) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);

/** RFC 2047 encoded words in a header value (=?utf-8?B?...?=, =?utf-8?Q?...?=). */
export function decodeWords(s) {
  return String(s).replace(/=\?([\w-]+)\?([bBqQ])\?([^?]*)\?=/g, (all, cs, enc, text) => {
    try {
      const bytes = enc.toLowerCase() === "b" ? Buffer.from(text, "base64")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      return new TextDecoder(cs).decode(bytes);
    } catch { return all; }
  }).replace(/\?=\s+=\?/g, "");
}

/** The five headers of one message, unfolded and cut. @param {string} block @returns {Record<string, string>} */
export function parseHeaders(block) {
  /** @type {Record<string, string>} */ const out = {};
  const unfolded = String(block).replace(/\r?\n[ \t]+/g, " ");
  for (const l of unfolded.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (HEADER_FIELDS.includes(k.toUpperCase()) && !(k in out)) out[k] = clean(decodeWords(m[2]));
  }
  return out;
}

/**
 * @typedef {{ uid: number, messageId: string, from: string, to: string, subject: string, date: string, gmailId?: string }} Header
 * @typedef {{ host?: string, port?: number, connect?: (t: { host: string, port: number }) => Promise<import("node:stream").Duplex>,
 *   auth: () => Promise<{ user: string, token: string }>, onMail: (mail: Header[]) => void,
 *   onState?: (state: string, info?: Record<string, unknown>) => void, log?: (m: string, f?: Record<string, unknown>) => void,
 *   idleMs?: number, noopMs?: number, noopFloorMs?: number, backoffMs?: number, maxBackoffMs?: number, mailbox?: string,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void> }} WatchOptions
 */

const abortable = (ms, signal) => new Promise(resolve => {
  const t = setTimeout(done, ms);
  signal.addEventListener("abort", done, { once: true });
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(undefined); }
});

/**
 * One IMAP connection, from greeting to close. Resolves with why it ended; rejects nothing: a
 * caller reads `end.code`. `keep` carries { validity, next } between connections.
 * @param {WatchOptions} o @param {{ validity?: number, next?: number }} keep @param {AbortSignal} signal
 */
async function session(o, keep, signal) {
  const idleMs = o.idleMs || IDLE_MS;
  const noopMs = Math.max(o.noopMs || MIN_NOOP_MS, o.noopFloorMs ?? MIN_NOOP_MS);
  const state = o.onState || (() => {});
  const cred = await o.auth();
  const secrets = [cred.token, xoauth2(cred.user, cred.token)];
  const safe = e => fail(scrub(String(/** @type {any} */ (e)?.message || e), secrets), typeof /** @type {any} */ (e)?.code === "string" ? /** @type {any} */ (e).code : "failed");

  let sock;
  try { sock = await (o.connect || tlsConnect)({ host: o.host || "imap.gmail.com", port: o.port || 993 }); }
  catch (e) { return safe(Object.assign(new Error(`could not reach the mail server: ${/** @type {any} */ (e)?.code || /** @type {any} */ (e)?.message || "error"}`), { code: "network" })); }

  /** @type {Array<{ line: string, literals: Buffer[] }>} */ const untagged = [];
  /** @type {Map<string, { resolve: (r: any) => void }>} */ const waiting = new Map();
  /** @type {null | ((r: any) => void)} */ let onCont = null;
  let onUntagged = /** @type {null | ((r: { line: string, literals: Buffer[] }) => void)} */ (null);
  let closed = false, tagN = 0;
  /** @type {(e: any) => void} */ let ended = () => {};
  const done = new Promise(resolve => { ended = resolve; });
  let greeted; const greeting = new Promise(r => { greeted = r; });
  let gotGreeting = false;

  const reader = new Reader(r => {
    const l = r.line;
    if (l.startsWith("+")) { const c = onCont; onCont = null; if (c) c(r); return; }
    if (l.startsWith("*")) {
      if (!gotGreeting) { gotGreeting = true; greeted(r); if (/^\* BYE/i.test(l)) close(fail(clean(l.slice(6)), /too many|simultaneous/i.test(l) ? "busy" : "bye")); return; }
      if (/^\* BYE/i.test(l)) { close(fail(clean(l.slice(6)) || "the server closed the connection", /too many|simultaneous/i.test(l) ? "busy" : "bye")); return; }
      untagged.push(r);
      if (onUntagged) onUntagged(r);
      return;
    }
    const m = /^(a\d+) (OK|NO|BAD)\b\s*(.*)$/i.exec(l);
    const w = m && waiting.get(m[1]);
    if (m && w) { waiting.delete(m[1]); w.resolve({ status: m[2].toUpperCase(), text: m[3], untagged: untagged.splice(0) }); }
  });

  function close(err) { if (closed) return; closed = true; try { sock.destroy(); } catch {} for (const w of waiting.values()) w.resolve({ status: "GONE", text: "", untagged: [] }); waiting.clear(); ended(err); }
  sock.on("data", d => { try { reader.push(d); } catch (e) { close(safe(e)); } });
  sock.on("error", e => close(safe(Object.assign(new Error(`connection error: ${/** @type {any} */ (e)?.code || "error"}`), { code: "network" }))));
  sock.on("close", () => close(fail("the connection closed", "closed")));
  const stop = () => close(fail("stopped", "stopped"));
  if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });

  /** Send one tagged command and wait for its answer. `raw` is written as is when the command carries a secret. */
  const command = (text, { timeout = CMD_TIMEOUT_MS } = {}) => new Promise((resolve, reject) => {
    if (closed) return reject(fail("the connection closed", "closed"));
    const tag = `a${++tagN}`;
    const t = setTimeout(() => { waiting.delete(tag); reject(fail("the server did not answer in time", "timeout")); close(fail("the server did not answer in time", "timeout")); }, timeout);
    t.unref?.();
    waiting.set(tag, { resolve: r => { clearTimeout(t); r.status === "GONE" ? reject(fail("the connection closed", "closed")) : resolve(r); } });
    sock.write(`${tag} ${text}\r\n`);
  });

  const run = (async () => {
    await greeting;
    // AUTHENTICATE with the initial response; a refusal arrives as a "+" carrying a JSON reason,
    // which is answered with an empty line before the tagged NO.
    onCont = () => sock.write("\r\n");
    const auth = await command(`AUTHENTICATE XOAUTH2 ${xoauth2(cred.user, cred.token)}`);
    onCont = null;
    if (auth.status !== "OK") throw fail(`the mail server refused the sign-in${/too many|simultaneous/i.test(auth.text) ? " (too many connections)" : ""}: ${clean(auth.text, 80)}`, /too many|simultaneous/i.test(auth.text) ? "busy" : "auth");
    const sel = await command(`SELECT ${o.mailbox || "INBOX"}`);
    if (sel.status !== "OK") throw fail(`could not open the mailbox: ${clean(sel.text, 80)}`, "mailbox");
    const countOf = list => { for (const u of list) { const m = /^\* (\d+) EXISTS/i.exec(u.line); if (m) return Number(m[1]); } return undefined; };
    const num = re => { for (const u of sel.untagged) { const m = re.exec(u.line); if (m) return Number(m[1]); } return undefined; };
    const validity = num(/UIDVALIDITY (\d+)/i), uidNext = num(/UIDNEXT (\d+)/i);
    if (!uidNext) throw fail("the mail server sent no UIDNEXT", "protocol");
    if (keep.validity !== validity || !keep.next) keep.next = uidNext;
    keep.validity = validity;
    const cap = await command("CAPABILITY");
    const canIdle = cap.untagged.some(u => /\bIDLE\b/i.test(u.line));
    // Gmail's own message id (X-GM-MSGID, advertised as X-GM-EXT-1): the id its API takes, so a reader needs no search. Asked only of a server that says it has it.
    const gmail = cap.untagged.some(u => /\bX-GM-EXT-1\b/i.test(u.line));
    state(canIdle ? "idle" : "polling", { idle: canIdle });

    /** The message count the server last told us, so only a rise counts as new mail. */
    let known = countOf(sel.untagged);
    // After a long gap, do not fetch a whole mailbox's worth of headers.
    if (uidNext - keep.next > MAX_CATCH_UP) keep.next = uidNext - MAX_CATCH_UP;

    /** What arrived since `keep.next`, headers only. */
    const catchUp = async () => {
      const r = await command(`UID FETCH ${keep.next}:* (UID${gmail ? " X-GM-MSGID" : ""} BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS.join(" ")})])`);
      if (r.status !== "OK") throw fail(`fetching headers failed: ${clean(r.text, 80)}`, "fetch");
      /** @type {Header[]} */ const mail = [];
      for (const u of r.untagged) {
        const uid = Number(/\bUID (\d+)/i.exec(u.line)?.[1]);
        if (!(uid >= keep.next) || !u.literals.length) continue;
        const h = parseHeaders(u.literals[0].toString("utf8"));
        // The API's id is the 64-bit X-GM-MSGID in hex.
        const gm = /X-GM-MSGID (\d{1,20})/i.exec(u.line)?.[1];
        let gmailId;
        if (gm) { try { gmailId = BigInt(gm).toString(16); } catch { gmailId = undefined; } }
        mail.push({ uid, messageId: h["message-id"] || "", from: h.from || "", to: h.to || "", subject: h.subject || "", date: h.date || "", ...(gmailId ? { gmailId } : {}) });
      }
      mail.sort((a, b) => a.uid - b.uid);
      if (mail.length) { keep.next = mail[mail.length - 1].uid + 1; o.onMail(mail); }
    };
    /** Fold untagged EXISTS and EXPUNGE lines into `known`; true when the count rose. */
    const track = list => {
      let rose = false;
      for (const u of list) {
        const e = /^\* (\d+) EXISTS/i.exec(u.line);
        if (e) { const n = Number(e[1]); if (known === undefined || n > known) rose = true; known = n; }
        else if (/^\* \d+ EXPUNGE/i.test(u.line) && known) known -= 1;
      }
      return rose;
    };
    await catchUp();

    while (!closed) {
      let arrived = false;
      if (canIdle) {
        // Wait for a new-mail line, the 29 minute limit or a stop; then end IDLE and look.
        let wake = () => {};
        const woke = new Promise(r => { wake = () => r(undefined); });
        /** @type {() => void} */ let idleOn = () => {};
        const idling = new Promise(r => { idleOn = () => r(undefined); });
        onCont = () => idleOn();
        onUntagged = r => { if (track([r])) { arrived = true; wake(); } };
        const finished = command("IDLE", { timeout: idleMs + CMD_TIMEOUT_MS });
        finished.catch(() => {});
        await Promise.race([idling, done]);
        const timer = setTimeout(wake, idleMs);
        timer.unref?.();
        await Promise.race([woke, done]);
        clearTimeout(timer);
        if (closed) break;
        sock.write("DONE\r\n");
        const end = await finished;
        onUntagged = null;
        if (end.status !== "OK") throw fail(`IDLE was refused: ${clean(end.text, 80)}`, "idle");
        // Lines that came in as IDLE ended were queued, not seen live; the ones already tracked
        // leave `known` unchanged, so only a genuinely new count sets this.
        if (track(end.untagged)) arrived = true;
      } else {
        await Promise.race([abortable(noopMs, signal), done]);
        if (closed) break;
        const r = await command("NOOP");
        if (track(r.untagged)) arrived = true;
      }
      if (arrived) await catchUp();
    }
    return fail("the connection closed", "closed");
  })();
  run.catch(e => close(safe(e)));
  const end = await done;
  signal.removeEventListener("abort", stop);
  return end;
}

/**
 * Watch a mailbox until `stop()`: connect, hear about new mail, and on any drop reconnect with
 * exponential backoff (2 s to 5 min). `auth()` is called for each connection, so a token is
 * always fresh. A refused login (code "auth") ends the watch; the caller decides what that means.
 * @param {WatchOptions} o
 * @returns {{ stop: () => void, done: Promise<{ code: string, message: string }> }}
 */
export function watch(o) {
  const ac = new AbortController();
  const state = o.onState || (() => {});
  const log = o.log || (() => {});
  const sleep = o.sleep || abortable;
  const min = o.backoffMs || BACKOFF_MIN_MS, max = o.maxBackoffMs || BACKOFF_MAX_MS;
  const keep = {};
  const finished = (async () => {
    let delay = min;
    while (!ac.signal.aborted) {
      const started = Date.now();
      let end;
      try { end = await session(o, keep, ac.signal); } catch (e) {
        // auth() itself failed (the token could not be minted): its code says whether to retry.
        end = fail(String(/** @type {any} */ (e)?.message || e), typeof /** @type {any} */ (e)?.code === "string" ? /** @type {any} */ (e).code : "failed");
        Object.assign(end, { oauthError: /** @type {any} */ (e)?.oauthError });
      }
      const code = /** @type {any} */ (end)?.code || "closed";
      if (ac.signal.aborted || code === "stopped") break;
      if (code === "auth" || code === "refused" || code === "config" || code === "unavailable" || /** @type {any} */ (end)?.oauthError === "invalid_grant") {
        state("failed", { code, message: end.message });
        return { code, message: end.message };
      }
      if (Date.now() - started > STEADY_MS) delay = min;
      const wait = code === "busy" ? max : delay;
      state("lost", { code, message: end?.message, retryMs: wait });
      log("imap connection lost", { code, retryMs: wait });
      await sleep(wait, ac.signal);
      delay = Math.min(max, delay * 2);
    }
    state("stopped");
    return { code: "stopped", message: "stopped" };
  })();
  return { stop: () => ac.abort(), done: finished };
}
