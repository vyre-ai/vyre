// @ts-check
// The typed Wink code (spec 6.5): `WINK-NNPP-PPPP`, and the PAKE that makes its six password
// characters safe to type. Pure JS on Uint8Array: it runs in a browser, in React Native and in Node,
// and imports nothing from Node.
//
// WHAT THIS IS, FOR THE REVIEWER. The exchange follows draft-irtf-cfrg-cpace (CPACE-RISTRETTO255-
// SHA512, initiator/responder) with ristretto255 and SHA-512 from the vendored, audited @noble
// libraries (./vendor). It is NOT an audited CPace library: the glue (generator string, lv_cat,
// transcript, ISK) is ours, written from the draft. It is checked against the draft's test vectors
// for calculate_generator, the two public messages, K and ISK (code.test.js, appendix B.3 of
// draft-irtf-cfrg-cpace-20). Not covered by vectors: the parallel (transcript_oc) mode, which this
// code does not use, and the invalid-point cases, which this code rejects outright (an undecodable
// point, the identity, an identity result). Everything after the ISK (the confirmation tags, the
// number, the sealing key) is Vyre's own HMAC-SHA-512 construction, not part of the draft.
//
// Roles are bound: the TYPIST is the CPace initiator (idA) and the SHOWING device the responder
// (idB), so a message cannot be reflected back. The session id carries the typist's random bytes and
// the rendezvous, and the showing device's route id is in its transcript term (ADb), so a session
// cannot be replayed under another rendezvous or box. The typist cannot know the route before it
// has sent message 1 (the generator depends on the session id), so the relay tells it the route in
// the reply to message 1; a wrong route only makes the confirmation fail.
//
// Order. The showing device never sends anything derived from the shared key before it has
// verified the typist's confirmation (spec 6.5):
//   1 typist  -> showing   Ya                         (the typist begins)
//   2 showing -> typist    Yb                         (the showing device evaluates the key here)
//   3 typist  -> showing   tagT, the typist's confirmation (the showing device verifies it first)
//   4 showing -> typist    tagS, the showing device's confirmation (only after tagT verified)
// Yb is g^y with a fresh secret y: it depends on the password only through the generator g and gives
// an outsider nothing to test a guess against. Then both hold the same 3-digit `number` and the same
// 32-byte `key` (the sealing key for the sealed record). Both come from the ISK and the transcript,
// so a person in the middle who does not know the password gets a different number and key.

import { ristretto255, ristretto255_hasher, sha512 } from "./vendor/noble-ristretto255.js";

const enc = new TextEncoder();
const Point = ristretto255.Point;

/** Crockford base32, no U. */
export const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_RV_CHARS = 2;
export const CODE_PW_CHARS = 6;
/** The group order l of ristretto255. */
const ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const DSI = "CPaceRistretto255";
const DSI_ISK = "CPaceRistretto255_ISK";
const S_IN_BYTES = 128;
const LABEL = "vyre-wink-code-v1";
export const ID_TYPIST = "vyre-wink-typist";
export const ID_SHOWING = "vyre-wink-showing";

/** @param {number} n @returns {Uint8Array} */
const defaultRng = n => globalThis.crypto.getRandomValues(new Uint8Array(n));
/** @param {...Uint8Array} parts */
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** @param {Uint8Array} b */
export const toHex = b => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
/** @param {string} h */
export const fromHex = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));
/** @param {Uint8Array} b */
export function b64url(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** @param {string} s @returns {Uint8Array|null} */
export function unb64url(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  try { return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0)); } catch { return null; }
}
/** Constant-time equality. @param {Uint8Array} a @param {Uint8Array} b */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

// ---- the code: parse, format, normalise ----

/** Folds one input character to the alphabet (Crockford: O is 0, I and L are 1), or null. @param {string} c */
function fold(c) {
  const u = c.toUpperCase();
  const f = u === "O" ? "0" : u === "I" || u === "L" ? "1" : u;
  return f.length === 1 && ALPHABET.includes(f) ? f : null;
}

/**
 * Reads what a person typed. Case, spaces and hyphens are ignored, look-alikes are folded, and the
 * `WINK` prefix is optional (told apart by length: 12 characters with it, 8 without). Null for
 * anything else, a U included.
 * @param {string} input
 * @returns {{ code: string, rv: string, pw: string } | null}
 */
export function parseCode(input) {
  if (typeof input !== "string" || input.length > 64) return null;
  let s = input.replace(/[\s\-_]/g, "");
  if (s.length === 12 && s.slice(0, 4).toUpperCase() === "WINK") s = s.slice(4);
  if (s.length !== CODE_RV_CHARS + CODE_PW_CHARS) return null;
  let out = "";
  for (const c of s) { const f = fold(c); if (!f) return null; out += f; }
  const rv = out.slice(0, CODE_RV_CHARS), pw = out.slice(CODE_RV_CHARS);
  return { code: formatCode(rv, pw), rv, pw };
}

