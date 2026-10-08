// @ts-check
// setup: the setup page's half of the setup session over the relay (tailnet plan 3.6 and 3.6b).
// Runs in a browser (WebCrypto) and in Node 22+. The box's half is core/relay/setup.js and
// core/relay/wire.js, which these functions match byte for byte (setup.test.js checks it).
//
//   1. createSetupKey()        a non-extractable P-256 key, made before the install line is shown.
//   2. setupCode(secret, spki)  C = base64url(secret16 || fp16): what VYRE_SETUP_CODE carries.
//   3. resolveSetup(secret)     the same /v1/pair a phone uses, for the box's sealed offer.
//   4. setupHello(...)          the signed hello the box admits only for this key.
//   5. setupWords(...)          the four check words to show beside "Found your server".
//   6. mailboxReader(...)       the install script's progress lines: long poll, HMAC, sequence, plain text.
//
// Nothing here is shown to the person as advice: every fix on the page comes from a catalog keyed
// by an error code, never from mailbox text (plan 3.6).

import { base64url, fromBase64url, concat, utf8, equal } from "./bytes.js";
import { resolveTicket } from "./client.js";
import { WORDS } from "./words.js";

const TAG = { key: "vyre-setup-key", hello: "vyre-setup-hello", read: "vyre-setup-read", words: "vyre-setup-words",
  loc: "vyre-pair-loc", sec: "vyre-pair-sec", mac: "vyre-pair-mac", enc: "vyre-pair-enc",
  mbxw: "vyre-setup-mbx-w", mbxenc: "vyre-setup-mbx-enc", mbxmac: "vyre-setup-mbx-mac" };
export const SETUP_CODE_LEN = 43;
const fail = (code, message) => Object.assign(new Error(message), { code });
const getSubtle = o => (o && o.subtle) || globalThis.crypto?.subtle;

/** @param {SubtleCrypto} subtle @param {Uint8Array} bytes */
const sha256 = async (subtle, bytes) => new Uint8Array(await subtle.digest("SHA-256", bytes));

/**
 * The page key (condition 1): P-256, private half NON-EXTRACTABLE, so not even this page's own
 * script can copy it out. The public half is its SPKI.
 * @param {{ subtle?: SubtleCrypto }} [o] @returns {Promise<{ privateKey: CryptoKey, spki: Uint8Array }>}
 */
export async function createSetupKey(o) {
  const subtle = getSubtle(o);
  const kp = /** @type {CryptoKeyPair} */ (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
  return { privateKey: kp.privateKey, spki: new Uint8Array(await subtle.exportKey("spki", kp.publicKey)) };
}

/** sha256("vyre-setup-key\n" || SPKI)[0:16]. @param {Uint8Array} spki @param {{ subtle?: SubtleCrypto }} [o] */
export async function setupFingerprint(spki, o) {
  const subtle = getSubtle(o);
  return (await sha256(subtle, concat(utf8(`${TAG.key}\n`), spki))).slice(0, 16);
}

/** C = base64url(secret16 || fp16), 43 characters. @param {Uint8Array} secret @param {Uint8Array} spki @param {{ subtle?: SubtleCrypto }} [o] */
export async function setupCode(secret, spki, o) {
  if (secret.length !== 16) throw fail("bad_input", "a setup secret is 16 bytes");
  return base64url(concat(secret, await setupFingerprint(spki, o)));
}

/** @param {string} code @returns {{ secret: Uint8Array, fp: Uint8Array } | null} */
export function parseSetupCode(code) {
  if (typeof code !== "string" || code.length !== SETUP_CODE_LEN || !/^[A-Za-z0-9_-]+$/.test(code)) return null;
  let b;
  try { b = fromBase64url(code); } catch { return null; }
  if (b.length !== 32 || base64url(b) !== code) return null;
  return { secret: b.slice(0, 16), fp: b.slice(16) };
}

/**
 * Everything derived from secret16 alone (core/relay/wire.js setupDerive), as bytes: the relay
 * sees `loc` and `mbxw` (never the rest), the offer's MAC and seal keys, the pairing secret, and
 * the mailbox's cipher and MAC keys.
 * @param {Uint8Array} secret @param {{ subtle?: SubtleCrypto }} [o]
 */
export async function setupDerive(secret, o) {
  const subtle = getSubtle(o);
  const d = which => sha256(subtle, concat(utf8(`${TAG[which]}\n`), secret));
  return { loc: await d("loc"), sec: await d("sec"), mac: await d("mac"), enc: await d("enc"),
    mbxw: await d("mbxw"), mbxenc: await d("mbxenc"), mbxmac: await d("mbxmac") };
}

/**
 * The box's sealed offer: the same lookup a phone does for a Wink ticket, with secret16 in the
 * ticket's place. Verifies the record's MAC and opens it; a 409 from the relay throws code
 * "contested" (two servers used this code).
 * @param {Uint8Array} secret @param {Parameters<typeof resolveTicket>[1]} o
 */
export const resolveSetup = (secret, o) => resolveTicket(secret, o);

/**
 * The hello the box admits (condition 2): `setup.key` is the SPKI, `setup.sig` an ECDSA P-256
 * signature (r || s) over "vyre-setup-hello\n" || route || "\n" || the Noise static key this
 * handshake uses, so a hello captured off the wire cannot be replayed from another Noise key.
 * `pair` (the pairing secret) rides along on the first connection only.
 * @param {{ privateKey: CryptoKey, spki: Uint8Array, route: string, noiseStatic: Uint8Array, secret?: Uint8Array, name?: string }} o
 * @param {{ subtle?: SubtleCrypto }} [c]
 */
export async function setupHello(o, c) {
  const subtle = getSubtle(c);
  const msg = concat(utf8(`${TAG.hello}\n${o.route}\n`), o.noiseStatic);
  const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.privateKey, msg));
  const hello = { v: 1, name: o.name || "setup page", setup: { key: base64url(o.spki), sig: base64url(sig) } };
  if (o.secret) hello.pair = base64url((await setupDerive(o.secret, c)).sec);
  return hello;
}

