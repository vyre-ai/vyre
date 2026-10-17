// @ts-check
// connection-revoke: when a person takes their app connection away, the vendor is told too (RFC 7009 token revocation) where the connection says how, so a copied token stops working at the vendor and not only here.
// The connection item names the endpoint (`revocation_endpoint`, an https address recorded when it was connected); a connection without one is only removed on our side, and this says so. The refresh token is sent
// to that endpoint and nowhere else, over the guarded fetch (no private addresses, no redirects). Nothing here returns a token.

import { httpFetch } from "../../lib/http.js";

/**
 * @param {{ people: { get: (id: string, q: { name: string }) => Promise<{ kind?: string, fields: Record<string, string> }> }, fetch?: typeof httpFetch }} d
 * @param {{ owner: string, connection: string }} i
 * @returns {Promise<{ revoked: boolean, why: string }>}
 */
export async function revokeAtVendor({ people, fetch: f = httpFetch }, { owner, connection }) {
  const it = await people.get(owner, { name: connection });
  if (it.kind !== "connection") return { revoked: false, why: "not a connection" };
  const fields = it.fields || {};
  const endpoint = String(fields.revocation_endpoint || "");
  const token = String(fields.refresh_token || fields.access_token || "");
  if (!endpoint) return { revoked: false, why: "the vendor named no revocation address, so the token is not revoked there" };
  if (!token) return { revoked: false, why: "there is no token to revoke" };
  let url;
  try { url = new URL(endpoint); } catch { return { revoked: false, why: "the recorded revocation address is not an address" }; }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) return { revoked: false, why: "the recorded revocation address is not https" };   // plain http only for this machine, which the guarded fetch itself allows only under tests
  const body = new URLSearchParams({ token, token_type_hint: fields.refresh_token ? "refresh_token" : "access_token", ...(fields.client_id ? { client_id: fields.client_id } : {}), ...(fields.client_secret ? { client_secret: fields.client_secret } : {}) });
  try {
    const res = await f(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString(), redirect: "manual", signal: AbortSignal.timeout(15_000) });
    // RFC 7009: 200 means revoked or already invalid; an unsupported token type or a server error means we cannot say
    return res.status === 200 ? { revoked: true, why: "revoked at the vendor" } : { revoked: false, why: `the vendor answered ${res.status}` };
  } catch (e) {
    return { revoked: false, why: "the vendor could not be reached" };
  }
}
