// The person session for the app at another origin (app.vyre.run, later the phone): the pure
// pieces, runnable in Node 22 with globalThis.crypto.subtle. The box's side is
// core/presence/person.js on work/e2e.
//
// Same origin (the box serves the app at /app/): the box sets `__Host-vyre_person` after a
// passkey at /person/signin, the browser sends it, and nothing here runs.
//
// Cross origin: PKCE. The app sends the person to `<box>/person/signin?cc=<S256>&return=<app>`,
// gets `?code=` back, and trades {code, verifier, key} at `<box>/v1/person/token` for a token
// `<id>.<secret>`. `key` is the public half of a non-extractable ECDSA P-256 key made once and
// kept (person.web.ts: IndexedDB). It is sent as a public JWK {kty, crv, x, y}: that is what the
// box's exchange() checks. Every request then carries
//   authorization: Vyre <id>.<secret>
//   x-vyre-proof: t=<ms> n=<nonce> sig=<b64url>
// where sig is ES256 in P1363 form (raw r||s, what WebCrypto emits) over
//   METHOD \n path?query \n sha256b64url(body) \n t \n n
// A 401 `person_session_required` forgets the token and signs in again.
//
// The native app (person.native.ts) returns to `vyre://person/signin`. The box binds that code to
// the app, not to an Origin: the trade sends no Origin and carries its own x-vyre-proof, signed by
// the `key` it registers, over `POST\n/v1/person/token\nsha256b64url(body)\nt\nn`. Its body also
// carries `human`, the public JWK of a second, biometric key; the box enrolls it as a presence key
// of kind device and answers `data.human = { key: <id> }`. That key signs the relay sign-in
// (devicePersonStart below). It no longer proves acts: a call that needs the person's yes (pairing,
// a vault secret, a send) is answered with a card or a signed yes (src/real/box.ts), and presence
// sessions are gone (one-yes, 0.3.1).

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("this runtime has no WebCrypto; a person session needs crypto.subtle");
  return s;
}

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url with no padding (RFC 4648 section 5), without btoa or Buffer. */
export function b64url(input: ArrayBuffer | Uint8Array): string {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let out = "";
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63] + ALPHA[(n >> 6) & 63] + ALPHA[n & 63];
  }
  if (i < b.length) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8);
    out += ALPHA[n >> 18] + ALPHA[(n >> 12) & 63];
    if (i + 1 < b.length) out += ALPHA[(n >> 6) & 63];
  }
  return out;
}

/** The bytes of a base64url string (padding and the standard alphabet are accepted too). */
export function fromB64url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw new Error("not base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 255);
    }
  }
  return new Uint8Array(out);
}

/** `n` random bytes as base64url. */
export function randomB64url(n = 32): string {
  return b64url(globalThis.crypto.getRandomValues(new Uint8Array(n)));
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4) in plain JS, for runtimes without crypto.subtle (Hermes on the phone).
 * Hashes a request body per call, so small and plain beats fast.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

/** SHA-256 of the UTF-8 text as base64url: WebCrypto where the runtime has it, sha256() where not. */
export async function sha256b64url(text: string): Promise<string> {
  const s = globalThis.crypto?.subtle;
  return b64url(s ? await s.digest("SHA-256", enc.encode(text)) : sha256(enc.encode(text)));
}

/** The S256 challenge for a verifier (RFC 7636 section 4.2). */
export const challengeFor = (verifier: string): Promise<string> => sha256b64url(verifier);

/** A fresh PKCE pair: a 43-character verifier and its S256 challenge. */
export async function pkce(verifier = randomB64url(32)): Promise<{ verifier: string; challenge: string }> {
  return { verifier, challenge: await challengeFor(verifier) };
}

/** The path and query of a URL, as the box sees it in `url.pathname + url.search`. */
export function pathOf(url: string): string {
  const u = new URL(url, "http://box.invalid");
  return u.pathname + u.search;
}

/**
 * The path and query the box sees for a request, which is what a proof signs. `url` is a path
 * ("/v1/tools/x?y"), or a full URL under `base`, which may carry a prefix of its own (a relay
 * route, "https://relay.example/<route>"): the prefix is the transport's, never signed.
 */
