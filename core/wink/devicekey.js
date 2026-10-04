// @ts-check
// devicekey: this computer's own request-signing key for a server it pairs (P-256, kept in a 0600 file beside the relay keys). The pairing hello offers its public half as `presenceKey`, so the server can bind
// this computer's paired session to it, and `sign` signs the server's `paired-start` challenge. A software key: the server records it as such, and the key never leaves this file.
import crypto from "node:crypto";
import fs from "node:fs";

/** JSON with object keys sorted at every depth and no spaces: what a presence proof's input hash is taken over (the same as core/presence canonical). @param {any} v @returns {string} */
const canonical = v => {
  if (Array.isArray(v)) return "[" + v.map(x => (x === undefined || typeof x === "function" ? "null" : canonical(x))).join(",") + "]";
  if (v && typeof v === "object" && typeof v.toJSON !== "function") { const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== "function").sort(); return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"; }
  return JSON.stringify(v) ?? "null";
};

/** @param {string} file @returns {{ proveTool: (tool: string, input: any) => any, presenceKey: { public_key: string, alg: number, storage: "software" }, sign: (message: string) => string }} */
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
  // A presence proof for one tool call, in the server's `device` method: this key's id (the fingerprint the server enrolled it under), a time, a nonce, and the signature over the tool and the hash of its input.
  const proveTool = (/** @type {string} */ tool, /** @type {any} */ input) => {
    const ts = String(Date.now()), nonce = crypto.randomBytes(12).toString("base64url");
    const hash = crypto.createHash("sha256").update(canonical(input)).digest("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${hash}\n${ts}\n${nonce}`), { key, dsaEncoding: "der" }).toString("base64url");
    return { method: "device", key: crypto.createHash("sha256").update(Buffer.from(spki, "base64url")).digest("base64url").slice(0, 22), ts, nonce, sig };
  };
  return { proveTool, presenceKey: { public_key: spki, alg: -7, storage: "software" }, sign: m => crypto.sign("sha256", Buffer.from(m), { key, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}
