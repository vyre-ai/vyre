// @ts-check
// devicekey: this computer's own request-signing key for a server it pairs (P-256, kept in a 0600 file beside the relay keys). The pairing hello offers its public half as `presenceKey`, so the server can bind
// this computer's paired session to it, and `sign` signs the server's `paired-start` challenge. A software key: the server records it as such, and the key never leaves this file.
import crypto from "node:crypto";
import fs from "node:fs";

/** @param {string} file @returns {{ presenceKey: { public_key: string, alg: number, storage: "software" }, sign: (message: string) => string }} */
export function deviceKey(file) {
  /** @type {crypto.KeyObject | null} */ let priv = null;
  try { priv = crypto.createPrivateKey({ key: JSON.parse(fs.readFileSync(file, "utf8")), format: "jwk" }); } catch { priv = null; }
  if (!priv) {
    const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    priv = kp.privateKey;
    fs.writeFileSync(file, JSON.stringify(priv.export({ format: "jwk" })), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* not posix */ }
  }
  const spki = crypto.createPublicKey(priv).export({ format: "der", type: "spki" }).toString("base64url");
  const key = priv;
  return { presenceKey: { public_key: spki, alg: -7, storage: "software" }, sign: m => crypto.sign("sha256", Buffer.from(m), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