/** `WINK-NNPP-PPPP` from the two parts. @param {string} rv two symbols @param {string} pw six symbols */
export function formatCode(rv, pw) {
  const all = rv + pw;
  if (rv.length !== CODE_RV_CHARS || pw.length !== CODE_PW_CHARS || [...all].some(c => !ALPHABET.includes(c))) throw new Error("bad code parts");
  return `WINK-${all.slice(0, 4)}-${all.slice(4)}`;
}

/** The canonical form of what was typed, or null. @param {string} input */
export const normaliseCode = input => parseCode(input)?.code ?? null;

/** Is this a well-formed rendezvous (two alphabet symbols)? @param {unknown} rv */
export const isRendezvous = rv => typeof rv === "string" && rv.length === CODE_RV_CHARS && [...rv].every(c => ALPHABET.includes(c));
/** @param {unknown} pw */
const isPassword = pw => typeof pw === "string" && pw.length === CODE_PW_CHARS && [...pw].every(c => ALPHABET.includes(c));

/** The rendezvous as its number 0..1023. @param {string} rv */
export const rendezvousIndex = rv => ALPHABET.indexOf(rv[0]) * 32 + ALPHABET.indexOf(rv[1]);
/** @param {number} i 0..1023 */
export const rendezvousFromIndex = i => ALPHABET[(i >> 5) & 31] + ALPHABET[i & 31];

/**
 * A fresh code for a rendezvous the relay handed out: six random password symbols (30 bits).
 * @param {string} rv @param {(n: number) => Uint8Array} [rng]
 */
export function newCode(rv, rng = defaultRng) {
  if (!isRendezvous(rv)) throw new Error("bad rendezvous");
  let pw = "";
  // 256 is a multiple of 32, so a byte masked to 5 bits is uniform.
  for (const b of rng(CODE_PW_CHARS)) pw += ALPHABET[b & 31];
  return { code: formatCode(rv, pw), rv, pw };
}

// ---- CPace pieces (draft-irtf-cfrg-cpace, ristretto255 + SHA-512) ----

/** LEB128 length prefix, then the bytes. @param {Uint8Array} b */
function lv(b) {
  const len = [];
  let n = b.length;
  do { let x = n & 0x7f; n >>>= 7; if (n) x |= 0x80; len.push(x); } while (n);
  return concat(Uint8Array.from(len), b);
}
/** @param {...Uint8Array} parts */
const lvCat = (...parts) => concat(...parts.map(lv));
/** @param {string} s */
const utf8 = s => enc.encode(s);

/** The little-endian integer of some bytes. @param {Uint8Array} b */
function leInt(b) { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; }

/** generator_string(DSI, PRS, CI, sid, s_in_bytes) of the draft. @param {Uint8Array} prs @param {Uint8Array} ci @param {Uint8Array} sid */
export function generatorString(prs, ci, sid) {
  const dsi = utf8(DSI);
  const zpad = Math.max(0, S_IN_BYTES - 1 - lv(prs).length - lv(dsi).length);
  return lvCat(dsi, prs, new Uint8Array(zpad), ci, sid);
}
/** calculate_generator: the ristretto255 element derived from SHA-512 of the generator string. @param {Uint8Array} prs @param {Uint8Array} ci @param {Uint8Array} sid */
export function calculateGenerator(prs, ci, sid) {
  return ristretto255_hasher.deriveToCurve(sha512(generatorString(prs, ci, sid)));
}

/** A fresh scalar in [1, l): 64 random bytes reduced mod l. @param {(n: number) => Uint8Array} rng */
export function sampleScalar(rng) {
  for (;;) { const y = leInt(rng(64)) % ORDER; if (y !== 0n) return y; }
}
/** @param {Uint8Array} le32 */
export const scalarFromBytes = le32 => leInt(le32) % ORDER;

/** The shared point y * Y, refusing an undecodable or identity input and an identity result. @param {bigint} y @param {Uint8Array} Y */
export function sharedPoint(y, Y) {
  let P;
  try { P = Point.fromBytes(Y); } catch { throw new Error("bad point"); }
  if (P.is0()) throw new Error("bad point");
  const K = P.multiply(y);
  if (K.is0()) throw new Error("bad point");
  return K.toBytes();
}

/** transcript_ir = lv(Ya) lv(ADa) lv(Yb) lv(ADb). @param {Uint8Array} Ya @param {Uint8Array} ADa @param {Uint8Array} Yb @param {Uint8Array} ADb */
export const transcriptIr = (Ya, ADa, Yb, ADb) => lvCat(Ya, ADa, Yb, ADb);

