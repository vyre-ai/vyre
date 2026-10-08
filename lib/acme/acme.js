// @ts-check
// acme — a small RFC 8555 client that gets a certificate by DNS-01.
//
// DNS-01 is the only challenge that works for a name resolving to a tailnet address: the CA
// cannot reach the box, but it can read a TXT record. The DNS side is an adapter
// ({ set(fqdn, value) -> handle, clear(handle) }) so the same client works with the user's
// Cloudflare token today and the hosted name directory later.
//
// Every TXT record that gets set is cleared in a finally, whatever happens. A failed run must
// not leave challenge records lying in someone's zone.

import crypto from "node:crypto";
import { csr } from "./csr.js";

export const DIRECTORIES = {
  production: "https://acme-v02.api.letsencrypt.org/directory",
  staging: "https://acme-staging-v02.api.letsencrypt.org/directory",
};

const b64u = (/** @type {Buffer|string} */ b) => Buffer.from(b).toString("base64url");

/** A fresh EC P-256 private key as PKCS#8 PEM. */
export function newKey() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return /** @type {string} */ (privateKey.export({ type: "pkcs8", format: "pem" }));
}

/** The public JWK of an EC key, members in RFC 7638 order. */
function jwkOf(key) {
  const j = /** @type {any} */ (crypto.createPublicKey(key).export({ format: "jwk" }));
  if (j.kty !== "EC" || j.crv !== "P-256") throw new Error("the ACME account key must be EC P-256");
  return { crv: j.crv, kty: j.kty, x: j.x, y: j.y };
}

/** RFC 7638 thumbprint: SHA-256 over the required members, sorted, no whitespace. */
export function thumbprint(jwk) {
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return b64u(crypto.createHash("sha256").update(canon).digest());
}

/** An Error carrying an ACME problem document. */
function problemError(problem, fallback) {
  const p = problem && typeof problem === "object" ? problem : { type: "about:blank", detail: fallback };
  let msg = `${p.type || "about:blank"}: ${p.detail || fallback || "no detail"}`;
  for (const sp of p.subproblems || []) msg += `; ${sp.identifier ? sp.identifier.value + " " : ""}${sp.type}: ${sp.detail || ""}`;
  const err = /** @type {Error & { problem?: any }} */ (new Error(msg));
  err.problem = p;
  return err;
}

/** Milliseconds since the epoch at which the first certificate in a PEM stops being valid. */
export function expiry(pem) {
  const first = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!first) throw new Error("no certificate in PEM");
  return Date.parse(new crypto.X509Certificate(first[0]).validTo);
}

