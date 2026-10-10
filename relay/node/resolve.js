// @ts-check
// The edge relay's one question to the names directory: which route serves this public host (GET /v1/tunnel/resolve, the relay's shared secret in a header). Fail closed: any answer that is not a
// route for exactly this host, any error and any timeout is "nobody serves it", and the visitor is closed before a box is told. The directory wraps every answer as { data: ... } (names/worker).
// The address is the operator's own (VYRE_TUNNEL_DIRECTORY), never a visitor's, so this is a plain request with a short deadline.

/**
 * @param {{ base: string, secret: string, fetch?: typeof globalThis.fetch, timeoutMs?: number }} o
 * @returns {(host: string) => Promise<{ route: string } | null>}
 */
export function directoryResolve({ base, secret, fetch = globalThis.fetch, timeoutMs = 3000 }) {
  const root = String(base).replace(/\/$/, "");
  return async host => {
    try {
      const r = await fetch(`${root}/v1/tunnel/resolve?host=${encodeURIComponent(host)}`, { headers: { "x-vyre-relay": secret }, signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return null;
      const j = /** @type {any} */ (await r.json());
      const route = j && j.data && j.data.route;
      return typeof route === "string" ? { route } : null;
    } catch { return null; }
  };
}
