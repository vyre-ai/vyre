// @ts-check
// api-learn: the pure reduction behind `api.learn` in the design (ADR 0049): captured XHR/fetch
// traffic in, a catalog out (method, path template, query names, body shape, auth kind, sample
// status), with every value dropped. Header and cookie NAMES survive; values never do. The bench
// uses this to measure the learning path on the GoHighLevel-shaped fixture; the real extension
// has its own implementation and the two should agree on the catalog shape.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path segment that is an identifier, not a route word. @param {string} seg */
export function isIdSegment(seg) {
  return /^\d+$/.test(seg) || UUID.test(seg) || /^[0-9a-f]{16,}$/i.test(seg) || /^[a-z]{1,4}_[0-9a-z]{6,}$/i.test(seg);
}

/** @param {string} pathname */
export function pathTemplate(pathname) {
  return pathname.split("/").map(s => (s && isIdSegment(s) ? ":id" : s)).join("/") || "/";
}

/** @param {unknown} v */
function shapeOf(v) {
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shapeOf(x)]));
  return v === null ? "null" : typeof v;
}

/** @param {Record<string,string>|undefined} headers @param {string|undefined} cookie */
export function authKind(headers = {}, cookie) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const bearer = /^bearer\s/i.test(lower.authorization || "");
  const other = !bearer && Boolean(lower.authorization || lower["x-api-key"] || lower["x-auth-token"]);
  const ck = Boolean(cookie || lower.cookie);
  const kind = bearer && ck ? "bearer+cookie" : bearer ? "bearer" : other ? "header" : ck ? "cookie" : "none";
  const names = Object.keys(lower).filter(k => k === "authorization" || k === "x-api-key" || k === "x-auth-token");
  if (ck) names.push("cookie");
  return { kind, headers: names };
}

/**
 * @typedef {{method:string, url:string, requestHeaders?:Record<string,string>, cookie?:string, postData?:string, status?:number, resourceType?:string}} Captured
 * @param {Captured[]} requests
 * @param {{origin?:string}} [opt] when set, only same-origin requests are learned
 */
export function learn(requests, opt = {}) {
  /** @type {Map<string, any>} */
  const byKey = new Map();
  for (const r of requests) {
    if (r.resourceType && !["XHR", "Fetch", "xhr", "fetch"].includes(r.resourceType)) continue;
    let u;
    try { u = new URL(r.url); } catch { continue; }
    if (opt.origin && u.origin !== opt.origin) continue;
    const template = pathTemplate(u.pathname);
    const key = `${r.method.toUpperCase()} ${template}`;
    let e = byKey.get(key);
    if (!e) {
      e = { key, method: r.method.toUpperCase(), path: template, query: new Set(), body: null, auth: authKind(r.requestHeaders, r.cookie), status: r.status ?? null, count: 0 };
      byKey.set(key, e);
    }
    e.count++;
    for (const k of u.searchParams.keys()) e.query.add(k);
    if (r.postData) { try { e.body = shapeOf(JSON.parse(r.postData)); } catch { e.body = "non-json"; } }
    const a = authKind(r.requestHeaders, r.cookie);
    if (a.kind.length > e.auth.kind.length) e.auth = a;
    if (e.status == null && r.status != null) e.status = r.status;
  }
  const entries = [...byKey.values()].map(e => ({ ...e, query: [...e.query].sort() })).sort((a, b) => a.key.localeCompare(b.key));
  return { entries };
}

/** Fill a path template's :id segments in order. @param {string} template @param {string[]} [ids] */
export function fillTemplate(template, ids = []) {
  let i = 0;
  return template.replace(/:id/g, () => encodeURIComponent(ids[i++] ?? "0"));
}
