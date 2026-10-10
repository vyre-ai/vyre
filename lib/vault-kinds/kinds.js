// @ts-check
// kinds: what each kind of item holds, which field it hands over, and what the list may show.
//
// A kind is a promise about fields: a `pat` has a `token`, a `cloud` credential has its secret
// key or service-account JSON, a `cert` has its certificate. Kinds also decide the vault an item
// starts in (personal kinds need a person; the rest may be granted to agents) and what the list
// shows beside the name. That last part is `details`: a PAT's scopes and expiry, the provider,
// an authenticator's issuer, a Wi-Fi network's name. Details are listable and never decide where
// a value may go, so they are neither sealed nor MACed; a value is never a detail (ADR 0028).

import { X509Certificate } from "node:crypto";

/** Every kind, in the order the Deck groups them. */
export const KINDS = /** @type {const} */ ([
  "login", "authenticator", "passkey", "card", "address", "identity", "note",
  "api-key", "pat", "oauth", "cloud", "db-url", "secret", "env-set", "ssh-key", "cert",
  "recovery-codes", "wifi", "license", "file", "api-credential",
]);

/**
 * Per kind: `need`, at least one of these fields; `take`, the field handed over when nobody names
 * one (the first present), empty when a field must always be named; `personal`, whether the item
 * starts in the personal vault once there is an account.
 * @type {Record<string, { need: string[], take: string[], personal?: true, fields?: string[] }>}
 */
export const SPEC = {
  login: { need: ["password", "username"], take: ["password"], personal: true, fields: ["username", "password", "totp"] },
  authenticator: { need: ["totp"], take: ["totp"], personal: true, fields: ["totp", "account"] },
  // Its private key signs inside vyred and is never handed out; the fields name what signs where.
  passkey: { need: ["private_key"], take: [], personal: true, fields: ["private_key", "credential_id", "user_handle", "user_name", "rp_id", "sign_count"] },
  card: { need: ["number"], take: ["number"], personal: true, fields: ["holder", "number", "expiry", "cvv", "pin"] },
  address: { need: ["line1", "city", "postal", "country"], take: [], personal: true, fields: ["name", "company", "line1", "line2", "city", "region", "postal", "country", "phone", "email"] },
  identity: { need: ["name", "number", "birthdate"], take: [], personal: true, fields: ["name", "number", "birthdate", "issued", "expiry", "country", "type"] },
  note: { need: ["text"], take: ["text"], personal: true },
  "api-key": { need: ["value"], take: ["value"] },
  pat: { need: ["token"], take: ["token"], fields: ["token", "username"] },
  oauth: { need: ["token", "access_token", "refresh_token", "client_secret"], take: ["token", "access_token", "refresh_token", "client_secret"],
    fields: ["client_id", "client_secret", "access_token", "refresh_token", "token"] },
  cloud: { need: ["secret_access_key", "json", "client_secret", "value"], take: ["secret_access_key", "json", "client_secret", "value"],
    fields: ["access_key_id", "secret_access_key", "session_token", "json", "tenant_id", "client_id", "client_secret", "value"] },
  "db-url": { need: ["url"], take: ["url"], fields: ["url", "password"] },
  secret: { need: ["value"], take: ["value"] },
  "env-set": { need: [], take: [] },
  "ssh-key": { need: [], take: [] },
  cert: { need: ["certificate", "private_key"], take: ["certificate"], fields: ["certificate", "private_key", "chain", "passphrase"] },
  "recovery-codes": { need: ["codes"], take: ["codes"], personal: true },
  wifi: { need: ["password", "ssid"], take: ["password"], personal: true, fields: ["ssid", "password", "security"] },
  license: { need: ["key", "file"], take: ["key"], personal: true, fields: ["key", "file", "email", "name"] },
  file: { need: ["content"], take: ["content"], fields: ["content", "filename", "type"] },
  // Names an API, the hosts it may reach and how each call is classified (core/vault/api-request.js);
  // `secret` is the key or token it authenticates with. Used only in-process by vault.request:
  // nothing hands it out, so no take field.
  "api-credential": { need: ["config"], take: [], fields: ["config", "secret"] },
};

export const PERSONAL_KINDS = KINDS.filter(k => SPEC[k].personal);

/**
 * The field a kind hands over when nobody names one: the first of its `take` that the item has,
 * or null when a field must be named. `has` is the item's field names; without it, the first.
 * @param {string} kind @param {string[]} [has]
 * @returns {string|null}
 */
export function defaultField(kind, has) {
  const s = SPEC[kind];
  if (!s || !s.take.length) return null;
  if (!has) return s.take[0];
  return s.take.find(f => has.includes(f)) ?? null;
}

/**
 * Refuse fields a kind cannot work with, in words a person can act on. Field names only.
 * @param {string} kind @param {Record<string, string>} fields
 */
