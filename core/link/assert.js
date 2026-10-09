// @ts-check
// assert: the box's signed word that the person answered a Mac's ask (docs/adr/0021, "v2:
// answering a Mac's permission question from the box").
//
// The box holds an Ed25519 key, made on first need and kept in its home at 0600. The Mac pins the
// public half when it pairs (or, paired before this, once over the channel it already pinned).
// When the person answers a Mac-owned ask on the box, the box signs an assertion bound to that
// Mac, that ask and the exact answer, valid for 60 s and usable once. The Mac checks every part
// before it runs threads.answer, and accepts an assertion for threads.answer only.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonical as kernelCanonical } from "../../kernel/core/canonical.js";

/** How long an assertion is good for. */
export const TTL = 60_000;
/** How far ahead of the Mac's clock an assertion may say it was made. */
export const SKEW = 60_000;
/** At most this many unexpired nonces are remembered; past it, answers are refused, never forgotten early. */
export const MAX_NONCES = 1000;
/** The file in the box's home that holds the key. */
export const KEY_FILE = "link-assert-key.json";

const b64u = (/** @type {Buffer} */ b) => Buffer.from(b).toString("base64url");

/** JSON with every object's keys sorted, so both ends hash the same bytes for the same value: the kernel's canonical (kernel/core/canonical.js). A value that is undefined at the top is "null". @param {any} v @returns {string} */
export const canonical = v => (v === undefined ? "null" : kernelCanonical(v));

/** sha256 of the canonical JSON, base64url: what the assertion's `decision` binds. @param {any} input */
export const decisionHash = input => b64u(crypto.createHash("sha256").update(canonical(input)).digest());

/** The stored key, or null when there is none yet. @param {string} file */
function loadKey(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { if (/** @type {any} */ (e).code === "ENOENT") return null; throw e; }
  try {
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(JSON.parse(text).private, "base64url"), format: "der", type: "pkcs8" });
    return { privateKey, publicKey: b64u(crypto.createPublicKey(privateKey).export({ format: "der", type: "spki" })) };
  } catch (e) { throw new Error(`the link's key in ${file} could not be read: ${/** @type {Error} */ (e).message}`); }
}

/**
 * The box's key: loaded from its home, or made and stored there at 0600 on first need.
 * @param {string} root the box's VYRE_HOME
 * @returns {{ privateKey: crypto.KeyObject, publicKey: string }} publicKey: SPKI DER, base64url
 */
export function boxKey(root) {
  const file = path.join(root, KEY_FILE);
  const had = loadKey(file);
  if (had) return had;
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const text = JSON.stringify({ v: 1, alg: "ed25519", private: b64u(privateKey.export({ format: "der", type: "pkcs8" })) }) + "\n";
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Two makers racing: the first file wins (link never replaces), and both read it back.
  try { fs.linkSync(tmp, file); } catch (e) { if (/** @type {any} */ (e).code !== "EEXIST") { fs.rmSync(tmp, { force: true }); throw e; } }
  fs.rmSync(tmp, { force: true });
  return /** @type {any} */ (loadKey(file));
}

/**
 * Sign an answer for one Mac.
 * @param {crypto.KeyObject} privateKey
 * @param {{ mac: string, ask: string, thread?: string|null, input: any, caller: string, device?: string|null, person?: string|null, presence?: string|null, now?: number }} o
 *   person: the person session's id on the box, null for a socket caller (the person already);
 *   presence: how the person proved presence for this call (a method such as "passkey"), or null
 * @returns {{ a: string, sig: string }} a: the assertion's canonical JSON, base64url; sig: its Ed25519 signature
 */
export function signAnswer(privateKey, { mac, ask, thread, input, caller, device, person, presence, now = Date.now() }) {
  const A = { v: 1, tool: "threads.answer", mac, ask, ...(thread ? { thread } : {}), decision: decisionHash(input),
    caller, device: device || null, person: person || null, presence: presence || null, iat: now, exp: now + TTL, nonce: b64u(crypto.randomBytes(16)) };
  const bytes = Buffer.from(canonical(A));
  return { a: b64u(bytes), sig: b64u(crypto.sign(null, bytes, privateKey)) };
}