/** ISK = H(lv(DSI_ISK) lv(sid) lv(K) transcript_ir). @param {Uint8Array} sid @param {Uint8Array} K @param {Uint8Array} transcript */
export const isk = (sid, K, transcript) => sha512(concat(lvCat(utf8(DSI_ISK), sid, K), transcript));

/** HMAC-SHA-512 (RFC 2104) for the confirmation tags, the number and the key. @param {Uint8Array} key @param {Uint8Array} msg */
export function hmac512(key, msg) {
  const k = new Uint8Array(128);
  k.set(key.length > 128 ? sha512(key) : key);
  const ip = k.map(x => x ^ 0x36), op = k.map(x => x ^ 0x5c);
  return sha512(concat(op, sha512(concat(ip, msg))));
}

// ---- the session ----

const AD_TYPIST = utf8(`${LABEL}/typist`);
/** The showing device's transcript term: its label and its route id. @param {string} route */
const adShowing = route => lvCat(utf8(`${LABEL}/showing`), utf8(String(route)));
const CI = lvCat(utf8(ID_TYPIST), utf8(ID_SHOWING));

/** The typist's 16 random bytes, bound to the rendezvous. @param {Uint8Array} nonce @param {string} rv */
const sessionId = (nonce, rv) => lvCat(utf8(LABEL), nonce, utf8(rv));

/** What both ends derive once the ISK is known. @param {Uint8Array} sid @param {Uint8Array} ISK @param {Uint8Array} transcript */
function derive(sid, ISK, transcript) {
  const th = sha512(concat(utf8(`${LABEL}/transcript`), sid, transcript));
  /** @param {string} label @param {...Uint8Array} more */
  const mac = (label, ...more) => hmac512(ISK, concat(utf8(`${LABEL}/${label}`), th, ...more));
  const tagT = mac("confirm-typist").slice(0, 32);
  const tagS = mac("confirm-showing", tagT).slice(0, 32);
  const n = mac("number");
  const number = String(((n[0] << 24 | n[1] << 16 | n[2] << 8 | n[3]) >>> 0) % 1000).padStart(3, "0");
  const key = mac("seal").slice(0, 32);
  return { tagT, tagS, number, key };
}

/**
 * The typing device's side. `s` is the session nonce (base64url) the relay carries as the session
 * id; `first` is message 1 (Ya, 32 bytes); `second(Yb, route)` takes the showing device's reply and
 * the route id the relay named (it is in the showing device's transcript term, so a wrong one only makes
 * the confirmation fail) and returns the typist's confirmation (message 3), or throws on a bad point; `finish(tagS)` checks
 * the showing device's confirmation (message 4) and yields the number and key.
 * @param {{ pw: string, rv: string, rng?: (n: number) => Uint8Array, scalar?: bigint, nonce?: Uint8Array }} o
 */
export function typistStart(o) {
  if (!isRendezvous(o.rv) || !isPassword(o.pw)) throw new Error("bad code");
  const rng = o.rng || defaultRng;
  const nonce = o.nonce || rng(16);
  const sid = sessionId(nonce, o.rv);
  const g = calculateGenerator(utf8(o.pw), CI, sid);
  const y = o.scalar ?? sampleScalar(rng);
  const Ya = g.multiply(y).toBytes();
  /** @type {ReturnType<typeof derive> | null} */
  let d = null;
  let done = false;
  return {
    s: b64url(nonce),
    first: Ya,
    /** @param {Uint8Array} Yb @param {string} route @returns {Uint8Array} */
    second(Yb, route) {
      if (d) throw new Error("already answered");
      const K = sharedPoint(y, Yb);
      const tr = transcriptIr(Ya, AD_TYPIST, Yb, adShowing(route));
      d = derive(sid, isk(sid, K, tr), tr);
      return d.tagT;
    },
    /** @param {Uint8Array} tagS @returns {{ ok: true, number: string, key: Uint8Array } | { ok: false }} */
    finish(tagS) {
      if (!d || done) return { ok: false };
      done = true;
      return equalBytes(tagS, d.tagS) ? { ok: true, number: d.number, key: d.key } : { ok: false };
    },
  };
}

/**
 * The showing device's side of ONE session, built when message 1 (Ya) arrives: this is the key
 * evaluation the attempt counter counts. `second` is message 2 (Yb). `confirm(tagT)` verifies the
 * typist's confirmation and ONLY THEN returns the showing device's own tag; a bad tag returns
 * `{ ok: false }` and nothing derived from the key leaves this object. It answers once.
 * Throws on a bad session id or an unusable Ya.
 * @param {{ pw: string, rv: string, route: string, s: string, first: Uint8Array, rng?: (n: number) => Uint8Array, scalar?: bigint }} o
 */