export function checkFields(kind, fields) {
  const s = SPEC[kind];
  if (!s) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const names = Object.keys(fields);
  if (s.need.length && !s.need.some(f => names.includes(f)))
    throw new Error(s.need.length === 1 ? `a ${kind} needs a ${s.need[0]}` : `a ${kind} needs one of ${s.need.join(", ")}`);
}

/** What `details` may hold, per key: listable words and dates, never a value. */
const DETAIL = {
  expires: v => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined),
  scope: v => (Array.isArray(v) && v.length <= 64 && v.every(x => typeof x === "string" && /^[\w:./*-]{1,80}$/.test(x)) ? [...new Set(v)] : undefined),
  provider: v => (typeof v === "string" && /^[a-z0-9][a-z0-9.-]{0,39}$/.test(v) ? v : undefined),
  issuer: v => (typeof v === "string" && v.length <= 80 ? printable(v) : undefined),
  ssid: v => (typeof v === "string" && v.length <= 64 ? printable(v) : undefined),
  product: v => (typeof v === "string" && v.length <= 80 ? printable(v) : undefined),
  filename: v => (typeof v === "string" && v.length <= 200 ? printable(v).replace(/[\\/]/g, "_") : undefined),
  count: v => (Number.isInteger(v) && v >= 0 && v < 10000 ? v : undefined),
  // The address an account is known by (a mailbox's email): public, and what a list shows instead of the item's name.
  address: v => (typeof v === "string" && /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(v) ? v.toLowerCase() : undefined),
  rp: v => (typeof v === "string" && /^[a-z0-9.-]{1,253}$/i.test(v) ? v.toLowerCase() : undefined),
  // A passkey's credential id: public (every sign-in sends it), and what a site asks for by.
  credential: v => (typeof v === "string" && /^[A-Za-z0-9_-]{1,1400}$/.test(v) ? v : undefined),
};
/** The JSON schema tools declare for `details`. `expires` also takes "90d" or a date. */
export const DETAILS = { type: "object", properties: {
  expires: { type: ["integer", "string"] }, scope: { type: "array", items: { type: "string" } }, provider: { type: "string" },
  issuer: { type: "string" }, ssid: { type: "string" }, product: { type: "string" }, filename: { type: "string" }, count: { type: "integer" }, rp: { type: "string" }, credential: { type: "string" }, address: { type: "string" },
} };
const printable = s => s.replace(/[^\x20-\x7e -￿]/g, "").trim();

/**
 * Clean the details a caller gave. Unknown keys and bad values are refused by name.
 * @param {unknown} d
 * @returns {Record<string, any>}
 */
export function cleanDetails(d) {
  if (d === undefined || d === null) return {};
  if (typeof d !== "object" || Array.isArray(d)) throw new Error("details must be an object");
  /** @type {Record<string, any>} */
  const out = {};
  for (const [k, v] of Object.entries(d)) {
    if (!(k in DETAIL)) throw new Error(`details.${k.slice(0, 40)} is not one of ${Object.keys(DETAIL).join(", ")}`);
    if (v === undefined || v === null || v === "") continue;
    const c = DETAIL[/** @type {keyof typeof DETAIL} */ (k)](v);
    if (c === undefined) throw new Error(`details.${k} is not a usable ${k}`);
    out[k] = c;
  }
  return out;
}

/**
 * Details a kind can work out from its own fields, so nobody types them: a certificate's end
 * date, an authenticator's issuer, how many recovery codes are left, a Wi-Fi network's name. The
 * caller's details win. Never throws; a field that doesn't parse adds nothing.
 * @param {string} kind @param {Record<string, string>} f
 */
export function derivedDetails(kind, f) {
  /** @type {Record<string, any>} */
  const d = {};
  try {
    if (kind === "cert" && f.certificate) {
      const t = Date.parse(new X509Certificate(f.certificate).validTo);
      if (Number.isFinite(t)) d.expires = t;
    }
    if ((kind === "authenticator" || kind === "login") && f.totp && /^otpauth:\/\//i.test(f.totp)) {
      const u = new URL(f.totp);
      const issuer = u.searchParams.get("issuer") || decodeURIComponent(u.pathname.replace(/^\/+/, "")).split(":")[0];
      if (issuer && kind === "authenticator") d.issuer = printable(issuer).slice(0, 80);
    }
    if (kind === "recovery-codes" && f.codes) d.count = f.codes.split(/[\s,]+/).map(s => s.trim()).filter(Boolean).length;
    if (kind === "wifi" && f.ssid) d.ssid = printable(f.ssid).slice(0, 64);
    if (kind === "file" && f.filename) d.filename = printable(f.filename).replace(/[\\/]/g, "_").slice(0, 200);
  } catch { /* a detail is a convenience; the item stands without it */ }
  return d;
}