export function boxPath(url: string, base?: string): string {
  const b = base?.replace(/\/+$/, "");
  if (b && url.startsWith(b) && (url.length === b.length || url[b.length] === "/" || url[b.length] === "?")) {
    return pathOf(url.slice(b.length) || "/");
  }
  return pathOf(url);
}

/** The string a request's proof signs. `body` is the raw body sent, "" for none. */
export async function proofMessage(r: { method: string; path: string; body?: string; t: number | string; n: string }): Promise<string> {
  return `${r.method.toUpperCase()}\n${r.path}\n${await sha256b64url(r.body ?? "")}\n${r.t}\n${r.n}`;
}

/** A new ECDSA P-256 pair; the private half cannot be exported, only used to sign. */
export function newKey(): Promise<CryptoKeyPair> {
  return subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as Promise<CryptoKeyPair>;
}

export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string };

/** The public half as the JWK the box's /v1/person/token takes. */
export async function publicJwk(key: CryptoKey): Promise<PublicJwk> {
  const j = await subtle().exportKey("jwk", key);
  return { kty: "EC", crv: "P-256", x: String(j.x), y: String(j.y) };
}

/**
 * Whatever holds the session's private key: WebCrypto in a browser, the Keystore or the Secure
 * Enclave on the phone (person.native.ts). sign() gives ES256 in P1363 form (raw r||s, 64 bytes).
 */
export type Signer = {
  publicJwk(): Promise<PublicJwk>;
  sign(message: string): Promise<Uint8Array>;
};

/** A Signer over a WebCrypto pair. */
export function cryptoKeySigner(k: CryptoKeyPair): Signer {
  return {
    publicJwk: () => publicJwk(k.publicKey),
    sign: async (m) => new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, k.privateKey, enc.encode(m))),
  };
}

/** The `x-vyre-proof` value for one request, signed by any Signer. */
export async function proofWith(
  sign: (message: string) => Promise<Uint8Array>,
  r: { method: string; url: string; base?: string; body?: string; now?: number; nonce?: string },
): Promise<string> {
  const t = r.now ?? Date.now();
  const n = r.nonce ?? randomB64url(16);
  const msg = await proofMessage({ method: r.method, path: boxPath(r.url, r.base), body: r.body, t, n });
  return `t=${t} n=${n} sig=${b64url(await sign(msg))}`;
}

/** The `x-vyre-proof` value for one request, signed with the session's key. */
export function proof(
  key: CryptoKey,
  r: { method: string; url: string; body?: string; now?: number; nonce?: string },
): Promise<string> {
  return proofWith(async (m) => new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(m))), r);
}

/**
 * An ECDSA signature in DER (SEQUENCE { INTEGER r, INTEGER s }, what Android's SHA256withECDSA and
 * Apple's ecdsaSignatureMessageX962SHA256 emit) as P1363: r and s, each left-padded to `size`
 * bytes. DER integers are minimal and signed, so r or s can be 33 bytes (a leading 0x00 before a
 * high bit) or shorter than 32 (leading zero bytes dropped). Throws on anything malformed.
 */
export function derToP1363(der: Uint8Array, size = 32): Uint8Array {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`not a DER ECDSA signature: ${why}`);
  };
  const byte = () => (i < der.length ? der[i++] : fail("it ends early"));
  const length = () => {
    const first = byte();
    if (first < 0x80) return first;
    const n = first & 0x7f;
    if (n < 1 || n > 2) fail("bad length");
    let l = 0;
    for (let k = 0; k < n; k++) l = (l << 8) | byte();
    return l;
  };
  const integer = () => {
    if (byte() !== 0x02) fail("no INTEGER");
    const l = length();
    if (l < 1 || i + l > der.length) fail("bad INTEGER length");
    let v = der.subarray(i, i + l);
    i += l;
    if (v[0] & 0x80) fail("a negative INTEGER");
    while (v.length > 1 && v[0] === 0) v = v.subarray(1);
    if (v.length > size) fail(`an INTEGER longer than ${size} bytes`);
    return v;
  };
  if (byte() !== 0x30) fail("no SEQUENCE");
  if (length() !== der.length - i) fail("the SEQUENCE length is wrong");
  const r = integer();
  const s = integer();
  if (i !== der.length) fail("bytes after s");
  const out = new Uint8Array(size * 2);
  out.set(r, size - r.length);
  out.set(s, size * 2 - s.length);
  return out;
}

const SPKI_P256 = fromHexPrefix("3059301306072a8648ce3d020106082a8648ce3d030107034200");