/** The file in the Mac's home that persists seen nonces across a restart (see Nonces, below). */
export const NONCES_FILE = "link-assert-nonces.json";

/**
 * Nonces seen, each kept until its assertion expires, and never more than MAX_NONCES. Memory
 * only unless given a file: without one, a Mac that restarts inside a used assertion's 60 s TTL
 * forgets it saw that nonce, so a captured assertion could replay once in that window (e2e review
 * of 0f2a8752, LOW 2). With a file, what is seen is written there too (best-effort: a write that
 * fails never blocks the answer), and loaded back at start, pruned to what has not yet expired.
 */
export class Nonces {
  /** @param {string|null} [file] @param {number} [now] a test seam; production takes the real clock */
  constructor(file = null, now = Date.now()) {
    this.file = file;
    /** @type {Map<string, number>} */ this.seen = new Map();
    if (file) this.load(now);
  }
  /** @param {number} [now] */
  load(now = Date.now()) {
    let rows;
    try { rows = JSON.parse(fs.readFileSync(/** @type {string} */ (this.file), "utf8")); } catch { return; }
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (Array.isArray(row) && typeof row[0] === "string" && Number(row[1]) > now) this.seen.set(row[0], Number(row[1]));
  }
  save() {
    if (!this.file) return;
    try {
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.seen]), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {} // best-effort: the in-memory record still refuses a replay this run
  }
  /** Record a nonce: false if it was seen, or there is no room. @param {string} n @param {number} exp @param {number} now */
  take(n, exp, now) {
    for (const [k, e] of this.seen) if (e <= now) this.seen.delete(k);
    if (this.seen.has(n) || this.seen.size >= MAX_NONCES) return false;
    this.seen.set(n, exp);
    this.save();
    return true;
  }
}

/**
 * The Mac's check, before threads.answer runs as "link:box". Every part must hold: the signature
 * against the pinned key, the tool, this Mac, this ask, this exact input, the time, and a nonce
 * not seen before, and for a gated ask (federate.js gatedAsk: it approves a floor tool) a fresh
 * proof of presence on the box, never a presence session. The nonce is spent only when everything
 * else passed.
 * @param {{ assertion: any, tool: string, input: any, pinned?: string|null, self?: string|null, nonces: Nonces, now?: number, gated?: boolean }} o
 *   gated: the Mac's own ask, looked up by the Mac, is gated
 * @returns {{ ok: true, a: any } | { ok: false, reason: string }}
 */
export function checkAnswer({ assertion, tool, input, pinned, self, nonces, now = Date.now(), gated = false }) {
  const no = reason => ({ ok: /** @type {false} */ (false), reason });
  if (tool !== "threads.answer") return no(`an assertion answers threads.answer only, not ${tool}`);
  if (!pinned) return no("this Mac has not pinned the box's key; it answers from the box once it has");
  if (!self) return no("this Mac does not know its own node yet");
  if (!assertion || typeof assertion.a !== "string" || typeof assertion.sig !== "string") return no("the answer carries no assertion from the box");
  const bytes = Buffer.from(assertion.a, "base64url");
  let good = false;
  try { good = crypto.verify(null, bytes, crypto.createPublicKey({ key: Buffer.from(pinned, "base64url"), format: "der", type: "spki" }), Buffer.from(assertion.sig, "base64url")); }
  catch { good = false; }
  if (!good) return no("the assertion is not signed by the box this Mac paired with");
  /** @type {any} */ let A;
  try { A = JSON.parse(bytes.toString("utf8")); } catch { return no("the assertion is not readable"); }
  if (!A || A.v !== 1) return no("the assertion's version is not known here");
  if (A.tool !== "threads.answer") return no(`the assertion is for ${A.tool}, not threads.answer`);
  if (A.mac !== self) return no("the assertion is for another Mac");
  if (!input || A.ask !== input.ask) return no("the assertion is for another ask");
  if (A.decision !== decisionHash(input)) return no("the answer is not the one the box signed");
  if (!Number.isFinite(A.iat) || !Number.isFinite(A.exp) || A.exp - A.iat > TTL) return no("the assertion's times are not valid");
  if (now >= A.exp) return no("the assertion has expired");
  if (A.iat > now + SKEW) return no("the assertion is dated in the future");
  if (typeof A.nonce !== "string" || A.nonce.length < 16) return no("the assertion has no nonce");
  if (gated && (typeof A.presence !== "string" || !A.presence || A.presence === "session")) return no("this ask approves a protected action and needs a fresh proof of presence on the box");
  if (!nonces.take(A.nonce, A.exp, now)) return no("the assertion was used already");
  return { ok: true, a: A };
}

