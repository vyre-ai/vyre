// @ts-check
// directory: the client for the hosted name directory (names/worker, plan section 3.1). A box
// claims, points and proves its name there; the directory alone holds the vyre.run DNS credential.
//
// Every call is signed with the box's relay route key (ADR 0026): a signature over the route, the
// time, a fresh nonce, the method, the path and the body's hash. The key never comes in here. The
// `signer` is two calls the relay side answers (relay.route.id and relay.route.sign, see index.js),
// and only a message that starts with this service's tag and the caller's own route is ever signed,
// so the route key is not a general signing oracle. `fetch` is injectable for tests.

import crypto from "node:crypto";

export const AUTH_TAG = "vyre-names-v1";
export const DEFAULT_BASE = "https://names.vyre.run";
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The bytes the box signs. names/worker/index.js authMessage builds the same. @param {{ route: string, ts: number|string, nonce: string, method: string, target: string, bodyHash: string }} m */
export const authMessage = m => Buffer.from(`${AUTH_TAG}\n${m.route}\n${m.ts}\n${m.nonce}\n${m.method}\n${m.target}\n${m.bodyHash}`);

/**
 * @typedef {{ identity(): Promise<{ route: string, pub: Buffer }>, sign(message: Buffer): Promise<Buffer> }} Signer
 * @param {{ base?: string, signer: Signer, fetch?: typeof globalThis.fetch, now?: () => number, timeoutMs?: number }} o
 */
export function directory({ base = DEFAULT_BASE, signer, fetch = globalThis.fetch, now = Date.now, timeoutMs = 20_000 }) {
  const root = String(base).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(root)) throw new Error("the directory address must be http(s)");
  /** @param {string} method @param {string} target path and query @param {object} [body] @param {boolean} [sign] */
  async function call(method, target, body, sign = true) {
    // A test can never reach the hosted directory (a real claim there is permanent): under a test
    // runner, or VYRE_TEST, the real fetch refuses any host but loopback. A test passes a fake URL
    // on 127.0.0.1, or its own `fetch`. Checked at the call, not at construction, so a daemon test
    // that merely starts the names module still starts.
    if ((process.env.NODE_TEST_CONTEXT || process.env.VYRE_TEST) && fetch === globalThis.fetch && !LOOPBACK.has(new URL(root).hostname)) {
      throw Object.assign(new Error(`tests never call the hosted name directory (${new URL(root).hostname}); pass a fake URL on 127.0.0.1 or your own fetch`), { code: "test_guard" });
    }
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers = /** @type {Record<string, string>} */ ({ accept: "application/json" });
    if (text) headers["content-type"] = "application/json";
    if (sign) {
      const { route, pub } = await signer.identity();
      const ts = now(), nonce = crypto.randomBytes(16).toString("base64url");
      const sig = await signer.sign(authMessage({ route, ts, nonce, method, target, bodyHash: crypto.createHash("sha256").update(text).digest("hex") }));
      Object.assign(headers, { "x-vyre-route": route, "x-vyre-pub": Buffer.from(pub).toString("base64url"), "x-vyre-ts": String(ts), "x-vyre-nonce": nonce, "x-vyre-sig": Buffer.from(sig).toString("base64url") });
    }
    let res;
    try { res = await fetch(root + target, { method, headers, body: text || undefined, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) { throw Object.assign(new Error(`the name directory is not reachable (${/** @type {any} */ (e).cause?.code || /** @type {Error} */ (e).name || "network error"})`), { code: "unreachable", status: 0 }); }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.error || !json.data) {
      const e = (json && json.error) || {};
      throw Object.assign(new Error(String(e.message || `the name directory answered ${res.status}`)), { code: String(e.code || "directory"), status: res.status });
    }
    return json.data;
  }

  return {
    base: root,
    /** ok, taken, reserved, invalid or mine. @param {string} name */
    check: name => call("GET", `/v1/names/check?name=${encodeURIComponent(name)}`),
    /** Bind the name to this box's route. `code` is the one-time recovery code, null when it was already claimed here. @param {string} name @returns {Promise<{ name: string, mine: boolean, code: string|null }>} */
    claim: name => call("POST", "/v1/names/claim", { name }),
    /** @param {string} name @param {string} ip */
    point: (name, ip) => call("POST", "/v1/names/point", { name, ip }),
    /** The name's A record becomes the public IPv4 this request comes from (never one the caller names): for a box that serves its own network gate. @param {string} name */
    publish: name => call("POST", "/v1/names/publish", { name }),
    /** @param {string} name @param {string} token */
    acme: (name, token) => call("POST", "/v1/names/acme", { name, token }),
    /** @param {string} name */
    acmeClear: name => call("DELETE", "/v1/names/acme", { name }),
    /** A challenge for the person's own domain, under <routehash>.acme.vyre.run. @param {string} token */
    acmeOwn: token => call("POST", "/v1/names/acme", { own: true, token }),
    acmeOwnClear: () => call("DELETE", "/v1/names/acme", { own: true }),
    /** @param {{ name: string, code: string, next: string }} r @returns {Promise<{ name: string, pendingUntil: number }>} */
    recover: r => call("POST", "/v1/names/recover", r),
    /** @param {string} name */
    cancel: name => call("POST", "/v1/names/recover/cancel", { name }),
    /** @param {string} name @param {string} next the hash of the new recovery code */
    rotate: (name, next) => call("POST", "/v1/names/code", { name, next }),
    /** @param {string} name */
    release: name => call("POST", "/v1/names/release", { name }),
    /** This route's name, its state, a pending recovery and the notices. */
    mine: () => call("GET", "/v1/names/mine"),
  };
}
