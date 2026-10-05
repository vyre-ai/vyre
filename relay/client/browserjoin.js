// @ts-check
// A browser with no box of its own joins a person's identity from a phone's long code: "Add a device" on the phone (wink.phone.open) shows a code, the browser pastes (or scans) it, both sides
// show three words, the person says yes on the phone, and the phone puts the browser's entry on the identity list. The counterpart of pairServer for a device that is a web page. It is
// addThisDevice (phonepair.js) with three differences: only the long code (`vyre://wink/2?...&k=phone`) is taken, never the short typed code (that stays off); the browser's key-agreement point
// is required, because an entry without one cannot open a private chat; and the entry says `held: "web"`, because a key a page script can reach cannot change who speaks for the identity.
//
//   const r = await joinFromPhone({ payload, key: { publicKey, agree, label: "Kit's browser" }, name: "Kit's browser", crypto, keyStore, onWords: w => show(w) });
//
// payload   the phone's long code, pasted or scanned.
// key       { publicKey: this browser's identity key (32 raw bytes, base64url), agree: its key-agreement point (65-byte uncompressed P-256, base64url), label? }
// the rest  as addThisDevice: name, crypto, keyStore, WebSocket, about, presenceKey, onWords, signal, pollMs, timeoutMs.
// Resolves { paired: true, enrolled, relay, route, box, device, name, identity? } (enrolled: false says why in `reason`); rejects with an Error whose `code` is bad_code (not a phone's long code, or a typed
// or avatar code), bad_key (no agreement point of the right shape), taken, busy, unreachable, denied, expired, cancelled.
import { addThisDevice, parsePhonePayload } from "./phonepair.js";

const fail = (/** @type {string} */ code, /** @type {string} */ message) => Object.assign(new Error(message), { code });
const b64u = (/** @type {string} */ s) => { try { const t = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)); return Uint8Array.from(t, c => c.charCodeAt(0)); } catch { return null; } };

/**
 * @param {Omit<Parameters<typeof addThisDevice>[0], "key" | "code" | "avatar"> & { key: { publicKey: string, agree: string, label?: string } }} o
 */
export function joinFromPhone(o) {
  const any = /** @type {any} */ (o);
  if (any.code !== undefined || any.avatar !== undefined) return Promise.reject(fail("bad_code", "A browser joins with the phone's long code. The short typed code is off."));
  if (typeof o.payload !== "string" || !parsePhonePayload(o.payload)) return Promise.reject(fail("bad_code", "That is not the phone's code. On the phone, choose Add a device, then paste or scan the long code it shows."));
  const point = o.key && typeof o.key.agree === "string" ? b64u(o.key.agree) : null;
  if (!point || point.length !== 65 || point[0] !== 4) return Promise.reject(fail("bad_key", "A browser joins with its key-agreement point (65 bytes, uncompressed P-256, base64url), so it can open private chats."));
  return addThisDevice({ ...o, key: { ...o.key, held: "web" } });
}
