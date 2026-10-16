// @ts-check
// [reviewed: trust] Secret-bearing field types. The tag is on the schema (`secret: true`), not on a tool name.
// The kernel egress strips a value of any of these types from an agent, model, MCP or hosted result,
// whichever module produced it. A person's own caller is unchanged, so a recovery key can still be shown once.
//
// Identity (#215) uses these names: recoveryKey, recovery, recoveryCode and recoveryWrap are a recovery key;
// password, masterPassword, passwordWrap, identityWrap, vaultWrap and boxWrap are master-record material.
// identity.create, identity.migrate and identity.unlock return the recovery key only to the person.
import { AsyncLocalStorage } from "node:async_hooks";
import { KINDS, SPEC } from "./vault-kinds/kinds.js";
import { scrub, scrubAll } from "./scrub.js";
import { egressNameIsSecret, keyIsSecret, keysOfType, secretTypeOf } from "./secret-keys.js";

export { egressNameIsSecret, keyIsSecret, secretTypeOf };

/**
 * One secret-bearing field type. `keys` are the property names that are this type, compared with
 * underscores and hyphens removed. `kinds` are record field kinds that are this type. The names
 * themselves live in lib/secret-keys.js.
 * @param {string} secretType @param {string} description @param {string[]} keys @param {string[]} [kinds]
 */
function typeOf(secretType, description, keys, kinds = []) {
  return Object.freeze({ secret: true, secretType, type: "string", description, keys: Object.freeze(keys), kinds: Object.freeze(kinds) });
}

/** The secret-bearing field types. Every one carries `secret: true`. */
export const SECRET_FIELD_TYPES = Object.freeze({
  "vault-value": typeOf("vault-value", "A vault item's value: a password, key, or one-time secret.", keysOfType("vault-value")),
  "recovery-key": typeOf("recovery-key", "A recovery key, recovery code, or the wrap a recovery key opens.", keysOfType("recovery-key")),
  "master-record": typeOf("master-record", "Master-password material and the wraps it unlocks (identity, vault, box).", keysOfType("master-record")),
  token: typeOf("token", "An access, refresh, session, or API token.", keysOfType("token")),
  "record-secret": typeOf("record-secret", "A record field of kind sealed. The plaintext is secret. A sealed reference is not the value.", [], ["sealed"]),
  "connection-credential": typeOf("connection-credential", "A connection's client secret or access-key secret.", keysOfType("connection-credential")),
  "invite-token": typeOf("invite-token", "An invite token that grants entry.", keysOfType("invite-token")),
});

const VAULT_KINDS = new Set(KINDS);
/** Vault item fields that are labels, not the secret the kind hands over. */
const VAULT_PUBLIC = new Set([
  "username", "account", "holder", "expiry", "name", "ssid", "filename", "email", "client_id", "tenant_id", "user_name", "rp_id",
  "credential_id", "user_handle", "sign_count", "company", "line1", "line2", "city", "region", "postal", "country", "phone", "type",
  "issued", "birthdate", "security", "label", "access_key_id", "chain", "config",
]);

const scope = new AsyncLocalStorage();
/** Secrets already seen on an agent call, so a later result cannot repeat them. Capped. @type {string[]} */
const remembered = [];
const rememberedSeen = new Set();

/**
 * A JSON schema for one secret-bearing field. A tool's input or output property spreads this.
 * @param {keyof typeof SECRET_FIELD_TYPES} secretType
 */
export function secretSchema(secretType) {
  const spec = SECRET_FIELD_TYPES[secretType];
  if (!spec) throw new Error(`unknown secret field type ${secretType}`);
  return { type: "string", secret: true, secretType };
}

/** A schema node tagged secret, or a record field whose kind is a secret type. @param {any} node */
export function schemaSaysSecret(node) {
  if (!node || typeof node !== "object") return false;
  if (node.secret === true) return true;
  if (typeof node.secretType === "string" && SECRET_FIELD_TYPES[/** @type {keyof typeof SECRET_FIELD_TYPES} */ (node.secretType)]) return true;
  if (typeof node.kind === "string" && SECRET_FIELD_TYPES["record-secret"].kinds.includes(node.kind)) return true;
  return false;
}