function fromHexPrefix(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * A P-256 public key as base64url SPKI DER, what presence.enroll takes as `public_key` (alg -7),
 * from the point's base64url x and y (32 bytes each; vyre-signer's ensureKey gives these).
 */
export function spkiFromXY(x: string, y: string): string {
  const bx = fromB64url(x);
  const by = fromB64url(y);
  if (bx.length !== 32 || by.length !== 32) throw new Error("x and y must be 32-byte base64url coordinates");
  const out = new Uint8Array(SPKI_P256.length + 65);
  out.set(SPKI_P256);
  out[SPKI_P256.length] = 4;
  out.set(bx, SPKI_P256.length + 1);
  out.set(by, SPKI_P256.length + 33);
  return b64url(out);
}

/** The public JWK the box takes, from a P-256 point's base64url x and y (32 bytes each). */
export function jwkFromXY(x: string, y: string): PublicJwk {
  if (fromB64url(x).length !== 32 || fromB64url(y).length !== 32) throw new Error("x and y must be 32-byte base64url coordinates");
  return { kty: "EC", crv: "P-256", x, y };
}

/**
 * A P-256 key's presence key id on the box: the first 22 characters of the base64url SHA-256 of
 * its SPKI DER (core/presence/index.js fingerprint). The box enrolls a key once; a second sign-in
 * with the same biometric key is answered "already enrolled", and this is the id it already has.
 */
export function keyIdFromXY(x: string, y: string): string {
  return b64url(sha256(fromB64url(spkiFromXY(x, y)))).slice(0, 22);
}

/**
 * JSON with object keys sorted at every depth and no spaces: what a presence proof's input hash
 * is taken over. The box's canonical() in core/presence/index.js, line for line, so the two agree
 * on every input (undefined and functions dropped from objects, null in arrays).
 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined || typeof x === "function" ? "null" : canonical(x))).join(",") + "]";
  if (v && typeof v === "object" && typeof (v as { toJSON?: unknown }).toJSON !== "function") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

/** base64url SHA-256 of the canonical input: what binds a presence proof to one call's input. */
export const inputHash = (input: unknown): Promise<string> => sha256b64url(canonical(input));

/** The bytes (as UTF-8 text) a device or Capsule presence proof signs. */
export const presenceMessage = (tool: string, hash: string, ts: number | string, nonce: string): string =>
  `vyre-presence-v1\n${tool}\n${hash}\n${ts}\n${nonce}`;

