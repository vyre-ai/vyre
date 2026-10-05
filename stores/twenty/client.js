// @ts-check
// A small GraphQL client for one Twenty workspace. One key, held only here. Retries the rate
// limit with a short backoff; maps Twenty's errors onto the store's typed errors.

/** An error from talking to Twenty. The store turns these into the kernel's store errors. */
export class StoreError extends Error {
  /** @param {"not_found" | "invalid" | "id_exists" | "unique_violation" | "unavailable" | "rate_limited"} code @param {string} message @param {Record<string, any>} [detail] */
  constructor(code, message, detail = {}) { super(message); this.name = "StoreError"; this.code = code; this.detail = detail; }
}

/**
 * @typedef {{ url: string, key: () => string, fetch?: typeof fetch, retries?: number, hostHeader?: string,
 *   sleep?: (ms: number) => Promise<void> }} ClientOptions
 */
export class TwentyClient {
  /** @param {ClientOptions} o */
  constructor(o) {
    this.url = o.url.replace(/\/+$/, "");
    this.key = o.key;
    this.fetch = o.fetch ?? fetch;
    this.retries = o.retries ?? 4;
    this.hostHeader = o.hostHeader;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * @param {"graphql" | "metadata"} path
   * @param {string} query a document with a named operation
   * @param {Record<string, any>} [variables]
   * @returns {Promise<any>} data
   */
  async gql(path, query, variables) {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await this.fetch(`${this.url}/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${this.key()}`, ...(this.hostHeader ? { host: this.hostHeader } : {}) }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        if (attempt < 2) { await this.sleep(200 * (attempt + 1)); continue; }
        throw new StoreError("unavailable", `Records did not answer: ${/** @type {Error} */ (e).message}`);
      }
      if (res.status === 429) { if (attempt >= this.retries) throw new StoreError("rate_limited", "Records' rate limit is too low for this load"); await this.sleep(250 * 2 ** attempt); continue; }
      if (res.status === 401 || res.status === 403) throw new StoreError("unavailable", "Records refused the service key");
      /** @type {any} */ let body;
      try { body = await res.json(); } catch { throw new StoreError("unavailable", `Records answered ${res.status} with something that is not JSON`); }
      if (body.errors?.length) throw mapError(body.errors[0], body.data);
      if (res.status >= 500) throw new StoreError("unavailable", `Records answered ${res.status}`);
      return body.data;
    }
  }
}

/** @param {any} e @param {any} data */
function mapError(e, data) {
  const msg = String(e.message ?? "error");
  const sub = e.extensions?.subCode ?? e.extensions?.code ?? "";
  if (sub === "RECORD_NOT_FOUND" || /^Record not found/i.test(msg)) return new StoreError("not_found", "No such record", { twenty: msg });
  // a clash on the id (the primary key) is `id_exists`; a clash on a unique field the Space asked for is `unique_violation`
  if (/pkey|primary key/i.test(msg)) return new StoreError("id_exists", "A record with that id already exists", { twenty: msg });
  if (/duplicate|unique|already exists|violates/i.test(msg) || sub === "RECORD_ALREADY_EXISTS") return new StoreError("unique_violation", "Another record already has that unique value", { twenty: msg });
  if (/not a valid UUID|Invalid UUID/i.test(msg)) return new StoreError("invalid", "The id is not a valid id", { twenty: msg });
  if (e.extensions?.code === "BAD_USER_INPUT" || /cannot query field|unknown argument|Variable/i.test(msg)) return new StoreError("invalid", `Records rejected the request: ${msg.slice(0, 200)}`, { twenty: msg });
  const ext = e.extensions ? JSON.stringify(e.extensions).slice(0, 700) : "";
  return new StoreError("unavailable", `Records error: ${msg.slice(0, 300)} ${ext}`.trim(), { twenty: msg, extensions: e.extensions });
}

/** Plain GET for /healthz and /client-config. @param {TwentyClient} c @param {string} p */
export async function twentyGet(c, p) {
  try {
    const res = await c.fetch(`${c.url}${p}`, { headers: { ...(c.hostHeader ? { host: c.hostHeader } : {}) }, signal: AbortSignal.timeout(10_000) });
    return { status: res.status, body: await res.text() };
  } catch (e) { return { status: 0, body: String(/** @type {Error} */ (e).message) }; }
}
