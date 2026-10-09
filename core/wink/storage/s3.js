// @ts-check
// s3: the smallest signed-request client a storage device needs: AWS Signature Version 4 over node:crypto, and one cheap probe
// (ListObjectsV2 with max-keys 1, path style) that says whether the access details work. No SDK. The secret never leaves this file:
// it signs, it is not sent, and no message built here repeats it.

import crypto from "node:crypto";
import { isPrivateNetwork } from "../../../lib/netguard.js";
import { guardedFetch } from "../../../lib/http.js";

/** The endpoint is the person's own (checkEndpoint below), and an object can be large: every rule but the public-address one, and a 512 MB cap. */
const s3Fetch = guardedFetch({ allow: "any", maxBytes: 512 * 1024 * 1024 });

const hmac = (/** @type {crypto.BinaryLike | crypto.KeyObject} */ k, /** @type {string} */ d) => crypto.createHmac("sha256", /** @type {any} */ (k)).update(d).digest();
const hex = (/** @type {string | Buffer} */ d) => crypto.createHash("sha256").update(d).digest("hex");
/** RFC 3986 encoding as SigV4 wants it. @param {string} s */
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
export const EMPTY_SHA256 = hex("");

/**
 * Sign one request. Returns the headers to send (authorization, x-amz-date, x-amz-content-sha256) and the canonical request for tests.
 * @param {{ method: string, url: string, region: string, accessKey: string, secretKey: string, service?: string, date: Date, headers?: Record<string, string>, payloadHash?: string }} o
 */
export function signRequest(o) {
  const u = new URL(o.url);
  const amz = o.date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amz.slice(0, 8);
  const service = o.service || "s3";
  const payloadHash = o.payloadHash || EMPTY_SHA256;
  /** @type {Record<string, string>} */
  const hs = { host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz };
  for (const [k, v] of Object.entries(o.headers || {})) hs[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  const names = Object.keys(hs).sort();
  const canonicalHeaders = names.map(n => `${n}:${hs[n]}\n`).join("");
  const signed = names.join(";");
  const path = u.pathname.split("/").map(seg => enc(decodeURIComponent(seg))).join("/") || "/";
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [o.method.toUpperCase(), path, query, canonicalHeaders, signed, payloadHash].join("\n");
  const scope = `${day}/${o.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), o.region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return {
    canonical, signature,
    headers: { "x-amz-date": amz, "x-amz-content-sha256": payloadHash, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` },
  };
}

const privateHost = (/** @type {string} */ h) => /^(localhost|[a-z0-9-]+\.local)$/i.test(h) || isPrivateNetwork(h.replace(/^\[|\]$/g, ""));   // lib/netguard.js decides the addresses

/**
 * Check an endpoint before any secret is signed for it. Plain http is for machines on a private network only.
 * @param {string} endpoint @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function checkEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return { ok: false, reason: "The address is not a web address. It should look like https://s3.example.com." }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: "The address must start with https://." };
  if (u.username || u.password) return { ok: false, reason: "Leave the name and password out of the address; they go in their own boxes." };
  if (u.protocol === "http:" && !privateHost(u.hostname)) return { ok: false, reason: "That address is not encrypted and is on the internet. Use https://, or an address on your own network." };
  return { ok: true, url: u };
}

/** @param {string} body */
const errorCode = body => (/<Code>([^<]{1,64})<\/Code>/.exec(body) || [])[1] || "";

/** What went wrong, in plain words. Never repeats a secret. @param {number} status @param {string} code */
export function whyFailed(status, code) {
  if (code === "InvalidAccessKeyId") return "The provider does not know that access ID. Check it for a typo or an extra space.";
  if (code === "SignatureDoesNotMatch") return "The provider rejected the secret that goes with that access ID. Check the secret and the region.";
  if (code === "NoSuchBucket" || status === 404) return "The provider has no bucket with that name. Check the name and the region.";
  if (code === "AccessDenied" || status === 403) return "The login works but is not allowed to list that bucket. Give it read and write access to the bucket.";
  if (code === "AuthorizationHeaderMalformed" || code === "InvalidRegion" || code === "PermanentRedirect" || status === 301) return "The bucket is in a different region than the one given. Check the region.";
  if (code === "RequestTimeTooSkewed") return "The clocks do not agree. Check the date and time on this server.";
  if (status === 429 || status === 503) return "The provider is busy or limiting requests. Try again in a minute.";
  if (status >= 500) return "The provider had a problem on its side. Try again in a minute.";
  return `The provider said no (${status}${code ? ", " + code : ""}). Check the address, bucket, region and login.`;
}

/**
 * @param {{ fetch?: typeof fetch, now?: () => number, timeoutMs?: number }} [o]
 */
export function createS3({ fetch: f = s3Fetch, now = Date.now, timeoutMs = 10_000 } = {}) {
  return {
    /**
     * Does this login work on this bucket? One ListObjectsV2 with max-keys 1.
     * @param {{ endpoint: string, bucket: string, region: string, accessKey: string, secretKey: string }} c
     * @returns {Promise<{ ok: true } | { ok: false, reason: string, code: string }>}
     */
    async probe(c) {
      const e = checkEndpoint(c.endpoint);
      if (!e.ok) return { ok: false, reason: e.reason, code: "endpoint" };
      if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(String(c.bucket))) return { ok: false, reason: "A bucket name is 3 to 63 lowercase letters, numbers, dots or dashes.", code: "bucket" };
      const url = new URL(e.url.href);
      url.pathname = `${e.url.pathname.replace(/\/+$/, "")}/${c.bucket}`;
      url.search = "";
      url.searchParams.set("list-type", "2");
      url.searchParams.set("max-keys", "1");
      const s = signRequest({ method: "GET", url: url.href, region: String(c.region || "us-east-1"), accessKey: String(c.accessKey), secretKey: String(c.secretKey), date: new Date(now()) });
      try {
        const r = await f(url.href, { method: "GET", headers: s.headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 200) { await r.arrayBuffer().catch(() => {}); return { ok: true }; }
        const code = errorCode((await r.text().catch(() => "")).slice(0, 4000));
        return { ok: false, reason: whyFailed(r.status, code), code: code || String(r.status) };
      } catch (err) {
        const timed = /** @type {Error} */ (err).name === "TimeoutError" || /** @type {Error} */ (err).name === "AbortError";
        return { ok: false, reason: timed ? "The provider did not answer in time. Check the address, or try again." : "Could not reach that address. Check it for a typo and that this server is online.", code: timed ? "timeout" : "unreachable" };
      }
    },
  };
}