/** The tool a `/v1/tools/<name>` URL calls, or null for any other path. */
export function toolOf(url: string): string | null {
  const m = /^\/v1\/tools\/([^/?#]+)/.exec(pathOf(url));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Where a person session keeps its two things. load() gives null when there is none. */
export type Slot<T> = { load(): Promise<T | null>; save(v: T | null): Promise<void> };
/** `key` holds a WebCrypto pair; a runtime with its own key store passes personSession a signer instead. */
export type PersonStores = { key?: Slot<CryptoKeyPair>; token: Slot<string> };

/** A Slot in memory, for tests and for runtimes with nowhere durable to keep it. */
export function memorySlot<T>(initial: T | null = null): Slot<T> {
  let v = initial;
  return { load: async () => v, save: async (n) => void (v = n) };
}

export type PersonSession = {
  /**
   * The headers for one request: none until signed in. `url` is the path and query relative to
   * the box ("/v1/tools/x"), or a full URL at the box's origin. `proved`: the caller brings its
   * own x-vyre-presence, so no presence proof is made here (no prompt).
   */
  headers(method: string, url: string, body: string, proved?: boolean): Promise<Record<string, string>>;
  /** A tool call's answer (the phone's presence); true: send the same call once more, now. */
  answered?(method: string, url: string, body: string, result: { error?: { code: string; message?: string } }): boolean | Promise<boolean>;
  /** The box answered person_session_required: forget the token and sign in again. */
  required(): void;
  /** Trade the sign-in page's code and our verifier for a token. */
  exchange(code: string, verifier: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * Keep a token your home answered some other way (the phone's device sign-in over the relay) for
   * `path`, the current one when left out.
   */
  adopt(token: string, path?: string): Promise<boolean>;
  /** Sign out: end the session on the box and forget the token (every path's). */
  end(): Promise<void>;
  /** A token is kept for the current path. */
  signedIn(): Promise<boolean>;
};

const TOKEN = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{16,128}$/;

/**
 * The token slot's text as one token per path. A single token from before tokens were kept per
 * path was made by the PKCE hop, which only the direct path runs, so it becomes the direct one.
 */
export function readTokens(v: string | null | undefined): Record<string, string> {
  if (!v) return {};
  if (TOKEN.test(v)) return { direct: v };
  const out: Record<string, string> = {};
  try {
    const j = JSON.parse(v) as unknown;
    if (j && typeof j === "object" && !Array.isArray(j)) {
      for (const [k, t] of Object.entries(j as Record<string, unknown>)) if (typeof t === "string" && TOKEN.test(t)) out[k] = t;
    }
  } catch {}
  return out;
}

/**
 * The person session for one box at another origin.
 * @param o.box the box's origin, e.g. "https://juniper.example.ts.net"
 * @param o.signIn starts the sign-in hop (person.web.ts redirects); called on a 401
 * @param o.signer the key, where it is not a WebCrypto pair in stores.key (the phone)
 * @param o.nonce a fresh proof nonce, where globalThis.crypto.getRandomValues is missing (Hermes)
 * @param o.more headers added to a signed request
 * @param o.answered hears each tool call's answer; true asks the client to send it once more now
 * @param o.trade fields added to the /v1/person/token body, e.g. the phone's biometric public key
 * @param o.signTrade sign the trade itself with the key it registers (the native app's code)
 * @param o.traded hears the trade's `data` once a token is stored (the phone keeps `human.key`)
 * @param o.path which way the box is reached now ("direct", "relay"): the box pins a token to the
 *   path's identity (the tailnet node, or the relay device), so the store then keeps one per path,
 *   as a JSON map in the one slot
 * @param o.send a fetch of a box path over the current path (the phone's relay), for sign-out
 */
export function personSession(o: {
  box: string;
  stores: PersonStores;
  signIn: () => void;
  signer?: Signer;
  nonce?: () => string;
  more?: (method: string, url: string, body: string) => Promise<Record<string, string>>;
  answered?: (method: string, url: string, body: string, result: { error?: { code: string; message?: string } }) => boolean | Promise<boolean>;
  trade?: () => Promise<Record<string, unknown>>;
  signTrade?: boolean;
  traded?: (data: Record<string, unknown>) => Promise<void> | void;
  fetch?: typeof fetch;
  now?: () => number;
  path?: () => string;
  send?: (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number }>;
}): PersonSession {
  const box = o.box.replace(/\/+$/, "");
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const now = o.now ?? Date.now;
  let keyP: Promise<Signer> | null = null;
  let token: Promise<string | null> | null = null;

  const key = () =>
    (keyP ??= (async () => {
      if (o.signer) return o.signer;
      const slot = o.stores.key;
      if (!slot) throw new Error("a person session needs stores.key or a signer");
      const k = await slot.load();
      if (k) return cryptoKeySigner(k);
      const made = await newKey();
      await slot.save(made);
      return cryptoKeySigner(made);
    })().catch((e) => {
      keyP = null;
      throw e;
    }));
  const currentToken = o.path
    ? async () => (await tokens())[(o.path as () => string)()] ?? null
    : () => (token ??= o.stores.token.load().then((t) => (t && TOKEN.test(t) ? t : null)));
  let all: Promise<Record<string, string>> | null = null;
  const tokens = () => (all ??= o.stores.token.load().then(readTokens, (): Record<string, string> => ({})));
  /** Keep (or drop, null) the token for `at`, the current path by default; `every` drops them all. */
  const setToken = async (t: string | null, at?: string, every = false) => {
    if (!o.path) {
      token = Promise.resolve(t);
      await o.stores.token.save(t);
      return;
    }
    const where = at ?? o.path();
    // The new map is current at once, so a read right after a save (even an unawaited one) sees it.
    const next = tokens().then((was) => {
      const m: Record<string, string> = every ? {} : { ...was };
      if (!every) {
        if (t) m[where] = t;
        else delete m[where];
      }
      return m;
    });
    all = next;
    const m = await next;
    await o.stores.token.save(Object.keys(m).length ? JSON.stringify(m) : null);
  };

  async function headers(method: string, url: string, body: string, proved = false): Promise<Record<string, string>> {
    const t = await currentToken();
    if (!t) return {};
    let signed: Record<string, string>;
    try {
      const k = await key();
      signed = { authorization: `Vyre ${t}`, "x-vyre-proof": await proofWith(k.sign, { method, url, base: box, body, now: now(), nonce: o.nonce?.() }) };
    } catch {
      // The key is gone or refuses (a phone's keystore cleared, a browser's store wiped): the token
      // is worthless without it, so sign in again rather than stall every request on a throw.
      await setToken(null).catch(() => {});
      keyP = null;
      o.signIn();
      return {};
    }
    return o.more && !proved ? { ...(await o.more(method, url, body)), ...signed } : signed;
  }

  return {
    headers,
    ...(o.answered ? { answered: o.answered } : {}),
    required() {
      void setToken(null).catch(() => {});
      o.signIn();
    },
    async exchange(code, verifier) {
      const k = await key();
      const pub = await k.publicJwk();
      const extra = o.trade ? await o.trade() : {};
      // The biometric key must be a second key: the box refuses a `human` equal to `key`, or with `d`.
      const h = extra.human as Partial<PublicJwk> & { d?: unknown } | undefined;
      if (h && (typeof h !== "object" || h.d !== undefined || (h.x === pub.x && h.y === pub.y))) delete extra.human;
      const body = JSON.stringify({ ...extra, code, verifier, key: pub });
      const headers: Record<string, string> = { "content-type": "application/json" };
      let res: Response;
      try {
        if (o.signTrade) headers["x-vyre-proof"] = await proofWith(k.sign, { method: "POST", url: "/v1/person/token", body, now: now(), nonce: o.nonce?.() });
        res = await doFetch(`${box}/v1/person/token`, { method: "POST", headers, body, cache: "no-store" });
      } catch (e) {
        return { ok: false, code: "unreachable", message: e instanceof Error ? e.message : "your home is out of reach" };
      }
      const b = (await res.json().catch(() => null)) as { data?: { token?: string } & Record<string, unknown>; error?: { code: string; message: string } } | null;
      const t = b?.data?.token;
      if (!t || !TOKEN.test(t)) return { ok: false, code: b?.error?.code ?? "bad_response", message: b?.error?.message ?? `your home answered ${res.status}` };
      // The trade goes straight to the box's address, so its token is the direct path's.
      await setToken(t, o.path ? "direct" : undefined);
      if (o.traded && b?.data) await Promise.resolve(o.traded(b.data)).catch(() => {});
      return { ok: true };
    },
    async adopt(t, at) {
      if (!TOKEN.test(t)) return false;
      await setToken(t, at);
      return true;
    },
    async end() {
      const url = `${box}/v1/person/end`;
      const h = await headers("POST", url, "");
      await setToken(null, undefined, true);
      if (!h.authorization) return;
      if (o.send) await o.send("/v1/person/end", { method: "POST", headers: h }).catch(() => {});
      else await doFetch(url, { method: "POST", headers: h, cache: "no-store" }).catch(() => {});
    },
    signedIn: async () => Boolean(await currentToken()),
  };
}

/** After the person closes a sign-in prompt, the same sign-in is not started again on its own for this long. */
export const DECLINED_MS = 60_000;

/** The tool a phone calls over the relay to sign in with its enrolled biometric key. */
export const PERSON_START = "presence.person.start";

export type StartResult = { ok: true; token: string; expires?: number } | { ok: false; code: string; message: string };

/**
 * Sign in over the relay, with no browser: the box knows the phone there as its relay device, and
 * the biometric key (vyre.human) was enrolled at pairing. One call,
 *   POST /v1/tools/presence.person.start   {key: <the person key's public JWK>}
 *   x-vyre-presence: device key=<id> ts=<ms> nonce=<b64url> sig=<b64url DER>
 * over `vyre-presence-v1\npresence.person.start\n<inputHash of {key}>\n<ts>\n<nonce>`, signed by
 * the biometric key (one prompt). The box answers {kind: "bearer", id, token, expires}; the token
 * then rides as `authorization: Vyre <token>` with x-vyre-proof, as on the tailnet, pinned to the
 * relay device. A closed prompt answers code "declined" and sends nothing.
 */
export async function devicePersonStart(o: {
  /** The person key (vyre.person): its public JWK is what the token is bound to. */
  signer: Pick<Signer, "publicJwk">;
  /** The biometric key's presence key id (keyIdFromXY), or null when there is none. */
  keyId: () => Promise<string | null>;
  /** DER signature as base64url over the message, by the biometric key (the platform prompts). */
  sign: (message: string) => Promise<string>;
  nonce: () => string;
  now?: () => number;
  /** A fetch of a box path over the relay. */
  send: (path: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
}): Promise<StartResult> {
  let key: PublicJwk;
  let id: string | null;
  try {
    key = await o.signer.publicJwk();
    id = await o.keyId();
  } catch (e) {
    return { ok: false, code: "no_key", message: e instanceof Error ? e.message : "the phone's key is out of reach" };
  }
  if (!id) return { ok: false, code: "no_key", message: "this phone has no biometric key enrolled on your home; pair it again" };
  const input = { key };
  const body = JSON.stringify(input);
  const ts = (o.now ?? Date.now)();
  const nonce = o.nonce();
  let sig: string;
  try {
    sig = await o.sign(presenceMessage(PERSON_START, await inputHash(input), ts, nonce));
  } catch (e) {
    return { ok: false, code: "declined", message: e instanceof Error ? e.message : "the prompt was closed" };
  }
  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await o.send(`/v1/tools/${PERSON_START}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vyre-presence": `device key=${id} ts=${ts} nonce=${nonce} sig=${sig}` },
      body,
    });
  } catch (e) {
    return { ok: false, code: "unreachable", message: e instanceof Error ? e.message : "your home is out of reach" };
  }
  const b = (await res.json().catch(() => null)) as { data?: Record<string, unknown>; error?: { code: string; message: string } } | null;
  const d = (b && typeof b === "object" && b.data && typeof b.data === "object" ? b.data : b) as Record<string, unknown> | null;
  const t = typeof d?.token === "string" ? d.token : "";
  // The token is `<id>.<secret>`; an answer that splits the two is joined here.
  const token = TOKEN.test(t) ? t : typeof d?.id === "string" && TOKEN.test(`${d.id}.${t}`) ? `${d.id}.${t}` : "";
  if (!token || (d?.kind !== undefined && d.kind !== "bearer")) {
    return { ok: false, code: b?.error?.code ?? "bad_response", message: b?.error?.message ?? `your home answered ${res.status}` };
  }
  return { ok: true, token, ...(typeof d?.expires === "number" ? { expires: d.expires } : {}) };
}

/** After a failed relay sign-in (not a closed prompt), it is not started again on its own for this long. */
const RELAY_QUIET_MS = 30_000;

/**
 * Which sign-in runs, by path: the direct path keeps the PKCE hop through the browser, the relay
 * signs in with the device flow above. The relay one prompts only when asked (a 401
 * person_session_required, or signIn()) and no token is live for the relay; several asks at once
 * share one prompt; a closed prompt is not shown again on its own for DECLINED_MS, a failed one
 * for 30 s. A forced sign-in (the person asked for it) goes regardless.
 */
export function pathSignIn(o: {
  path: () => string;
  /** Today's PKCE hop; resolves true once a token is stored. */
  direct: (force: boolean) => Promise<boolean>;
  relay: () => Promise<StartResult>;
  session: Pick<PersonSession, "adopt" | "signedIn">;
  onSignedIn?: (ok: boolean) => void;
  now?: () => number;
}): (opts?: { force?: boolean }) => Promise<boolean> {
  const now = o.now ?? Date.now;
  let running: Promise<boolean> | null = null;
  let quiet: { until: number } | null = null;
  return async ({ force = false } = {}) => {
    if (o.path() !== "relay") return o.direct(force);
    if (running) return running;
    if (!force && quiet && now() < quiet.until) return false;
    running = (async () => {
      if (!force && (await o.session.signedIn())) return true;
      const r = await o.relay();
      const ok = r.ok && (await o.session.adopt(r.token, "relay"));
      quiet = ok ? null : { until: now() + (!r.ok && r.code === "declined" ? DECLINED_MS : RELAY_QUIET_MS) };
      o.onSignedIn?.(ok);
      return ok;
    })()
      .catch(() => {
        quiet = { until: now() + RELAY_QUIET_MS };
        o.onSignedIn?.(false);
        return false;
      })
      .finally(() => {
        running = null;
      });
    return running;
  };
}