/** What an operation call's assertion binds: the site, the operation and the exact inputs. @param {{ site: string, name: string, inputs?: any }} c */
export const callBind = c => ({ site: String(c.site), name: String(c.name), inputs: c.inputs === undefined ? {} : c.inputs });

/**
 * Sign one call of a learned website operation for one Mac: that site, that operation, those inputs; 60 s, once. Only for an outward operation the person already approved on the box.
 * @param {crypto.KeyObject} privateKey @param {{ mac: string, call: { site: string, name: string, inputs?: any }, caller: string, now?: number }} o
 */
export function signCall(privateKey, { mac, call, caller, now = Date.now() }) {
  const A = { v: 1, tool: "chrome.op.send", mac, decision: decisionHash(callBind(call)), caller, iat: now, exp: now + TTL, nonce: b64u(crypto.randomBytes(16)) };
  const bytes = Buffer.from(canonical(A));
  return { a: b64u(bytes), sig: b64u(crypto.sign(null, bytes, privateKey)) };
}

/**
 * The Mac's check before it lets an outward operation run for the box: the signature against the pinned key, this Mac, these exact bytes, the time, and a nonce not seen before (spent last).
 * @param {{ assertion: any, call: { site: string, name: string, inputs?: any }, pinned?: string|null, self?: string|null, nonces: Nonces, now?: number }} o
 * @returns {{ ok: true, a: any } | { ok: false, reason: string }}
 */
export function checkCall({ assertion, call, pinned, self, nonces, now = Date.now() }) {
  const no = (/** @type {string} */ reason) => ({ ok: /** @type {false} */ (false), reason });
  if (!pinned) return no("this Mac has not pinned the box's key");
  if (!self) return no("this Mac does not know its own node yet");
  if (!assertion || typeof assertion.a !== "string" || typeof assertion.sig !== "string") return no("an outward call carries no assertion from the box");
  const bytes = Buffer.from(assertion.a, "base64url");
  let good = false;
  try { good = crypto.verify(null, bytes, crypto.createPublicKey({ key: Buffer.from(pinned, "base64url"), format: "der", type: "spki" }), Buffer.from(assertion.sig, "base64url")); } catch { good = false; }
  if (!good) return no("the assertion is not signed by the box this Mac paired with");
  /** @type {any} */ let A;
  try { A = JSON.parse(bytes.toString("utf8")); } catch { return no("the assertion is not readable"); }
  if (!A || A.v !== 1 || A.tool !== "chrome.op.send") return no("the assertion is not for an operation send");
  if (A.mac !== self) return no("the assertion is for another Mac");
  if (A.decision !== decisionHash(callBind(call))) return no("the call is not the one the box signed");
  if (!Number.isFinite(A.iat) || !Number.isFinite(A.exp) || A.exp - A.iat > TTL) return no("the assertion's times are not valid");
  if (now >= A.exp) return no("the assertion has expired");
  if (A.iat > now + SKEW) return no("the assertion is dated in the future");
  if (typeof A.nonce !== "string" || A.nonce.length < 16) return no("the assertion has no nonce");
  if (!nonces.take(A.nonce, A.exp, now)) return no("the assertion was used already");
  return { ok: true, a: A };
}
