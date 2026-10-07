// @ts-check
// directkey: the key a paired SERVER proves itself with on the home's direct door. A server never sits on an identity list (it cannot speak for anyone), so the key is
// derived from the peer secret the home gave it at adopt time: the home derives the same key from the secret it holds for that device, and only a holder of the secret can sign.
// Ed25519, so the door's admission (core/wink/node/peer-wire.js) checks it like any other device key.
import crypto from "node:crypto";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

/** @param {string} peerSecret the base64url peer secret @returns {{ pub: string, sign: (message: Buffer) => string }} pub is the raw 32-byte public key, base64url */
export function directKey(peerSecret) {
  const seed = crypto.createHmac("sha256", Buffer.from(String(peerSecret), "base64url")).update("vyre-wink-direct-v1").digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
  return { pub, sign: message => crypto.sign(null, message, priv).toString("base64url") };
}

/**
 * The static Noise key a paired SERVER uses on the relay when it reaches its home there (the fallback when the direct path is down): derived from the same peer secret, so the home
 * knows its public half without being told it, admits it as a server row (never an app device) and nothing else can use that row. X25519, the shape relay/client/nodecrypto.js keeps.
 * @param {string} peerSecret @returns {{ privateKey: Uint8Array, publicKey: Uint8Array }}
 */
export function relayKeyPair(peerSecret) {
  const seed = crypto.createHmac("sha256", Buffer.from(String(peerSecret), "base64url")).update("vyre-wink-relay-v1").digest();
  const priv = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const pub = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { privateKey: new Uint8Array(seed), publicKey: new Uint8Array(pub) };
}
