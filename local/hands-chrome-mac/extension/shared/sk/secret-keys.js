// GENERATED from lib/secret-keys.js by scripts/sync-copies.mjs (the extension cannot import from lib/). Do not edit here: change the original and run the script.
// @ts-check
// [reviewed: trust] The one list of secret field names. Kernel egress, Flow timelines, the phone Flow
// screen, the browser redactor and site learning all ask this file. A new secret name is a row here.
// `egress` false means the same spelling is also an ordinary product word (a chat session id, a proof
// signature, a stream pin), so a tool result is not stripped on that name alone. The browser and a
// timeline still hide it, because that is where the spelling carries a secret.

/**
 * @typedef {{ key: string, type: string, egress: boolean }} SecretKey
 */

/** @type {readonly SecretKey[]} */
export const SECRET_KEYS = Object.freeze([
  // A vault item's value: a password, a key, or a one-time secret.
  ...rows("vault-value", ["password", "passwd", "passphrase", "passcode", "pass", "pwd", "secret", "secretkey", "privatekey", "private", "apikey", "totp", "otp", "cvv", "cvc", "credential", "credentials", "ssn"]),
  // A recovery key, a recovery code, or the wrap a recovery key opens.
  ...rows("recovery-key", ["recovery", "recoverykey", "recoverysecret", "recoverycode", "recoverywrap"]),
  // Master-password material and the wraps it unlocks (identity, vault, box).
  ...rows("master-record", ["masterpassword", "passwordwrap", "identitywrap", "vaultwrap", "boxwrap", "masterkey", "rootkey"]),
  // An access, refresh, session, or API token, and the header or cookie that carries one.
  ...rows("token", ["token", "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "bearertoken", "bearer", "jwt", "webhooksecret", "authorization", "cookie", "csrf", "xsrf"]),
  // A connection's client secret or access-key secret.
  ...rows("connection-credential", ["clientsecret", "secretaccesskey"]),
  // An invite token that grants entry.
  ...rows("invite-token", ["invitetoken", "invitecode"]),
  // The same spelling is a secret in a browser body and an ordinary id in a tool result.
  ...rows("token", ["session", "sid", "sessionid", "pin", "signature"], false),
]);

/** @param {string} type @param {string[]} keys @param {boolean} [egress] @returns {SecretKey[]} */
function rows(type, keys, egress = true) {
  return keys.map(key => ({ key, type, egress }));
}

/** @type {Map<string, SecretKey>} */
const BY_KEY = new Map();
for (const row of SECRET_KEYS) {
  if (BY_KEY.has(row.key)) throw new Error(`duplicate secret key ${row.key}`);
  BY_KEY.set(row.key, row);
}

const norm = (/** @type {string} */ k) => String(k).replace(/[_-]/g, "").toLowerCase();

/** camelCase and any separator, lowercased. "recoveryWrap" and "user_password" both split. @param {string} key */
function segments(key) {
  const s = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return s.split(/[^A-Za-z0-9]+/).filter(Boolean).map(p => p.toLowerCase());
}

/**
 * The row for this exact name, underscores and hyphens ignored, or null.
 * @param {string} key
 * @returns {SecretKey | null}
 */
function rowOf(key) {
  return BY_KEY.get(norm(key)) || null;
}

/** Secret-field names of one type that tool egress strips. @param {string} type */
export function keysOfType(type) {
  return SECRET_KEYS.filter(r => r.type === type && r.egress).map(r => r.key);
}

/** The secret type of an exact name, or null. An egress-false name still has a type. @param {string} key */
export function secretTypeOf(key) {
  const row = rowOf(key);
  return row ? row.type : null;
}

/** An exact name whose value tool egress strips. @param {string} key */
export function keyIsSecret(key) {
  const row = rowOf(key);
  return !!(row && row.egress);
}

/**
 * A name whose value is secret on a timeline or in a browser body: the exact name, one of its words
 * (user_password, recoveryWrap), or a longer name that ends in a secret word (mytoken). "secretary" is not.
 * @param {string} key
 */
export function nameIsSecret(key) {
  return matched(key, () => true);
}

/**
 * A name tool egress and the event bus treat as secret. A product word that only sometimes holds a
 * secret (session, pin, signature) is not, so a chat session id still comes back to the agent.
 * @param {string} key
 */
export function egressNameIsSecret(key) {
  return matched(key, (/** @type {SecretKey} */ row) => row.egress);
}

/** @param {string} key @param {(row: SecretKey) => boolean} take */
function matched(key, take) {
  const exact = rowOf(key);
  if (exact) return take(exact);
  const parts = segments(key);
  if (parts.length > 1 && parts.some(p => { const row = BY_KEY.get(p); return !!(row && take(row)); })) return true;
  const n = norm(key);
  for (const [k, row] of BY_KEY) {
    if (!take(row) || k.length < 5) continue;
    if (n.length > k.length && n.endsWith(k)) return true;
  }
  return false;
}

/**
 * True when a JSON text has a secret-named string value of at least 6 characters. The event bus
 * refuses that payload. Numbers, booleans and objects are left to the caller.
 * @param {string} json
 */
export function jsonHasSecretField(json) {
  const re = /"([^"\\]+)"\s*:\s*"([^"\\]{6,})"/g;
  let m;
  while ((m = re.exec(String(json)))) if (egressNameIsSecret(m[1])) return true;
  return false;
}