export function showingStart(o) {
  const rng = o.rng || defaultRng;
  const nonce = unb64url(o.s);
  if (!isRendezvous(o.rv) || !isPassword(o.pw) || !nonce || nonce.length !== 16) throw new Error("bad session");
  const sid = sessionId(nonce, o.rv);
  const g = calculateGenerator(utf8(o.pw), CI, sid);
  const y = o.scalar ?? sampleScalar(rng);
  const Ya = o.first;
  const Yb = g.multiply(y).toBytes();
  const K = sharedPoint(y, Ya);
  const tr = transcriptIr(Ya, AD_TYPIST, Yb, adShowing(o.route));
  const d = derive(sid, isk(sid, K, tr), tr);
  let used = false;
  return {
    second: Yb,
    /** @param {Uint8Array} tagT @returns {{ ok: true, tag: Uint8Array, number: string, key: Uint8Array } | { ok: false }} */
    confirm(tagT) {
      if (used) return { ok: false };
      used = true;
      if (!equalBytes(tagT, d.tagT)) return { ok: false };
      return { ok: true, tag: d.tagS, number: d.number, key: d.key };
    },
  };
}

/**
 * The typing device's whole exchange over the relay's `POST /v1/wink/code`: parse what was typed,
 * send message 1, answer with the confirmation, check the showing device's. Resolves
 * `{ ok: true, number, key, route }` (the number to show; the key opens the sealed record), or
 * `{ ok: false, reason }` with one of: `format` (not a code), `busy` (this address is over its
 * limit), `offline` (no answer from the relay) and `refused`, which is the single answer for every
 * other failure (an unknown, closed or expired code, a wrong code, a refusal): it never says which.
 * @param {{ base: string, input: string, fetch?: typeof fetch, rng?: (n: number) => Uint8Array }} o
 * @returns {Promise<{ ok: true, number: string, key: Uint8Array, route: string } | { ok: false, reason: "format" | "busy" | "offline" | "refused" }>}
 */
export async function enterCode(o) {
  const parsed = parseCode(o.input);
  if (!parsed) return { ok: false, reason: "format" };
  const f = o.fetch || globalThis.fetch;
  const url = `${o.base.replace(/\/+$/, "")}/v1/wink/code`;
  /** @param {object} body @returns {Promise<{ m: Uint8Array, route: string } | "busy" | "offline" | "refused">} */
  const post = async body => {
    let res;
    try { res = await f(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); } catch { return "offline"; }
    if (res.status === 429) return "busy";
    if (res.status !== 200) return "refused";
    try {
      const j = await res.json();
      const m = unb64url(String(j.m));
      return m && m.length === 32 && typeof j.route === "string" ? { m, route: j.route } : "refused";
    } catch { return "refused"; }
  };
  const t = typistStart({ pw: parsed.pw, rv: parsed.rv, rng: o.rng });
  const one = await post({ rv: parsed.rv, s: t.s, n: 1, m: b64url(t.first) });
  if (typeof one === "string") return { ok: false, reason: one };
  let confirmation;
  try { confirmation = t.second(one.m, one.route); } catch { return { ok: false, reason: "refused" }; }
  const three = await post({ rv: parsed.rv, s: t.s, n: 3, m: b64url(confirmation) });
  if (typeof three === "string") return { ok: false, reason: three };
  const fin = t.finish(three.m);
  return fin.ok ? { ok: true, number: fin.number, key: fin.key, route: one.route } : { ok: false, reason: "refused" };
}

// ---- the code typed back (DESIGN-wink.md, section 4: pairing is two-sided) ----

const ACK_LABEL = new TextEncoder().encode("vyre-wink-ack-v1");

/**
 * The code the typing device shows after the PAKE and the showing device's person types back: 8 symbols derived from the shared key, so a
 * relay or anyone in the middle (a different key on each side) shows a different code and the typed one does not match. 40 bits of
 * agreement, against the 1-in-3 of a number pick. Shown as WINK-XXXX-XXXX like every other Wink code.
 * @param {Uint8Array} key @returns {string}
 */
export function ackCode(key) {
  const d = hmac512(key, ACK_LABEL);
  let bits = 0, acc = 0, out = "";
  for (const x of d) { acc = (acc << 8) | x; bits += 8; while (bits >= 5 && out.length < 8) { out += ALPHABET[(acc >>> (bits - 5)) & 31]; bits -= 5; } if (out.length >= 8) break; }
  return formatCode(out.slice(0, 2), out.slice(2, 8));
}

/** The typed-back code as 8 folded symbols, or null. @param {string} input */
export function normaliseAck(input) {
  const p = parseCode(input);
  return p ? p.rv + p.pw : null;
}