/**
 * A field of a vault item of `kind` is the secret that kind holds. Labels (a username, a client id) are not.
 * @param {string} kind @param {string} field
 */
export function vaultFieldIsSecret(kind, field) {
  const spec = SPEC[kind];
  if (!spec || VAULT_PUBLIC.has(field)) return false;
  const known = new Set([...(spec.need || []), ...(spec.take || []), ...(spec.fields || [])]);
  return known.has(field);
}

/** @param {string[]} values */
export function rememberSecrets(values) {
  for (const v of values || []) {
    if (typeof v !== "string" || v.length < 12 || rememberedSeen.has(v)) continue;
    rememberedSeen.add(v);
    remembered.push(v);
    if (remembered.length > 400) {
      const old = remembered.shift();
      if (old) rememberedSeen.delete(old);
    }
  }
}

/** @returns {string[] | null} secrets of the agent call now running, or null when this is not one */
export function secretScope() {
  const s = scope.getStore();
  return s && Array.isArray(s.secrets) ? s.secrets : null;
}

/** @param {string[]} secrets @returns {any} the scope this call replaced, so a nested call can put it back */
export function pushSecretScope(secrets) {
  const prev = scope.getStore() || null;
  const merged = [...((prev && prev.secrets) || []), ...secrets];
  scope.enterWith({ secrets: merged, prev });
  rememberSecrets(merged);
  return prev;
}

/** @param {any} prev */
export function popSecretScope(prev) {
  scope.enterWith(prev || null);
}

const isSealedRef = (/** @type {any} */ v) => v && typeof v === "object" && !Array.isArray(v) && typeof v.sealed === "string" && typeof v.ref === "string" && typeof v.present === "boolean";

/** @param {any} val @param {string[]} found */
function pull(val, found) {
  if (typeof val === "string") { if (val.length >= 8) found.push(val); return; }
  if (Array.isArray(val)) { for (const x of val) pull(x, found); return; }
  if (val && typeof val === "object") for (const x of Object.values(val)) pull(x, found);
}

/** Field names a schema list in this object marks secret (a sealed record field, or a property tagged secret). @param {any} obj */
function namesFrom(obj) {
  /** @type {Set<string>} */ const names = new Set();
  /** @type {any[]} */ const lists = [];
  if (Array.isArray(obj.fields) && obj.fields.every((/** @type {any} */ f) => f && typeof f === "object" && typeof f.name === "string")) lists.push(obj.fields);
  if (obj.schema && Array.isArray(obj.schema.fields)) lists.push(obj.schema.fields);
  for (const list of lists) for (const f of list) if (schemaSaysSecret(f) || egressNameIsSecret(f.name)) names.add(String(f.name));
  return names;
}

/** A card word whose field is a secret type. The path's last segment is the field name. @param {string} field */
function pathSecret(field) {
  const parts = String(field).split(/[.[\]]+/).filter(Boolean);
  return parts.some(p => egressNameIsSecret(p));
}

/**
 * @param {string} key @param {any} val @param {any} prop @param {any} parent @param {Set<string>} names @param {{ stripVaultValue?: boolean }} o
 */
function tagged(key, val, prop, parent, names, o) {
  if (prop && schemaSaysSecret(prop)) return true;
  // A field named secret or credential is stripped only when it carries a string (the value). Metadata
  // objects (a publish hold plan's grant, a connection template's empty key slot) stay and are walked.
  if (egressNameIsSecret(key) && typeof val === "string") return true;
  if (names.has(key) && typeof val === "string") return true;
  if (parent && typeof parent.kind === "string" && vaultFieldIsSecret(parent.kind, key)) return true;
  if (key === "value" && valueIsSecret(parent, prop, o)) return true;
  return false;
}

