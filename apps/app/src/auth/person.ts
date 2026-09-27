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
// of kind device and answers `data.human = { key: <id> }`. HUMAN_ONLY calls then carry
//   x-vyre-presence: device key=<id> ts=<ms> nonce=<b64url> sig=<b64url DER>
// over `vyre-presence-v1\n<tool>\n<inputHash>\n<ts>\n<nonce>` (devicePresence below), with
// `x-vyre-presence-keep: 1`, and the 30-minute session the box answers with covers the
// SESSIONABLE calls after it with no prompt.

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

/**
 * The box's floor list (core/presence/index.js HUMAN_ONLY), mirrored so the phone knows which
 * calls to sign with the biometric key. person.test.js checks it against the box's list.
 */
export const HUMAN_ONLY = new Set([
  "gate.approve",
  "vault.put", "vault.approve", "vault.unlock", "vault.offboard", "vault.inject", "vault.totp",
  "vault.backup", "vault.restore", "vault.delete", "vault.device.code", "vault.device.unlock",
  "vault.unlock-passphrase", "vault.reveal", "vault.copy", "vault.resolve", "vault.render",
  "vault.session.open", "vault.export", "vault.kit",
  "learn.skill-install",
  "link.pair.approve",
  "presence.enroll", "presence.remove", "presence.code", "presence.session.open",
  "files.drive.share", "files.drive.unshare",
  "network.guests.add", "network.guests.remove", "network.guests.enable",
  "hooks.enable", "hooks.open", "hooks.close",
  "computers.tailnet.set", "computers.egress.set",
]);

/**
 * Tools a presence session may prove (core/presence/index.js SESSIONABLE, mirrored and checked
 * against it). The box also asks the tool per input, so an item that asks every time refuses a
 * session and the call goes again with its own proof.
 */
export const SESSIONABLE = new Set(["vault.reveal", "vault.copy", "vault.totp", "vault.approve", "vault.grant", "gate.approve", "apps.send"]);

/**
 * HUMAN_ONLY tools that ask only for some inputs (core/presence/index.js NARROWABLE): gate.approve
 * asks only for what goes out as the person. These go without a prompt first, and prompt only
 * when the box answers presence_required (the no-nag rule).
 */
export const NARROWABLE = new Set(["gate.approve"]);

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
  /** Sign out: end the session on the box and forget the token. */
  end(): Promise<void>;
  signedIn(): Promise<boolean>;
};

const TOKEN = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{16,128}$/;

/**
 * The person session for one box at another origin.
 * @param o.box the box's origin, e.g. "https://harlow.example.ts.net"
 * @param o.signIn starts the sign-in hop (person.web.ts redirects); called on a 401
 * @param o.signer the key, where it is not a WebCrypto pair in stores.key (the phone)
 * @param o.nonce a fresh proof nonce, where globalThis.crypto.getRandomValues is missing (Hermes)
 * @param o.more headers added to a signed request, e.g. the phone's presence proof on HUMAN_ONLY calls
 * @param o.answered hears each tool call's answer; true asks the client to send it once more now
 * @param o.trade fields added to the /v1/person/token body, e.g. the phone's biometric public key
 * @param o.signTrade sign the trade itself with the key it registers (the native app's code)
 * @param o.traded hears the trade's `data` once a token is stored (the phone keeps `human.key`)
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
  const currentToken = () => (token ??= o.stores.token.load().then((t) => (t && TOKEN.test(t) ? t : null)));
  const setToken = async (t: string | null) => {
    token = Promise.resolve(t);
    await o.stores.token.save(t);
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
        return { ok: false, code: "unreachable", message: e instanceof Error ? e.message : "the box is out of reach" };
      }
      const b = (await res.json().catch(() => null)) as { data?: { token?: string } & Record<string, unknown>; error?: { code: string; message: string } } | null;
      const t = b?.data?.token;
      if (!t || !TOKEN.test(t)) return { ok: false, code: b?.error?.code ?? "bad_response", message: b?.error?.message ?? `the box answered ${res.status}` };
      await setToken(t);
      if (o.traded && b?.data) await Promise.resolve(o.traded(b.data)).catch(() => {});
      return { ok: true };
    },
    async end() {
      const url = `${box}/v1/person/end`;
      const h = await headers("POST", url, "");
      await setToken(null);
      if (!h.authorization) return;
      await doFetch(url, { method: "POST", headers: h, cache: "no-store" }).catch(() => {});
    },
    signedIn: async () => Boolean(await currentToken()),
  };
}

/** A presence session the box opened for this device: `x-vyre-presence-session`'s fields. */
export type PresenceSession = { id: string; secret: string; expires: number };

