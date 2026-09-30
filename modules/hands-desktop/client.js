// @ts-check
// client: the HTTP client for computerd, the helper inside each agent's computer.
//
// computerd speaks the table in docs/work/computers.md: GET /health, /apps, /tree?app=,
// /screenshot, and POST /act, /input, every one with `Authorization: Bearer <token>`. This file
// adds timeouts and errors a person can read.
//
// The token is held here, in memory, and nowhere else. It never appears in an error message, an
// event or a log: every message this file builds is scrubbed for it, including whatever the other
// end or the network stack said, because a helper that echoes its request would otherwise leak it
// into a tool result.

const DEFAULT_TIMEOUT = 10_000;

export class ComputerdError extends Error {
  /** @param {string} message @param {{ status?: number, route?: string }} [o] */
  constructor(message, o = {}) {
    super(message);
    this.name = "ComputerdError";
    this.status = o.status;
    this.route = o.route;
  }
}

/**
 * @param {{ url: string, token: string, timeout?: number, fetch?: typeof fetch }} o
 */
export function createClient({ url, token, timeout = DEFAULT_TIMEOUT, fetch: f = fetch }) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new ComputerdError("computerd has no address: the computer's endpoint did not say where its helper answers");
  const secret = String(token || "");
  /** @param {string} s */
  const scrub = s => (secret ? String(s).split(secret).join("[token]") : String(s));
  const where = scrub(base);

  /**
   * @param {"GET"|"POST"} method
   * @param {string} route
   * @param {any} [body]
   * @param {{ binary?: boolean, timeout?: number }} [o]
   */
  async function request(method, route, body, o = {}) {
    const ms = o.timeout ?? timeout;
    const name = `${method} ${route.split("?")[0]}`;
    /** @type {Response} */
    let res;
    try {
      res = await f(base + route, {
        method,
        headers: { authorization: `Bearer ${secret}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ms),
      });
    } catch (e) {
      const err = /** @type {any} */ (e);
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new ComputerdError(`computerd at ${where} did not answer ${name} within ${ms} ms`, { route });
      }
      const code = (err && err.cause && err.cause.code) || (err && err.code) || (err && err.message) || "unknown error";
      throw new ComputerdError(scrub(`computerd at ${where} is not reachable for ${name} (${code})`), { route });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new ComputerdError(`computerd at ${where} refused ${name}: the helper token was not accepted (HTTP ${res.status}). The computer may have been recreated; ask computers.endpoint again.`, { status: res.status, route });
    }
    if (!res.ok) {
      let detail = "";
      try {
        const text = await res.text();
        try { const j = JSON.parse(text); detail = j.error && (j.error.message || j.error) || j.message || text; }
        catch { detail = text; }
      } catch {}
      detail = String(detail || "").replace(/\s+/g, " ").trim().slice(0, 200);
      throw new ComputerdError(scrub(`computerd ${name} failed (HTTP ${res.status})${detail ? ": " + detail : ""}`), { status: res.status, route });
    }
    if (o.binary) return Buffer.from(await res.arrayBuffer());
    const text = await res.text();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { throw new ComputerdError(`computerd ${name} answered with something that is not JSON`, { status: res.status, route }); }
  }

  return {
    /** @returns {Promise<{ ok: boolean, display?: string, size?: { w: number, h: number }, chrome?: any }>} */
    health: () => request("GET", "/health"),
    /** @returns {Promise<Array<{ name: string, pid: number, windows: string[] }>>} */
    apps: () => request("GET", "/apps"),
    /** @param {string} [app] @returns {Promise<{ window: string, nodes: any[] }>} */
    tree: app => request("GET", "/tree" + (app ? "?app=" + encodeURIComponent(app) : "")),
    /** @param {{ path: string, action: "press"|"focus"|"set-text", value?: string }} body */
    act: body => request("POST", "/act", body),
    /** @param {{ kind: "click", x: number, y: number, button?: string } | { kind: "key", keys: string } | { kind: "type", text: string }} body */
    input: body => request("POST", "/input", body),
    /** @param {{ format?: "png"|"jpeg", width?: number }} [o] @returns {Promise<Buffer>} */
    screenshot: (o = {}) => request("GET", "/screenshot" + (o.format === "jpeg" ? `?format=jpeg${Number.isInteger(o.width) ? `&width=${o.width}` : ""}` : ""),
      undefined, { binary: true, timeout: Math.max(timeout, 20_000) }),
  };
}
