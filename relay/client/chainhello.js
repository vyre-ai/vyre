// @ts-check
// The first hello of a device the person's identity chain lists (design B): the chain key signs "vyre-chain-hello-v1" over the server's box id, the identity, the entry, the time, a fresh nonce and this channel's own
// id, so the hello means this device, to this server, now. The server side is core/relay/chain-admit.js. `sign` is the device's chain key (its Secure Enclave, Keystore or passkey signer) and gives the signature bytes.
import { b64u } from "../../kernel/identity/chain.js";

const ALPHA = "abcdefghijklmnopqrstuvwxyz234567";
/** base32 of the first bytes, 16 characters: the relay's device id of a key (core/relay/index.js deviceId). @param {Uint8Array} h */
function base32Head(h) {
  let out = "", bits = 0, value = 0;
  for (const byte of h) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out.slice(0, 16);
}

/**
 * @param {{ sha256: (b: Uint8Array) => Promise<Uint8Array>, devicePub: Uint8Array, box: string, identity: string, entry: string, now?: number, sign: (m: Uint8Array) => Promise<Uint8Array> | Uint8Array, name?: string }} o
 * @returns {Promise<{ identity: string, entry: string, ts: number, nonce: string, channel: string, sig: string, name?: string }>}
 */
export async function chainHello(o) {
  const channel = base32Head(await o.sha256(o.devicePub));
  const nonce = b64u(globalThis.crypto.getRandomValues(new Uint8Array(18)));
  const ts = o.now ?? Date.now();
  const h = { identity: o.identity, entry: o.entry, ts, nonce, channel };
  const message = Buffer.from(`vyre-chain-hello-v1\n${o.box}\n${h.identity}\n${h.entry}\n${h.ts}\n${h.nonce}\n${h.channel}`, "utf8");
  const sig = b64u(new Uint8Array(await o.sign(new Uint8Array(message))));
  return { ...h, sig, ...(o.name ? { name: o.name } : {}) };
}
