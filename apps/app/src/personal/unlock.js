// @ts-check
// The phone's answer to a server's unlock request (core/memory/identity/home.js: beginUnlock, approveUnlock, Phone.answer), for the person's Personal records and identity memory on a team server.
// The person says yes once for a server; from then on this phone answers that server's requests by itself, with no prompt, until the person revokes it in Settings. An answer is: unwrap the identity key with THIS
// device's agree key (the one async step, the key stays in its keystore) and wrap it to the request's one-use session key. The server sees only the wrap, and opens it into its own memory.
import { p256 } from "@noble/curves/p256";
import { sha256 } from "@noble/hashes/sha2";
import { unwrapWithDevice, wrapForDevice, unb64, utf8 } from "../../../../lib/keywrap.js";
import { canonical } from "../../../../kernel/core/canonical.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const aadOf = (/** @type {string} */ id, /** @type {string} */ what) => `vyre-identity-home/${id}/${what}`;

/** The bytes a server signs for a request (home.js askBytes): the sorted-key canonical JSON of these fields, so the order a field arrives in never decides validity. @param {any} ask */
export const askBytes = (ask) => utf8(canonical({ id: ask.id, home: ask.home, request: ask.request, sessionPub: ask.sessionPub, rev: ask.rev, server: ask.server ? ask.server.fp : null }));

/** The 65-byte point of a P-256 public JWK. @param {{ x: string, y: string }} jwk */
const point = (jwk) => { const p = new Uint8Array(65); p[0] = 4; p.set(unb64(jwk.x), 1); p.set(unb64(jwk.y), 33); return p; };

/** Did the server with this public key sign this request? (ECDSA P-256 over SHA-256, the signature as raw r then s.) @param {any} ask @param {{ x: string, y: string }} serverJwk */
export function askSignedBy(ask, serverJwk) {
  try { return p256.verify(unb64(String(ask.sig || "")), sha256(askBytes(ask)), point(serverJwk), { lowS: false }); } catch { return false; }
}

/**
 * Answer a request: refused unless the person said yes to that server (`granted` maps a server's fingerprint to its public JWK) and the server signed it. `agree` is this device's agree key (getAgreeKey()).
 * @param {any} ask the request memory.identity.unlock.begin gave: { id, home, request, sessionPub, wraps, rev, server: { name, fp }, sig }
 * @param {{ holder: string, ecdh: import("../../../../lib/keywrap.js").Ecdh }} agree @param {ReadonlyMap<string, { x: string, y: string }>} granted
 * @returns {Promise<any>} the wrap for `memory.identity.unlock.finish { request, answer }`
 */
export async function answerUnlock(ask, agree, granted) {
  const server = ask?.server && granted.get(String(ask.server.fp));
  if (!server) throw fail("needs_yes", "this server has not been given your memory: say yes on this phone first");
  if (!askSignedBy(ask, server)) throw fail("bad_signature", "that request is not signed by the server you granted");
  const mine = Array.isArray(ask.wraps) ? ask.wraps.find((/** @type {any} */ w) => w && w.kind === "device" && w.fp === agree.holder) : null;
  if (!mine) throw fail("unknown_key", "this device holds no key for that identity memory");
  const key = await unwrapWithDevice(mine.wrapped, agree.ecdh, aadOf(ask.home, `wrap:${mine.fp}`));
  try { return wrapForDevice(key, ask.sessionPub, aadOf(ask.home, `unlock:${ask.request}`)); } finally { key.fill(0); }
}
