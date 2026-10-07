// @ts-check
// lib/publish/domains.js: connect a domain (your own, or <label>.vyre.run) to a deployment.
//
//   addDomain -> the DNS challenge: a TXT at _vyre-publish.<domain> whose value is bound to the space, the site and the host
//   verifyDomain -> checks it through an injected TXT resolver; only a verified domain ever reaches the Caddyfile
//   removeDomain, limits per space
// Pure over records: the caller keeps the list. DNS and the names directory are injected.

import { createHash } from "node:crypto";
import { fail, safeEqual, b64url, SPACE_RE, DEPLOYMENT_ID_RE } from "./util.js";
import { normalizeHost } from "./hostname.js";

export const DEFAULT_LIMITS = Object.freeze({ perSpace: 10, pendingPerSpace: 5, tokenTtlMs: 7 * 24 * 60 * 60 * 1000 });
export const CHALLENGE_LABEL = "_vyre-publish";

/** @param {string} space @param {string} boundTo @param {string} host @param {string} nonce */
const proofOf = (space, boundTo, host, nonce) => b64url(createHash("sha256").update(`vyre-publish-v1|${space}|${boundTo}|${host}|${nonce}`).digest()).slice(0, 32);

/**
 * @typedef {{ host: string, unicode: string, space: string, bound_to: string, deployment: string, method: "dns" | "names", status: "pending" | "verified",
 *   nonce?: string, created_at: number, expires_at?: number, verified_at?: number, canonical?: "apex" | "www" | null, www?: boolean }} DomainRecord
 */

/**
 * Start connecting a domain. Returns the record to store and the challenge to show.
 * @param {{ host: string, space: string, deployment: string, canonical?: "apex" | "www" | null, www?: boolean }} input
 * @param {{ existing: DomainRecord[], now: number, random(n: number): Uint8Array, limits?: Partial<typeof DEFAULT_LIMITS> }} deps
 * @returns {{ record: DomainRecord, challenge: { type: "TXT", name: string, value: string, expires_at: number } | { type: "names", host: string } }}
 */
export function addDomain(input, deps) {
  if (!SPACE_RE.test(input.space) || !DEPLOYMENT_ID_RE.test(input.deployment)) fail("bad_input", "a space and a deployment are required");
  const h = normalizeHost(input.host);
  const limits = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const bare = h.ascii.replace(/^www\./, "");
  for (const r of deps.existing) {
    if (r.host === h.ascii) fail("domain_taken", "that domain is already connected in this space");
    if (r.host.replace(/^www\./, "") === bare && (r.host === "www." + bare || h.ascii === "www." + bare)) fail("domain_taken", "the domain and its www version are connected together; use the one already added");
  }
  if (deps.existing.length >= limits.perSpace) fail("domain_limit", `a space can connect ${limits.perSpace} domains`);
  if (deps.existing.filter(r => r.status === "pending").length >= limits.pendingPerSpace) fail("domain_limit", "finish verifying the domains already waiting first");
  /** @type {DomainRecord} */
  const base = { host: h.ascii, unicode: h.unicode, space: input.space, bound_to: input.deployment, deployment: input.deployment, method: h.vyre_run ? "names" : "dns", status: "pending", created_at: deps.now, canonical: input.canonical ?? null, ...(input.www === undefined ? {} : { www: input.www }) };
  if (h.vyre_run) return { record: base, challenge: { type: "names", host: h.ascii } };
  const nonce = b64url(deps.random(12));
  const value = `vyre-publish=${nonce}.${proofOf(input.space, input.deployment, h.ascii, nonce)}`;
  const expires_at = deps.now + limits.tokenTtlMs;
  return { record: { ...base, nonce, expires_at }, challenge: { type: "TXT", name: `${CHALLENGE_LABEL}.${h.ascii}`, value, expires_at } };
}

/** The challenge for a pending record, for showing again. @param {DomainRecord} r */
export function challengeOf(r) {
  if (r.method === "names") return { type: /** @type {const} */ ("names"), host: r.host };
  return { type: /** @type {const} */ ("TXT"), name: `${CHALLENGE_LABEL}.${r.host}`, value: `vyre-publish=${r.nonce}.${proofOf(r.space, r.bound_to, r.host, /** @type {string} */ (r.nonce))}`, expires_at: r.expires_at };
}

/**
 * Check the challenge. Never throws on a missing record: it says what is missing.
 * @param {DomainRecord} record
 * @param {{ dns: { resolveTxt(name: string): Promise<string[][]> }, names?: { owns(host: string, space: string): Promise<boolean> | boolean }, now: number }} deps
 * @returns {Promise<{ verified: boolean, reason?: "no_record" | "mismatch" | "expired" | "not_owner", record: DomainRecord }>}
 */
export async function verifyDomain(record, deps) {
  if (record.status === "verified") return { verified: true, record };
  if (record.method === "names") {
    const ok = !!deps.names && await deps.names.owns(record.host, record.space);
    if (!ok) return { verified: false, reason: "not_owner", record };
    return { verified: true, record: { ...record, status: "verified", verified_at: deps.now } };
  }
  if (typeof record.expires_at === "number" && deps.now > record.expires_at) return { verified: false, reason: "expired", record };
  const expected = challengeOf(record);
  if (expected.type !== "TXT") return { verified: false, reason: "mismatch", record };
  let answers;
  try { answers = await deps.dns.resolveTxt(expected.name); } catch { return { verified: false, reason: "no_record", record }; }
  const values = (Array.isArray(answers) ? answers : []).map(chunks => (Array.isArray(chunks) ? chunks.join("") : String(chunks)).trim());
  if (!values.length) return { verified: false, reason: "no_record", record };
  if (!values.some(v => safeEqual(v, expected.value))) return { verified: false, reason: "mismatch", record };
  return { verified: true, record: { ...record, status: "verified", verified_at: deps.now } };
}

/** Remove a domain from the list. @param {DomainRecord[]} existing @param {string} host */
export function removeDomain(existing, host) {
  const ascii = normalizeHost(host).ascii;
  if (!existing.some(r => r.host === ascii)) fail("not_found", "that domain is not connected");
  return existing.filter(r => r.host !== ascii);
}

/** Point a verified domain at a newer version of the same site (the TXT proof stays bound to the first). @param {DomainRecord} r @param {string} deployment */
export const rebind = (r, deployment) => { if (!DEPLOYMENT_ID_RE.test(deployment)) fail("bad_input", "bad deployment id"); return { ...r, deployment }; };

/** What the Caddyfile gets: verified domains only. @param {DomainRecord[]} records */
export const forCaddy = records => records.filter(r => r.status === "verified").map(r => ({ host: r.host, verified: true, deployment: r.deployment, canonical: r.canonical ?? null, ...(r.www === undefined ? {} : { www: r.www }) }));
