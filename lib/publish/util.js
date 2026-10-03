// @ts-check
// lib/publish/util.js: the typed error, id and name validators, and small pure helpers shared by the Publish files.
// Pure: only node built-ins. Source: team/0.3/SPEC-core-contract.md section 13.

import { createHash, timingSafeEqual } from "node:crypto";

export const ERROR_CODES = Object.freeze([
  "bad_input", "not_found", "duplicate", "illegal_transition", "forbidden", "needs_approval", "model_cannot_approve",
  "not_approver", "approval_mismatch", "sealed_in_build", "secret_in_build", "build_unverifiable", "isolation",
  "bad_domain", "domain_limit", "domain_unverified", "domain_taken", "bad_secret", "not_production", "no_previous", "flow_invalid",
]);

export class PublishError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [detail] */
  constructor(code, message, detail) {
    super(message);
    this.name = "PublishError";
    this.code = code;
    this.detail = detail || {};
  }
}

/** @param {string} code @param {string} message @param {Record<string, unknown>} [detail] @returns {never} */
export const fail = (code, message, detail) => { throw new PublishError(code, message, detail); };

export const SPACE_RE = /^spc_[a-z0-9]{12}$/;
export const DEPLOYMENT_ID_RE = /^dep_[0-9a-f]{16}$/;
export const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
export const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
export const SECRET_REF_RE = /^vault:\/\/[A-Za-z0-9][A-Za-z0-9._~\/-]{0,199}$/;

/** Env names that belong to the space, the home unit, the control plane or the host. Never passed to a published workload. */
export const SPACE_ENV_PREFIXES = Object.freeze([
  "VYRE_", "SPACE_", "WINK_", "TWENTY_", "POSTGRES_", "PG", "DATABASE_", "DOCKER_", "TS_", "TAILSCALE_", "CONTROL_", "VAULT_", "HOME_", "ROOT_KEY",
]);
export const isSpaceEnvName = (/** @type {string} */ n) => SPACE_ENV_PREFIXES.some(p => n.startsWith(p)) || /(^|_)(PASSWORD|TOKEN|SECRET|PRIVATE_KEY|API_KEY)($|_)/.test(n);

export const sha256hex = (/** @type {string|Uint8Array} */ v) => createHash("sha256").update(v).digest("hex");

/** Canonical JSON: keys sorted, no whitespace. Deterministic across runs. */
export function canonical(/** @type {any} */ v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

export const b64url = (/** @type {Uint8Array} */ buf) => Buffer.from(buf).toString("base64url");

/** Constant-time string equality. */
export function safeEqual(/** @type {string} */ a, /** @type {string} */ b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

/** @param {any} chain */
export function assertChain(chain) {
  if (!chain || typeof chain !== "object" || !Array.isArray(chain.hops) || chain.hops.length === 0 || typeof chain.space !== "string") fail("bad_input", "a kernel-built chain is required");
  return chain;
}

/** True if any hop of the chain is a model (an `agent`). */
export const chainHasModel = (/** @type {any} */ chain) => !!chain && Array.isArray(chain.hops) && chain.hops.some((/** @type {any} */ h) => h && h.actor && h.actor.kind === "agent");

/**
 * The person who decided, or a typed refusal. Exactly one hop, and it is a person (the task rule: a model can never approve).
 * @param {any} by @param {string} space @returns {string} the person actor id
 */
export function humanDecider(by, space) {
  if (!by || !Array.isArray(by.hops) || by.hops.length === 0) fail("needs_approval", "an approval by a person is required");
  if (chainHasModel(by)) fail("model_cannot_approve", "a model can never approve; a person must decide");
  if (by.hops.length !== 1 || by.hops[0].actor.kind !== "person") fail("model_cannot_approve", "the approval chain must be exactly one person");
  if (by.space !== space || by.hops[0].actor.space !== space) fail("forbidden", "the approver is not a member of this space");
  return by.hops[0].actor.id;
}

export const deploymentUrn = (/** @type {string} */ space, /** @type {string} */ id) => `vyre://${space}/deployment/${id}`;
export const secretUrn = (/** @type {string} */ space, /** @type {string} */ ref) => `vyre://${space}/secret/${ref.replace(/^vault:\/\//, "")}`;

/** Freeze deeply, for definitions. */
export function deepFreeze(/** @type {any} */ o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
}