/** @param {any} parent @param {any} prop @param {{ stripVaultValue?: boolean }} o */
function valueIsSecret(parent, prop, o) {
  if (prop && schemaSaysSecret(prop)) return true;
  if (o.stripVaultValue) return true;
  if (!parent || typeof parent !== "object") return false;
  if (parent.secret === true || typeof parent.secretType === "string") return true;
  if (parent.kind === "sealed") return true;
  if (typeof parent.kind === "string" && VAULT_KINDS.has(parent.kind)) return true;
  if (typeof parent.expires_in_ms === "number") return true;
  return false;
}

/**
 * Drop secret-tagged values. Strings found there are returned so a copy in a message can be concealed too.
 * @param {any} value @param {{ schema?: any, secrets?: string[], stripVaultValue?: boolean }} [o]
 */
export function redactSecrets(value, o = {}) {
  /** @type {string[]} */ const found = [];
  const walked = walk(value, o.schema || null, found, new Set(), o);
  const all = [...found, ...(o.secrets || []), ...remembered];
  return { value: all.length ? scrubAll(walked, all, { min: 8 }) : walked, found };
}

/**
 * @param {any} v @param {any} schema @param {string[]} found @param {Set<string>} names @param {{ stripVaultValue?: boolean }} o
 * @returns {any}
 */
function walk(v, schema, found, names, o) {
  if (Array.isArray(v)) {
    if (v.length && v.every(x => x && typeof x === "object" && typeof x.field === "string" && typeof x.text === "string")) {
      return v.map(w => pathSecret(w.field) ? (pull(w.text, found), { ...w, text: "" }) : w);
    }
    return v.map((x, i) => walk(x, schema && schema.items, found, names, o));
  }
  if (!v || typeof v !== "object") return v;
  if (typeof v.field === "string" && typeof v.text === "string" && pathSecret(v.field)) {
    pull(v.text, found);
    return { ...v, text: "" };
  }
  const mine = new Set(names);
  for (const n of namesFrom(v)) mine.add(n);
  /** @type {Record<string, any>} */ const out = {};
  for (const [k, val] of Object.entries(v)) {
    const prop = schema && schema.properties ? schema.properties[k] : null;
    if (k === "fields" && val && typeof val === "object" && !Array.isArray(val) && typeof v.kind === "string" && VAULT_KINDS.has(v.kind)) {
      /** @type {Record<string, any>} */ const fields = {};
      for (const [fk, fv] of Object.entries(val)) {
        if (vaultFieldIsSecret(v.kind, fk) && !isSealedRef(fv)) { pull(fv, found); continue; }
        fields[fk] = walk(fv, null, found, mine, o);
      }
      out[k] = fields;
      continue;
    }
    if (tagged(k, val, prop, v, mine, o) && !isSealedRef(val) && (typeof val !== "boolean" && typeof val !== "number")) {
      pull(val, found);
      continue;
    }
    out[k] = walk(val, prop, found, mine, o);
  }
  return out;
}

/**
 * Secret strings in `input`, from tagged keys and from the input schema. The egress conceals these
 * wherever the tool copies them: a result, an error, a card line.
 * @param {any} input @param {any} [schema]
 * @returns {string[]}
 */
export function collectSecrets(input, schema) {
  const { found } = redactSecrets(input, { schema });
  return found;
}

/** Conceal secret strings in a log line written during an agent call. Other calls are unchanged. @param {unknown} msg */
export function redactLog(msg) {
  const secrets = secretScope();
  if (!secrets || !secrets.length) return msg;
  return scrub(String(msg ?? ""), secrets, { min: 8 });
}

/** @param {any} extra */
export function redactExtra(extra) {
  const secrets = secretScope();
  if (!secrets || extra == null) return extra;
  return redactSecrets(extra, { secrets }).value;
}

/** An event payload emitted during an agent call, with secret-tagged values removed. Other calls are unchanged. @param {any} payload */
export function scrubScopedPayload(payload) {
  const secrets = secretScope();
  if (!secrets) return payload;
  return redactSecrets(payload, { secrets }).value;
}
