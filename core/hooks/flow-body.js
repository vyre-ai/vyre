// What a verified webhook delivery hands to a Flow: the body as plain data (JSON, or a form post's fields), capped. A Flow's own address starts that Flow by its id; a route opened by hand starts the Flow at hook-<route>. The Flow starts as an outside call (trust "untrusted"), so the run is tainted like a form's: it cannot
// drive a grant or an admin act, and the body reaches an agent or a model only where the Flow's author maps a field into a step. Nothing here reads a credential or the headers.

/** The Flow path a route answers on: a web trigger path is lowercase letters, digits and hyphens, so /hooks/northwind-orders is the Flow path hook-northwind-orders. @param {string} route */
export const flowPath = route => `hook-${route}`;

const MAX_TEXT = 20_000;
const MAX_KEYS = 200;

/**
 * A JSON object body as it is (at most MAX_KEYS top-level keys, long strings cut); a list or a bare value as { value }; anything that is not JSON as { text } (cut). A form post
 * (application/x-www-form-urlencoded) becomes its fields, a field sent more than once a list, with the same caps.
 * @param {string} text @param {string} [type] the content type it arrived with @returns {Record<string, any>}
 */
export function flowBody(text, type = "") {
  const s = String(text ?? "");
  if (String(type).split(";")[0].trim().toLowerCase() === "application/x-www-form-urlencoded") {
    /** @type {Map<string, any>} */ const out = new Map();
    for (const [k, v] of new URLSearchParams(s)) {
      const key = k.slice(0, 200), val = v.slice(0, MAX_TEXT);
      if (out.has(key)) { const was = out.get(key); if (Array.isArray(was)) { if (was.length < MAX_KEYS) was.push(val); } else out.set(key, [was, val]); }
      else if (out.size < MAX_KEYS) out.set(key, val);
    }
    return Object.fromEntries(out);
  }
  let v;
  try { v = JSON.parse(s); } catch { return { text: s.slice(0, MAX_TEXT) }; }
  const cut = x => (typeof x === "string" ? x.slice(0, MAX_TEXT) : Array.isArray(x) ? x.slice(0, MAX_KEYS).map(cut) : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).slice(0, MAX_KEYS).map(([k, y]) => [k, cut(y)])) : x);
  if (v && typeof v === "object" && !Array.isArray(v)) return cut(v);
  return { value: cut(v) };
}

/**
 * Hand a verified delivery to the Flow that answers its route, in the route's own Space and no other: a route is opened by a person for one Space, so a Flow another Space's member defines at the same web
 * path never sees its deliveries. A route with no recorded Space (opened before routes had one) starts nothing and says so once. A not_found (no Flow answers) is the normal case and silent.
 * @param {{ get: (space: string) => any, spaces: () => string[] } | undefined} host the Flows assembly @param {string} name the route @param {{ space?: string | null } | null} route @param {string} id the delivery @param {string} text the body
 * @param {(line: string) => void} log @param {Set<string>} [told] routes already warned about @param {string} [type] the delivery's content type
 */
export async function startFlows(host, name, route, id, text, log, told = new Set(), type = "") {
  if (!host) return;
  // A Flow's own address is bound to that Flow by its id: only it starts, whatever path its trigger names.
  if (route && typeof route.flow === "string" && route.flow) {
    const h = typeof route.space === "string" && route.space ? host.get(route.space) : null;
    if (!h) return;
    try { await h.flows.handleWeb("", { flow: route.flow, body: flowBody(text, type), trust: "untrusted", key: id }); }
    catch (e) { log(`internet:${name}: the Flow could not start on ${id} (${String(/** @type {Error} */ (e).message).slice(0, 160)})`); }
    return;
  }
  const space = route && typeof route.space === "string" && route.space ? route.space : "";
  if (!space) {
    if (!told.has(name)) { told.add(name); log(`internet:${name}: no Space is recorded for this route (it was opened before routes had one), so it starts no Flow; close it and open it again`); }
    return;
  }
  const h = host.get(space);
  if (!h) return;
  try { await h.flows.handleWeb(flowPath(name), { body: flowBody(text, type), trust: "untrusted", key: id }); }
  catch (e) { if (/** @type {any} */ (e).code !== "not_found") log(`internet:${name}: a Flow could not start on ${id} (${String(/** @type {Error} */ (e).message).slice(0, 160)})`); }
}