/** `session id=.. secret=.. expires=..` (the answer header), or null for anything else. */
export function parsePresenceSession(h: string | null | undefined): PresenceSession | null {
  const m = /^session id=([A-Za-z0-9_-]{8,128}) secret=([A-Za-z0-9_-]{16,128}) expires=(\d{1,16})$/.exec(String(h ?? "").trim());
  return m ? { id: m[1], secret: m[2], expires: Number(m[3]) } : null;
}

export type DevicePresence = {
  /** The presence headers for one tool call with this exact body: none, a session, or a signed proof. */
  headers(tool: string, body: string): Promise<Record<string, string>>;
  /** The call's answer. True: it was refused for presence and a proof not yet tried can go now. */
  answered(tool: string, body: string, result: { error?: { code: string; message?: string } }): boolean;
  /** The box's `x-vyre-presence-session` answer header: kept until it expires. */
  keep(header: string | null | undefined): Promise<void>;
  /** Drop the session (signing out). */
  forget(): Promise<void>;
  /** The live session, or null. */
  session(): Promise<PresenceSession | null>;
};

/** A session this close to its end is treated as ended: the box's clock and ours differ a little. */
const SESSION_MARGIN = 10_000;
/** How long the answers "this call asks for presence" and "this item needs its own proof" are kept. */
const REMEMBER_MS = 10 * 60_000;
/** After the person closes the prompt, the same call does not ask again for this long. */
export const DECLINED_MS = 60_000;

/**
 * Presence on a device with an enrolled key (the phone's vyre.human). What goes with a call:
 *   - a live presence session, when the tool is SESSIONABLE and the box has not said the item
 *     needs its own proof: `session id=.. secret=..`, no prompt
 *   - else, for a HUMAN_ONLY tool (a NARROWABLE one only once the box asked), or any call the box
 *     answered presence_required: a proof signed by the key (the platform prompts), with
 *     `x-vyre-presence-keep: 1` so the box opens a session on it
 *   - else nothing
 * `sign` gets the exact message and returns the DER signature as base64url, which the box's device
 * method verifies as is (dsaEncoding "der").
 */
