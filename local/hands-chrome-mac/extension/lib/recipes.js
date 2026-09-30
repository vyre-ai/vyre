// @ts-check
// recipes: a flow that worked, kept as data and replayed as ONE batch (team/0.2/chrome-learning-plan.md, 10.3).
//
// A recipe is the steps of a successful batch with every literal a person supplied replaced by a {parameter}: nothing typed is stored, only the
// shape of the work. Replaying it is a normal batch.run on the named tab, so the URL floor, the stop switch, the send-hold and the plan approval
// apply exactly as to a live call. The model picks the recipe and fills its parameters; no model turn happens between steps.

/** Slug for a parameter name. @param {string} s */
const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "value";
const PARAM = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * Turn a successful batch into a recipe.
 * @param {string} name @param {any[]} steps the batch's steps as sent @param {any[]} results what each returned
 * @returns {{ name: string, params: { name: string, type: string }[], steps: any[], expects: any[] }}
 */
export function toRecipe(name, steps, results = []) {
  /** @type {Map<string, { name: string, type: string }>} */ const params = new Map();
  const claim = (/** @type {string} */ want) => { let n = slug(want), i = 2; while (params.has(n)) n = `${slug(want)}_${i++}`; params.set(n, { name: n, type: "string" }); return `{${n}}`; };
  const out = steps.map((s, i) => {
    const args = JSON.parse(JSON.stringify(s.args || {}));
    delete args.tabId; delete args.tab; delete args.asked; delete args.release; delete args.writeOk;
    if (s.op === "page.fill" && Array.isArray(args.fields)) args.fields = args.fields.map((/** @type {any} */ f) => ({ ...f, value: claim(f.label || (f.selector && (f.selector.identifier || f.selector.name)) || "field") }));
    if (s.op === "page.act" && (args.kind === "type" || args.kind === "select") && args.value !== undefined) args.value = claim((args.selector && (args.selector.identifier || args.selector.name)) || "value");
    if (s.op === "api.call" && args.args && typeof args.args === "object") {
      const walk = (/** @type {any} */ v, /** @type {string} */ k) => (v && typeof v === "object" ? (Array.isArray(v) ? v.map(x => walk(x, k)) : Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]))) : typeof v === "string" && !/^\{[a-z][a-z0-9_]*\}$/.test(v) ? claim(k) : v);
      args.args = walk(args.args, "value");
    }
    const r = results[i];
    const method = r && typeof r === "object" && typeof r.method === "string" ? r.method.toUpperCase() : "";
    const write = s.op === "api.call" && method && !/^(GET|HEAD|OPTIONS)$/.test(method) ? ({ POST: "create", PUT: "edit", PATCH: "edit", DELETE: "delete" }[/** @type {"POST"} */ (method)] || "edit") : undefined;
    return { id: `s${i + 1}`, ...(s.label ? { label: String(s.label).slice(0, 80) } : {}), op: s.op, args, ...(write ? { write } : {}) };
  });
  return { name, params: [...params.values()], steps: out, expects: [] };
}

/** Steps ready for batch.run: every {parameter} replaced; a missing one is an error naming it. @param {{ steps: any[], params?: any[] }} recipe @param {Record<string, any>} values */
export function fill(recipe, values) {
  const want = new Set((recipe.params || []).map(p => p.name));
  const missing = [...want].filter(n => values[n] === undefined);
  if (missing.length) throw Object.assign(new Error(`the recipe needs: ${missing.join(", ")}`), { code: "bad_request" });
  const sub = (/** @type {any} */ v) => {
    if (typeof v === "string") { const whole = /^\{([a-z][a-z0-9_]*)\}$/.exec(v); if (whole) return values[whole[1]]; return v.replace(PARAM, (m, n) => (values[n] !== undefined ? String(values[n]) : m)); }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)]));
    return v;
  };
  return recipe.steps.map(s => ({ op: s.op, ...(s.label ? { label: s.label } : {}), args: sub(s.args) }));
}
