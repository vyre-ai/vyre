// @ts-check
// A minimal Flow runner for the `find` verb, so a Kit's own flow (not hand-written connector code)
// decides what a payment does. It exists until the platform's step runner takes over: it runs only
// what the Estate planning kit's flow uses (find, with by, set, createIfMissing and as) and refuses
// every other verb loudly. It adds no permission, log or data path: it calls the gateway it is given.

/** @typedef {{ find: (type: string, by: Record<string, any>) => Promise<any | null>, create: (type: string, fields: Record<string, any>) => Promise<any>, urn?: (type: string, id: string) => string }} FlowGateway */

/**
 * Resolve {{path}} templates. A string that is exactly one template keeps the value's type (a number
 * stays a number, an object stays an object); otherwise values are joined into text, null as "".
 * @param {any} v @param {Record<string, any>} ctx
 */
export function resolve(v, ctx) {
  if (typeof v === "string") {
    const whole = /^\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}$/i.exec(v);
    if (whole) return lookup(ctx, whole[1]);
    return v.replace(/\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s*\}\}/gi, (_, p) => { const x = lookup(ctx, p); return x === null || x === undefined ? "" : typeof x === "object" ? JSON.stringify(x) : String(x); });
  }
  if (Array.isArray(v)) return v.map((x) => resolve(x, ctx));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x, ctx)]));
  return v;
}
/** @param {Record<string, any>} ctx @param {string} p */
function lookup(ctx, p) {
  let cur = ctx;
  for (const k of p.split(".")) { if (cur === null || cur === undefined || typeof cur !== "object" || k === "__proto__" || k === "constructor") return null; cur = cur[k]; }
  return cur === undefined ? null : cur;
}
/** A record as steps see it: its fields at the top, plus id and urn. @param {any} rec @param {string} type @param {FlowGateway} gw */
const view = (rec, type, gw) => ({ ...rec.data, id: rec.id, urn: gw.urn ? gw.urn(type, rec.id) : null });

/**
 * @param {any} flow a stored flow from a kit
 * @param {Record<string, any>} event the trigger's payload, reachable as event.<name>
 * @param {FlowGateway} gateway
 * @returns {Promise<{ steps: { step: number, type: string, found: boolean, created: boolean, id: string | null }[], context: Record<string, any> }>}
 */
export async function runFlow(flow, event, gateway) {
  /** @type {Record<string, any>} */ const ctx = { event };
  const steps = [];
  for (const [i, s] of flow.steps.entries()) {
    if (!("find" in s)) throw new Error(`Flow "${flow.name}" step ${i + 1} uses a verb this runner does not run yet (${Object.keys(s).join(", ")})`);
    const type = s.find;
    const by = resolve(s.by ?? {}, ctx);
    const usable = Object.entries(by).filter(([, v]) => v !== null && v !== "");
    /** @type {any} */ let rec = usable.length ? await gateway.find(type, Object.fromEntries(usable)) : null;
    let created = false;
    if (!rec && s.createIfMissing) {
      const fields = { ...Object.fromEntries(usable), ...Object.fromEntries(Object.entries(resolve(s.set ?? {}, ctx)).filter(([, v]) => v !== null && v !== "")) };
      rec = await gateway.create(type, fields);
      created = true;
    }
    if (s.as) ctx[s.as] = rec ? view(rec, type, gateway) : null;
    steps.push({ step: i + 1, type, found: !!rec && !created, created, id: rec?.id ?? null });
  }
  return { steps, context: ctx };
}