export function devicePresence(o: {
  keyId: () => Promise<string | null>;
  sign: (message: string, tool: string) => Promise<string>;
  nonce: () => string;
  store?: Slot<string>;
  now?: () => number;
  /** The key refused to sign (closed, gone, invalidated): the platform's error. */
  failed?: (e: unknown) => void;
  /** The box says the key is not enrolled (removed in Settings). */
  lost?: () => void;
  /**
   * Which way the box is reached now ("direct", "relay"). The box pins a presence session to the
   * path's identity (the tailnet node, or the relay device), so the phone keeps one per path.
   */
  path?: () => string;
}): DevicePresence {
  const now = o.now ?? Date.now;
  const pathOf = o.path ?? (() => "box");
  let current: Promise<Record<string, PresenceSession>> | null = null;
  /** What the last attempt of each call carried. */
  const sent = new Map<string, "none" | "session" | "device" | "declined">();
  /** Calls the box said ask for presence, and items it said need their own proof, with until when. */
  const asks = new Map<string, number>();
  const own = new Map<string, number>();
  const declined = new Map<string, number>();

  const idOf = (tool: string, body: string) => `${tool}\n${body}`;
  const live = (m: Map<string, number>, id: string, ttl: number) => {
    const at = m.get(id);
    if (at === undefined) return false;
    if (now() - at < ttl) return true;
    m.delete(id);
    return false;
  };
  const valid = (p: unknown): p is PresenceSession =>
    !!p && typeof (p as PresenceSession).id === "string" && typeof (p as PresenceSession).secret === "string" && typeof (p as PresenceSession).expires === "number";
  const load = () =>
    (current ??= (o.store ? o.store.load() : Promise.resolve(null)).then((v) => {
      const out: Record<string, PresenceSession> = {};
      if (!v) return out;
      try {
        const j = JSON.parse(v) as Record<string, unknown>;
        // An older single session (before sessions were kept per path) is dropped: one prompt.
        if (!valid(j)) for (const [k, p] of Object.entries(j)) if (valid(p)) out[k] = p;
      } catch {}
      return out;
    }, (): Record<string, PresenceSession> => ({})));
  const save = async (p: PresenceSession | null, all = false) => {
    // The new map is current at once, so a read right after a save (even an unawaited one) sees it.
    const at = pathOf();
    const next = load().then((was) => {
      const m: Record<string, PresenceSession> = all ? {} : { ...was };
      if (!all) {
        if (p) m[at] = p;
        else delete m[at];
      }
      return m;
    });
    current = next;
    const m = await next;
    await o.store?.save(Object.keys(m).length ? JSON.stringify(m) : null).catch(() => {});
  };
  const session = async () => {
    const p = (await load())[pathOf()];
    return p && p.expires - SESSION_MARGIN > now() ? p : null;
  };

  return {
    session,
    async headers(tool, body): Promise<Record<string, string>> {
      const id = idOf(tool, body);
      const s = SESSIONABLE.has(tool) && !live(own, id, REMEMBER_MS) ? await session() : null;
      if (s) {
        sent.set(id, "session");
        return { "x-vyre-presence": `session id=${s.id} secret=${s.secret}` };
      }
      const needs = (HUMAN_ONLY.has(tool) && !NARROWABLE.has(tool)) || live(asks, id, REMEMBER_MS);
      if (!needs) {
        sent.set(id, "none");
        return {};
      }
      if (live(declined, id, DECLINED_MS)) {
        sent.set(id, "declined");
        return {};
      }
      const key = await o.keyId().catch(() => null);
      if (!key) {
        // No enrolled key here (no biometrics at sign-in): the box asks for its passkey instead.
        sent.set(id, "declined");
        return {};
      }
      let input: unknown;
      try {
        input = JSON.parse(body || "{}");
      } catch {
        sent.set(id, "declined");
        return {};
      }
      const ts = now();
      const nonce = o.nonce();
      try {
        const sig = await o.sign(presenceMessage(tool, await inputHash(input), ts, nonce), tool);
        sent.set(id, "device");
        return { "x-vyre-presence": `device key=${key} ts=${ts} nonce=${nonce} sig=${sig}`, "x-vyre-presence-keep": "1" };
      } catch (e) {
        // Closed, no biometrics, or a retired key: the call goes without it and the box says
        // what it needs. Never thrown: a throw here would stall the outbox.
        declined.set(id, now());
        sent.set(id, "declined");
        o.failed?.(e);
        return {};
      }
    },
    answered(tool, body, r) {
      const id = idOf(tool, body);
      const was = sent.get(id);
      sent.delete(id);
      if (r.error?.code !== "presence_required") {
        if (!r.error) {
          asks.delete(id);
          own.delete(id);
        }
        return false;
      }
      const why = r.error.message ?? "";
      if (was === "session") {
        // The session ended on the box, or this item asks every time: its own proof, now.
        if (/no such session|ended|secret is wrong|another device/.test(why)) void save(null);
        else own.set(id, now());
        return true;
      }
      if (was === "none") {
        asks.set(id, now());
        return true;
      }
      if (was === "device" && /not enrolled/.test(why)) o.lost?.();
      return false;
    },
    async keep(header) {
      const p = parsePresenceSession(header);
      if (p && p.expires > now()) await save(p);
    },
    forget: () => save(null, true),
  };
}