/** Four words from sha256("vyre-setup-words\n" || box static key || secret), the same as the box prints. @param {Uint8Array} boxStatic @param {Uint8Array} secret @param {{ subtle?: SubtleCrypto }} [o] */
export async function setupWords(boxStatic, secret, o) {
  const subtle = getSubtle(o);
  const h = await sha256(subtle, concat(utf8(`${TAG.words}\n`), boxStatic, secret));
  let bits = 0;
  for (let i = 0; i < 6; i++) bits = bits * 256 + h[i];
  return [0, 1, 2, 3].map(i => WORDS[Math.floor(bits / 2 ** (37 - 11 * i)) % 2048]);
}

/** What the mailbox reader signs: the page key over "vyre-setup-read\nloc\nts\nafter". @param {string} loc @param {number} ts @param {number} after */
const readMessage = (loc, ts, after) => utf8(`${TAG.read}\n${loc}\n${ts}\n${after}`);

// A line is base64url(iv16 || AES-256-CTR ciphertext || HMAC-SHA256 32) with the HMAC over
// seq (u32 big-endian) || iv || ciphertext (core/relay/wire.js mbxSeal). CTR counts the whole
// 128-bit block from the IV, as openssl enc does, hence length 128.
const seqBytes = seq => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, seq); return b; };
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
/** Plain text and nothing else: no control characters, no bidi or zero-width marks, one line's worth. @param {string} s */
export const plainText = s => String(s).replace(UNSAFE, "").slice(0, 1024);

/**
 * Open line number `seq`, or null when any byte is wrong or it belongs at another position.
 * @param {{ mbxenc: Uint8Array, mbxmac: Uint8Array }} keys @param {number} seq @param {string} line @param {{ subtle?: SubtleCrypto }} [o]
 */
export async function openMailboxLine(keys, seq, line, o) {
  const subtle = getSubtle(o);
  let b;
  try { b = fromBase64url(String(line)); } catch { return null; }
  if (b.length < 48) return null;
  const iv = b.slice(0, 16), ct = b.slice(16, -32), mac = b.slice(-32);
  const hk = await subtle.importKey("raw", keys.mbxmac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = new Uint8Array(await subtle.sign("HMAC", hk, concat(seqBytes(seq), iv, ct)));
  if (!equal(mac, want)) return null;
  const ck = await subtle.importKey("raw", keys.mbxenc, { name: "AES-CTR" }, false, ["decrypt"]);
  return plainText(new TextDecoder().decode(new Uint8Array(await subtle.decrypt({ name: "AES-CTR", counter: iv, length: 128 }, ck, ct))));
}

/**
 * The install script's progress, read from the relay mailbox with a long poll. Only this page's
 * key may read: each request carries the SPKI and a fresh signature naming this locator and read
 * position (relay/worker/index.js onSetupMbx). Lines are checked as they arrive: each one's HMAC
 * covers its own sequence number, and the relay must hand them over in order, so a dropped, moved
 * or replayed line stops the reader with code "bad_line" or "out_of_order". A contested locator
 * throws "contested"; a key the relay does not accept throws "unauthorized".
 * @param {{ relay: string, secret: Uint8Array, key: { privateKey: CryptoKey, spki: Uint8Array }, fetch?: typeof fetch, subtle?: SubtleCrypto, now?: () => number, wait?: number }} o
 */
export async function mailboxReader(o) {
  const subtle = getSubtle(o);
  const fetchFn = o.fetch || globalThis.fetch;
  const keys = await setupDerive(o.secret, o);
  const loc = base64url(keys.loc);
  const base = String(o.relay).replace(/\/+$/, "").replace(/^ws/, "http");
  const now = o.now || Date.now;
  let seq = 0;
  return {
    get seq() { return seq; },
    /**
     * One long poll. Resolves with the plain-text lines that arrived (possibly none, after `wait`
     * seconds with nothing new).
     * @param {number} [wait] @returns {Promise<string[]>}
     */
    async next(wait = o.wait ?? 20) {
      const ts = now();
      const sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, o.key.privateKey, readMessage(loc, ts, seq)));
      const res = await fetchFn(`${base}/v1/setup/mbx?loc=${loc}&after=${seq}&wait=${wait}`, {
        headers: { "x-vyre-setup-key": base64url(o.key.spki), "x-vyre-setup-ts": String(ts), "x-vyre-setup-sig": base64url(sig) },
      });
      if (res.status === 409) throw fail("contested", "two servers used this code; start again");
      if (res.status === 401) throw fail("unauthorized", "the relay would not give this page the progress lines");
      if (res.status === 429) throw fail("rate_limited", "too many setup requests; wait a minute");
      if (!res.ok) throw fail("mailbox_failed", `the relay would not answer (${res.status})`);
      const body = /** @type {any} */ (await res.json());
      const out = [];
      for (const item of Array.isArray(body.lines) ? body.lines : []) {
        if (!item || item.i !== seq) throw fail("out_of_order", "the relay's progress lines are out of order; start again");
        const text = await openMailboxLine(keys, seq, String(item.line), o);
        if (text === null) throw fail("bad_line", "a progress line did not check out; start again");
        out.push(text);
        seq++;
      }
      return out;
    },
  };
}
