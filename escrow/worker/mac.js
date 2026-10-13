// @ts-check
// The one MAC between the relay and the escrow Worker: HMAC-SHA-256 under their shared secret over a purpose and a canonical body. Pure, so both sides run the same bytes.
import { canonical, b64u } from "../../kernel/identity/chain.js";
const enc = new TextEncoder();
/** @param {string} secret @param {string} purpose @param {any} body */
export async function mac(secret, purpose, body) {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(`vyre-escrow-v1\n${purpose}\n${canonical(body)}`))));
}
