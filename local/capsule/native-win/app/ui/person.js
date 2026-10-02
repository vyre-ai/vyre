// A person session for this app's device, the way the phone app starts one (apps/app/src/auth/person.ts): a session key made here that
// never leaves this page, a start call proved by the app's presence key (the app signs it in Rust, for this one tool, for a key that is
// exactly a public P-256 JWK), then every request carries the session token and a signature by the session key. Needed for calls the
// server only takes from a person on a device, such as asking it to accept the local helper.

const enc = new TextEncoder();

export const b64url = (buf) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const sha256b64url = async (text) => b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
const TOKEN = /^[A-Za-z0-9_-]{8,64}\.[A-Za-z0-9_-]{16,128}$/;

/** The string one request's proof signs: METHOD, path with query, the body's hash, the time and a nonce. */
export async function proofMessage({ method, path, body = "", t, n }) {
  return `${String(method).toUpperCase()}\n${path}\n${await sha256b64url(body)}\n${t}\n${n}`;
}

/**
 * @param {{ send: (path: string, init: { method: string, headers: Record<string, string>, body?: string }) => Promise<{ status: number, json(): Promise<any> }>,
 *   presenceProof: (jwk: object) => Promise<string>, now?: () => number }} o
 */
export function personSession({ send, presenceProof, now = Date.now }) {
  /** @type {null | { key: CryptoKeyPair, token: string, expires: number }} */
  let live = null;
  let starting = null;

  async function start() {
    const key = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const j = await crypto.subtle.exportKey("jwk", key.publicKey);
    const jwk = { kty: "EC", crv: "P-256", x: String(j.x), y: String(j.y) };
    const res = await send("/v1/tools/presence.person.start", { method: "POST", headers: { "content-type": "application/json", "x-vyre-presence": await presenceProof(jwk) }, body: JSON.stringify({ key: jwk }) });
    const b = await res.json().catch(() => null);
    const d = b && typeof b === "object" ? (b.data && typeof b.data === "object" ? b.data : b) : null;
    const t = typeof (d && d.token) === "string" ? d.token : "";
    const token = TOKEN.test(t) ? t : d && typeof d.id === "string" && TOKEN.test(`${d.id}.${t}`) ? `${d.id}.${t}` : "";
    if (!token) throw Object.assign(new Error((b && b.error && b.error.message) || `your server answered ${res.status}`), { code: (b && b.error && b.error.code) || "person_start_failed" });
    live = { key, token, expires: typeof d.expires === "number" ? d.expires : 0 };
    return live;
  }

  /** A session that is still good, starting one if there is none. */
  async function ensure() {
    if (live && (!live.expires || live.expires - now() > 60_000)) return live;
    if (!starting) starting = start().finally(() => { starting = null; });
    return starting;
  }

  /** The headers for one request: the session token and its proof. `path` includes the query. */
  async function headers(method, path, body = "") {
    const s = await ensure();
    const t = now(), n = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, s.key.privateKey, enc.encode(await proofMessage({ method, path, body, t, n })));
    return { authorization: `Vyre ${s.token}`, "x-vyre-proof": `t=${t} n=${n} sig=${b64url(sig)}` };
  }

  /** Forget the session (the server said it is gone); the next request starts another. */
  const forget = () => { live = null; };
  return { ensure, headers, forget };
}