/** True when every name is in the certificate's alternative names (a wildcard `*.x` only by that exact entry). @param {string} pem @param {string[]} names */
export function covers(pem, names) {
  try {
    const first = String(pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
    if (!first) return false;
    const have = String(new crypto.X509Certificate(first[0]).subjectAltName || "").split(",").map(x => x.trim()).filter(x => x.startsWith("DNS:")).map(x => x.slice(4).toLowerCase());
    return names.every(n => have.includes(String(n).toLowerCase()));
  } catch { return false; }
}

/** True when the certificate is gone or within `days` of expiring. */
export function needsRenewal(pem, now = Date.now(), days = 30) {
  let t;
  try { t = expiry(pem); } catch { return true; }
  return t - now <= days * 86400000;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Get a certificate for `names` by DNS-01.
 * @param {{ names: string[], directory: string, accountKey: string, certKey?: string, email?: string,
 *   dns: { set(fqdn: string, value: string): Promise<any>, clear(handle: any): Promise<any> },
 *   fetch?: typeof globalThis.fetch, log?: (msg: string) => void,
 *   waitDns?: (fqdn: string, value: string) => Promise<any>, onAccount?: (accountUri: string) => Promise<any>, pollMs?: number, timeoutMs?: number }} opts
 *   `onAccount` runs once the ACME account exists and BEFORE the order, with its URI: a CAA record that pins issuance to this account is set there (PT-1).
 * @returns {Promise<{ cert: string, key: string, expires: number, accountUri: string }>}
 */
export async function issue({ names, directory, accountKey, certKey, email, dns, fetch = globalThis.fetch, log = () => {}, waitDns, onAccount, pollMs = 2000, timeoutMs = 180000 }) {
  if (!Array.isArray(names) || names.length === 0) throw new Error("issue needs at least one name");
  const deadline = Date.now() + timeoutMs;
  const account = crypto.createPrivateKey(accountKey);
  const jwk = jwkOf(account);
  const thumb = thumbprint(jwk);

  const dirRes = await fetch(directory, { headers: { accept: "application/json" } });
  if (!dirRes.ok) throw new Error(`ACME directory ${directory} answered ${dirRes.status}`);
  const dir = /** @type {any} */ (await dirRes.json());

  /** @type {string|null} */ let nonce = null;
  /** @type {string|null} */ let kid = null;
  const keep = res => { const n = res.headers.get("replay-nonce"); if (n) nonce = n; };

  async function freshNonce() {
    const res = await fetch(dir.newNonce, { method: "HEAD" });
    keep(res);
    if (!nonce) throw new Error("ACME server gave no nonce");
  }

  /** Signed POST. payload null means POST-as-GET. Retries once on badNonce, as RFC 8555 allows. */
  async function post(url, payload, { accept = "application/json", retried = false } = {}) {
    if (!nonce) await freshNonce();
    const protectedHeader = { alg: "ES256", nonce, url, ...(kid ? { kid } : { jwk }) };
    nonce = null; // a nonce is good for one request only
    const p = b64u(JSON.stringify(protectedHeader));
    const body = payload === null ? "" : b64u(JSON.stringify(payload));
    const sig = crypto.sign("sha256", Buffer.from(`${p}.${body}`), { key: account, dsaEncoding: "ieee-p1363" });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/jose+json", accept },
      body: JSON.stringify({ protected: p, payload: body, signature: b64u(sig) }),
    });
    keep(res);
    if (res.status >= 400) {
      let problem = null;
      try { problem = await res.json(); } catch { /* not JSON */ }
      if (problem && problem.type === "urn:ietf:params:acme:error:badNonce" && !retried) {
        log("acme: bad nonce, retrying once");
        return post(url, payload, { accept, retried: true });
      }
      throw problemError(problem, `${url} answered ${res.status}`);
    }
    return res;
  }

  const getJson = async url => /** @type {any} */ (await (await post(url, null)).json());

  async function poll(url, done, what) {
    for (;;) {
      const obj = await getJson(url);
      if (done(obj)) return obj;
      if (obj.status === "invalid") {
        const err = obj.error || (obj.challenges || []).map(c => c.error).find(Boolean);
        throw problemError(err, `${what} became invalid`);
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (status ${obj.status})`);
      await sleep(pollMs);
    }
  }

  // Account. newAccount returns the existing account for this key if there is one.
  const accRes = await post(dir.newAccount, { termsOfServiceAgreed: true, ...(email ? { contact: [`mailto:${email}`] } : {}) });
  kid = accRes.headers.get("location");
  if (!kid) throw new Error("ACME newAccount gave no account URL");
  log(`acme: account ${accRes.status === 201 ? "created" : "found"}`);
  if (onAccount) await onAccount(kid);

  // Order.
  const orderRes = await post(dir.newOrder, { identifiers: names.map(value => ({ type: "dns", value })) });
  const orderUrl = orderRes.headers.get("location");
  let order = /** @type {any} */ (await orderRes.json());
  if (!orderUrl) throw new Error("ACME newOrder gave no order URL");
  log(`acme: order for ${names.join(", ")}`);

  // Challenges. Set every TXT first, then answer, so propagation waits overlap.
  const handles = [];
  try {
    const pending = [];
    for (const authzUrl of order.authorizations) {
      const authz = await getJson(authzUrl);
      if (authz.status === "valid") continue;
      const ch = (authz.challenges || []).find(c => c.type === "dns-01");
      if (!ch) throw new Error(`no dns-01 challenge offered for ${authz.identifier && authz.identifier.value}`);
      const fqdn = "_acme-challenge." + authz.identifier.value;
      const value = b64u(crypto.createHash("sha256").update(`${ch.token}.${thumb}`).digest());
      handles.push(await dns.set(fqdn, value));
      pending.push({ authzUrl, ch, fqdn, value });
    }
    for (const p of pending) if (waitDns) await waitDns(p.fqdn, p.value);
    for (const p of pending) {
      await post(p.ch.url, {});
      await poll(p.authzUrl, a => a.status === "valid", `authorization for ${p.fqdn}`);
      log(`acme: ${p.fqdn} valid`);
    }
  } finally {
    for (const h of handles) {
      try { await dns.clear(h); } catch (err) { log(`acme: could not clear a challenge record: ${/** @type {Error} */ (err).message}`); }
    }
  }

  // Finalize with a CSR for a certificate key that never leaves this machine.
  const certPem = certKey || newKey();
  const der = csr(names, crypto.createPrivateKey(certPem));
  await post(order.finalize, { csr: b64u(der) });
  order = await poll(orderUrl, o => o.status === "valid" && o.certificate, "order");
  const certRes = await post(order.certificate, null, { accept: "application/pem-certificate-chain" });
  const cert = await certRes.text();
  log("acme: certificate issued");
  return { cert, key: certPem, expires: expiry(cert), accountUri: /** @type {string} */ (kid) };
}
