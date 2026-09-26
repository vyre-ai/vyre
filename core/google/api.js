// @ts-check
// api: one authenticated call to Google Calendar or Gmail, for one account, with one scope.
//
// Every call names the single scope it needs (ADR 0016 decision 6), so a token minted to read the
// calendar can never write it, and a send token is minted only at the moment of sending. The
// token comes from the shared credential library, which caches it in memory; a 401 means Google
// stopped taking it, so it is dropped and minted once more, and a second 401 is an answer.
//
// Rules, and why:
// - Redirects are refused: a redirect would carry the bearer token to a host nobody named.
// - Errors carry Google's own message, scrubbed of every value the library has touched, and never
//   the request: a query or a body can hold what the person typed.
// - A timeout on every call. A hung Google must not hang the Capsule or a model's turn.

const TIMEOUT_MS = 30_000;
const MAX_BYTES = 5_000_000;

export const SCOPE = "https://www.googleapis.com/auth/";
/** The short scope names this module uses, as google.test reports them. */
export const SCOPES = ["calendar.readonly", "calendar.events", "gmail.readonly", "gmail.compose", "gmail.send"];
export const DEFAULT_BASE = { calendar: "https://www.googleapis.com", gmail: "https://gmail.googleapis.com" };

/** An API refusal or outage, with Google's status. */
export class GoogleError extends Error {
  /** @param {string} message @param {{ status?: number, code?: string }} [info] */
  constructor(message, info = {}) {
    super(message);
    this.name = "GoogleError";
    this.code = info.code || "google";
    if (info.status) this.status = info.status;
  }
}

/**
 * @typedef {{ name: string, email: string, auth: import("../connectors/auth.js").Auth, base?: string | null }} Account
 * @typedef {{ api: "calendar" | "gmail", scope: string, method?: string, path: string,
 *   query?: Record<string, string | number | boolean | string[] | undefined>, body?: any }} Request
 */

/**
 * A client bound to one Credentials instance.
 * @param {{ creds: import("../connectors/auth.js").Credentials, fetch?: typeof fetch }} deps
 */
export function client({ creds, fetch: f = globalThis.fetch }) {
  /**
   * @param {Account} acct @param {Request} req @returns {Promise<any>}
   */
  async function request(acct, req) {
    const scopes = [SCOPE + req.scope];
    const url = new URL((acct.base || DEFAULT_BASE[req.api]).replace(/\/+$/, "") + req.path);
    for (const [k, v] of Object.entries(req.query || {})) {
      if (v === undefined || v === null) continue;
      for (const one of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(one));
    }
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(await creds.headers(acct.auth, { scopes })), accept: "application/json" };
      if (req.body !== undefined) headers["content-type"] = "application/json";
      let res;
      try {
        res = await f(url, { method: req.method || "GET", headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS),
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}) });
      } catch (e) {
        const why = /** @type {any} */ (e)?.name === "TimeoutError" ? "did not answer in 30 s" : "could not be reached";
        throw new GoogleError(`Google ${req.api} ${why}`, { code: "network" });
      }
      const text = await readCapped(res);
      if (res.status === 401 && attempt === 0) { creds.invalidate(acct.auth, scopes); continue; }
      if (res.status >= 300 && res.status < 400) throw new GoogleError(`Google ${req.api} answered a redirect (${res.status}), which is refused`, { status: res.status });
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch {}
      if (!res.ok) throw refusal(req, res.status, json, creds.scrub(text));
      return json ?? {};
    }
  }
  return { request };
}

/** The body, up to a cap, so a runaway answer cannot fill memory. */
async function readCapped(res) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); throw new GoogleError(`Google answered more than ${MAX_BYTES} bytes`); }
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

/** A sentence a person can act on, from Google's error body. */
function refusal(req, status, json, text) {
  const e = json && typeof json.error === "object" ? json.error : null;
  const said = String((e && e.message) || (json && typeof json.error === "string" ? json.error : "") || text.slice(0, 200) || "no reason given").slice(0, 300);
  let msg = `Google ${req.api} answered ${status}: ${said}`;
  if (status === 403 && /scope/i.test(said)) msg += `. The account's token does not carry ${req.scope}; allow it (for a service account, under domain-wide delegation in the Workspace admin console).`;
  if (status === 401) msg += ". The credential was refused twice; check the vault item.";
  return new GoogleError(msg, { status, code: status === 404 ? "not_found" : status === 403 ? "forbidden" : "google" });
}
