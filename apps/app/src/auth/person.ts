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

export async function sha256b64url(text: string): Promise<string> {
  return b64url(await subtle().digest("SHA-256", enc.encode(text)));
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

/** The `x-vyre-proof` value for one request, signed with the session's key. */
export async function proof(
  key: CryptoKey,
  r: { method: string; url: string; body?: string; now?: number; nonce?: string },
): Promise<string> {
  const t = r.now ?? Date.now();
  const n = r.nonce ?? randomB64url(16);
  const msg = await proofMessage({ method: r.method, path: pathOf(r.url), body: r.body, t, n });
  const sig = await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(msg));
  return `t=${t} n=${n} sig=${b64url(sig)}`;
}

/** Where a person session keeps its two things. load() gives null when there is none. */
export type Slot<T> = { load(): Promise<T | null>; save(v: T | null): Promise<void> };
export type PersonStores = { key: Slot<CryptoKeyPair>; token: Slot<string> };

/** A Slot in memory, for tests and for runtimes with nowhere durable to keep it. */
export function memorySlot<T>(initial: T | null = null): Slot<T> {
  let v = initial;
  return { load: async () => v, save: async (n) => void (v = n) };
}

export type PersonSession = {
  /** The headers for one request: none until signed in. */
  headers(method: string, url: string, body: string): Promise<Record<string, string>>;
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
 */
export function personSession(o: {
  box: string;
  stores: PersonStores;
  signIn: () => void;
  fetch?: typeof fetch;
  now?: () => number;
}): PersonSession {
  const box = o.box.replace(/\/+$/, "");
  const doFetch = o.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const now = o.now ?? Date.now;
  let keyP: Promise<CryptoKeyPair> | null = null;
  let token: Promise<string | null> | null = null;

  const key = () =>
    (keyP ??= o.stores.key.load().then(async (k) => {
      if (k) return k;
      const made = await newKey();
      await o.stores.key.save(made);
      return made;
    }).catch((e) => {
      keyP = null;
      throw e;
    }));
  const currentToken = () => (token ??= o.stores.token.load().then((t) => (t && TOKEN.test(t) ? t : null)));
  const setToken = async (t: string | null) => {
    token = Promise.resolve(t);
    await o.stores.token.save(t);
  };

  async function headers(method: string, url: string, body: string): Promise<Record<string, string>> {
    const t = await currentToken();
    if (!t) return {};
    const k = await key();
    return { authorization: `Vyre ${t}`, "x-vyre-proof": await proof(k.privateKey, { method, url, body, now: now() }) };
  }

  return {
    headers,
    required() {
      void setToken(null).catch(() => {});
      o.signIn();
    },
    async exchange(code, verifier) {
      const k = await key();
      let res: Response;
      try {
        res = await doFetch(`${box}/v1/person/token`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, verifier, key: await publicJwk(k.publicKey) }),
          cache: "no-store",
        });
      } catch (e) {
        return { ok: false, code: "unreachable", message: e instanceof Error ? e.message : "the box is out of reach" };
      }
      const b = (await res.json().catch(() => null)) as { data?: { token?: string }; error?: { code: string; message: string } } | null;
      const t = b?.data?.token;
      if (!t || !TOKEN.test(t)) return { ok: false, code: b?.error?.code ?? "bad_response", message: b?.error?.message ?? `the box answered ${res.status}` };
      await setToken(t);
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
