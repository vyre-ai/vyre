// What a verified webhook delivery hands to a Flow that answers its route: the body as plain data, capped. The Flow starts as an outside call (trust "untrusted"), so the run is tainted like a form's: it cannot
// drive a grant or an admin act, and the body reaches an agent or a model only where the Flow's author maps a field into a step. Nothing here reads a credential or the headers.

/** The Flow path a route answers on: a web trigger path is lowercase letters, digits and hyphens, so /hooks/northwind-orders is the Flow path hook-northwind-orders. @param {string} route */
export const flowPath = route => `hook-${route}`;

const MAX_TEXT = 20_000;
const MAX_KEYS = 200;

/** A JSON object body as it is (at most MAX_KEYS top-level keys, long strings cut); a list or a bare value as { value }; anything that is not JSON as { text } (cut). @param {string} text @returns {Record<string, any>} */
export function flowBody(text) {
  const s = String(text ?? "");
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
 * @param {(line: string) => void} log @param {Set<string>} [told] routes already warned about
 */
export async function startFlows(host, name, route, id, text, log, told = new Set()) {
  if (!host) return;
  const space = route && typeof route.space === "string" && route.space ? route.space : "";
  if (!space) {
    if (!told.has(name)) { told.add(name); log(`internet:${name}: no Space is recorded for this route (it was opened before routes had one), so it starts no Flow; close it and open it again`); }
    return;
  }
  const h = host.get(space);
  if (!h) return;
  try { await h.flows.handleWeb(flowPath(name), { body: flowBody(text), trust: "untrusted", key: id }); }
  catch (e) { if (/** @type {any} */ (e).code !== "not_found") log(`internet:${name}: a Flow could not start on ${id} (${String(/** @type {Error} */ (e).message).slice(0, 160)})`); }
}
