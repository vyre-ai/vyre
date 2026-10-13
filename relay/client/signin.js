// @ts-check
// Sign in by name: a new device types the person's name and asks to join it. No code is typed. The device picks a one-time secret, posts it to the relay under a locator derived from the
// name, and then does exactly what a device scanning a phone code does (relay/client/phonepair.js): it redeems the ticket the person's signed-in device makes from that secret, shows the
// same three words, and waits for the person to pick the matching words on that device. The approval is that device's signature over this device's key (spaces.identity.enrol), nothing new.
//
//   const r = await signInByName({ name: "kit", relay, key, crypto, keyStore, onWords: w => show(w) });
//
// The relay answers every request the same way, whether or not a device of that name is online (it says only "asked"), a name is asked about a few times a minute, and a request lives 2 minutes.
// Rejects with an Error whose `code` is: bad_name, rate_limited, unreachable, expired (nobody answered in 2 minutes, which is also what a name with no device online looks like), denied, cancelled.
import { addThisDevice } from "./phonepair.js";

/** How long a request lives. */
export const SIGNIN_TTL_MS = 2 * 60_000;
const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const toB64u = (/** @type {Uint8Array} */ b) => { let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };

/** The one spelling of a name the locator is made from: lower case, no spaces at the ends, no leading @, no .vyre.run on the end. @param {string} name */
export const normalName = name => String(name || "").trim().replace(/^@/, "").toLowerCase().replace(/\.vyre\.run$/, "");

/**
 * The locator the relay files a name's sign-in requests under (43 base64url characters): a hash, so the relay holds no name.
 * @param {string} name @param {{ sha256(b: Uint8Array): Promise<Uint8Array> }} crypto
 */
export async function signinLoc(name, crypto) {
  const n = normalName(name);
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(n)) throw fail("bad_name", "That is not a Vyre name. Type the name the other device is signed in as.");
  return toB64u(await crypto.sha256(new TextEncoder().encode(`vyre-signin-v1\n${n}`)));
}

/**
 * @param {{ name: string, relay: string, key: { publicKey: string, label?: string, agree?: string, held?: "web" | boolean, enclave?: string, attest?: string }, deviceName?: string, crypto: any, keyStore?: any,
 *   WebSocket?: any, fetch?: typeof fetch, presenceKey?: any, about?: any, onWords?: (words: string) => void, onAsked?: () => void, signal?: AbortSignal, pollMs?: number, expectIdentity?: string }} o
 */
export async function signInByName(o) {
  const loc = await signinLoc(o.name, o.crypto);
  const seed = o.crypto.randomBytes ? o.crypto.randomBytes(16) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const t = toB64u(seed);
  const fetchFn = o.fetch || globalThis.fetch;
  const base = String(o.relay).replace(/\/+$/, "").replace(/^ws/, "http");
  let res;
  try { res = await fetchFn(`${base}/v1/signin`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ loc, s: t }) }); }
  catch { throw fail("unreachable", "The relay could not be reached. Check this device's connection and try again."); }
  if (res.status === 429) throw fail("rate_limited", "Too many sign-in requests for that name. Wait a minute and try again.");
  if (!res.ok) throw fail("unreachable", "The relay would not take the request. Try again in a minute.");
  if (o.onAsked) o.onAsked();
  const payload = `vyre://wink/2?t=${t}&r=${encodeURIComponent(o.relay)}&k=phone`;
  let r;
  try {
    r = await addThisDevice({ payload, key: o.key, name: o.deviceName || o.key.label || "a device", crypto: o.crypto, keyStore: o.keyStore, WebSocket: o.WebSocket, fetch: o.fetch, presenceKey: o.presenceKey, about: o.about,
      onWords: o.onWords, signal: o.signal, pollMs: o.pollMs, ticketWaitMs: SIGNIN_TTL_MS, relay: o.relay });
  } catch (e) {
    // nobody answered, a name with no device online, and a request that ran out are one answer
    if (/** @type {any} */ (e).code === "taken" || /** @type {any} */ (e).code === "unreachable" && /expired|already used|did not ask/i.test(String(/** @type {Error} */ (e).message))) throw fail("expired", "Nobody answered in 2 minutes. Open Vyre on a device that is signed in to that name and try again.");
    throw e;
  }
  if (o.expectIdentity && r.identity && r.identity.id !== o.expectIdentity) throw fail("denied", "That sign-in joined a different identity than the name you typed. Nothing was added; try again.");
  return r;
}
