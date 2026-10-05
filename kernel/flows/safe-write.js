// @ts-check
// kernel/flows/safe-write.js: the pure parts of safe outside writes in the Flow runner's "Call a service" step. A connector's declaration (what the Connectors work defines; this file only
// READS it) says per operation which is a read, which is outward, whether the provider takes an idempotency key and where, and how to read a write back; and per connector how fast it may
// be called. Nothing here calls anything: the runner does, and keeps the ledger.
//
//   connector.ops          [{ name, method, path, read, outward, idempotent?: false, readback?: { method, path: "/v1/customers/{id}", vars: { id: "response.json.id" }, compare: { email: "request.body.email" } } }]
//   connector.idempotency  { header }: the provider dedupes by key; the VAULT adds the header from the run's key, so the runner only keeps passing `idem`
//   connector.rate         { per_minute, retry_after }: the vault throttles per credential and waits out Retry-After; past its retries it answers `rate_limited` with `retryAfter` seconds
//   path: `*` or `{x}` is one segment, a trailing `/*` the rest. vars and compare read `response.json.<path>` and `request.body|params|query.<name>`.

/** @param {string} pattern @param {string} pathname */
function pathMatch(pattern, pathname) {
  const rest = pattern.endsWith("/*");
  const pat = (rest ? pattern.slice(0, -2) : pattern).split("/"), got = pathname.split("/");
  if (rest ? got.length < pat.length : got.length !== pat.length) return false;
  return pat.every((seg, i) => seg === "*" || /^\{[A-Za-z0-9_]+\}$/.test(seg) || seg === got[i]);
}

/** The connector's declared operation for a request, or null (an undeclared one keeps the old behaviour: the route rules decide, the vault dedupes). @param {any} conn @param {string} method @param {string} path */
export function opFor(conn, method, path) {
  const ops = conn && conn.ops;
  const list = Array.isArray(ops) ? ops : ops && typeof ops === "object" ? Object.entries(ops).map(([name, o]) => ({ name, .../** @type {any} */ (o) })) : [];
  return list.find(o => o && typeof o.path === "string" && String(o.method || "GET").toUpperCase() === method && pathMatch(o.path, path)) || null;
}

/** True when the connector says anything about how to call it safely. @param {any} conn */
export const isDeclared = conn => Boolean(conn && (conn.ops || conn.idempotency || conn.rate));

/** Does the provider dedupe this operation's write by key (the connector declares it, the operation does not opt out)? @param {any} conn @param {any} op */
export const takesKey = (conn, op) => Boolean(conn && conn.idempotency && op && op.idempotent !== false);

/** @param {string} pattern @param {string} pathname @returns {Record<string, string>} */
function paramsOf(pattern, pathname) {
  /** @type {Record<string, string>} */ const out = {};
  const pat = pattern.split("/"), got = pathname.split("/");
  pat.forEach((seg, i) => { const m = /^\{([A-Za-z0-9_]+)\}$/.exec(seg); if (m && got[i] !== undefined) out[m[1]] = got[i]; });
  return out;
}

/** @param {any} v @param {string} path */
export function getPath(v, path) {
  let cur = v;
  for (const k of String(path).split(".")) { if (cur === null || typeof cur !== "object") return undefined; cur = cur[k]; }
  return cur;
}

/**
 * The read that pairs with a write: its method and path with `{name}` filled from `vars`, or null when a variable is missing from what the write answered.
 * @param {any} op @param {{ path: string, query?: any, body?: any }} request @param {any} responseJson
 * @returns {{ method: string, path: string } | null}
 */
export function readbackRequest(op, request, responseJson) {
  const rb = op && op.readback;
  if (!rb || typeof rb.path !== "string") return null;
  const world = { response: { json: responseJson }, request: { body: request.body, query: request.query, params: paramsOf(String(op.path), request.path || "") } };
  let missing = false;
  const path = rb.path.replace(/\{([A-Za-z0-9_]+)\}/g, (/** @type {string} */ _m, /** @type {string} */ name) => {
    const v = rb.vars && rb.vars[name] !== undefined ? getPath(world, String(rb.vars[name])) : undefined;
    if (typeof v !== "string" && typeof v !== "number") { missing = true; return ""; }
    return encodeURIComponent(String(v));
  });
  return missing ? null : { method: String(rb.method || "GET").toUpperCase(), path };
}

/** Compare what the read returned with what the write sent. A field the write did not send is not compared. @param {any} op @param {{ path: string, query?: any, body?: any }} request @param {any} readJson @param {any} responseJson */
export function compareReadback(op, request, readJson, responseJson) {
  const world = { response: { json: responseJson }, request: { body: request.body, query: request.query, params: paramsOf(String(op.path), request.path || "") } };
  /** @type {{ field: string, wrote: any, read: any }[]} */ const mismatches = [];
  for (const [field, from] of Object.entries((op.readback && op.readback.compare) || {})) {
    const wrote = getPath(world, String(from));
    if (wrote === undefined) continue;
    const read = getPath(readJson, field);
    if (JSON.stringify(wrote) !== JSON.stringify(read) && String(wrote) !== String(read)) mismatches.push({ field, wrote, read });
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Milliseconds a provider's Retry-After asks for (seconds or an HTTP date), or null. @param {Record<string, string> | undefined} headers @param {number} now */
export function retryAfterMs(headers, now) {
  const raw = headers && (headers["retry-after"] ?? headers["Retry-After"]);
  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.round(n * 1000), 3_600_000);
  const t = Date.parse(String(raw));
  return Number.isFinite(t) ? Math.min(Math.max(0, t - now), 3_600_000) : null;
}
