// @ts-check
// lib/mcp-probe: what a catalog row's server asks for, read from the vendor's own discovery documents (RFC 9728 for the
// resource, RFC 8414 for the authorization server). It answers one question per row, for the catalog and the Connect screen:
//   dcr-advertised  the server names a registration endpoint: a client can register itself, so there is no app to make.
//   needs-client    no registration endpoint: the client id must come from the vendor (a developer app, a secret, or a token method the vendor issues).
//   no-oauth        no OAuth metadata at all: a token or nothing.
//   refused         the documents name another origin, use http, or are not about this server (RFC 9728 3.3).
// It never registers, never posts and never sends a token: the registration endpoint is named, never called. The fetch is
// injected; the default is the connector's own fetch, which refuses private and loopback addresses.

import { discoverResource, discoverAuthServer } from "./connectors/oauth.js";

/**
 * @typedef {{ url: string, result: "dcr-advertised" | "needs-client" | "no-oauth" | "refused",
 *   issuer: string | null, registration: boolean, pkce_s256: boolean | null, token_auth: string[], reason: string }} Probe
 */

/**
 * @param {string} url the server's remote address, as the catalog lists it
 * @param {typeof fetch} [f] injected for tests; undefined uses the connector's own fetch
 * @returns {Promise<Probe>}
 */
export async function probeServer(url, f) {
  /** @type {Probe} */
  const base = { url: String(url), result: "refused", issuer: null, registration: false, pkce_s256: null, token_auth: [], reason: "" };
  let u;
  try { u = new URL(String(url)); } catch { return { ...base, reason: "not an address" }; }
  if (u.protocol !== "https:") return { ...base, reason: "only https addresses are probed" };
  try {
    const resource = await discoverResource(String(url), f);
    const issuer = resource ? resource.issuer : u.origin;
    const as = await discoverAuthServer(issuer, f, { strict: true });
    const registration = Boolean(as.registration_endpoint);
    const result = registration ? "dcr-advertised" : "needs-client";
    return { url: base.url, result, issuer: as.issuer, registration, pkce_s256: as.code_challenge_methods.includes("S256"), token_auth: as.token_auth_methods,
      reason: registration ? "the server names a registration endpoint; it was not called" : "no registration endpoint: a client id must come from the vendor" };
  } catch (e) {
    const code = /** @type {any} */ (e) && /** @type {any} */ (e).code;
    const reason = String(/** @type {any} */ (e) && /** @type {any} */ (e).message || e).slice(0, 200);
    return { ...base, result: code === "no_metadata" ? "no-oauth" : "refused", reason };
  }
}
