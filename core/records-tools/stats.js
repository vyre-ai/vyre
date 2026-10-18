// @ts-check
// Totals for a board: how many records and how much money sit in each stage (or any choice field), so a column header can say "4 deals, 18,000". One call per board instead of a sum over every card.
// records.stats { type, group_by?, sum?, filter? }. The kernel totals the rows the caller may read and says so when there are too many to total here.

const NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** The aggregate spec for a stats call. `sum` defaults to the number fields a board shows (amount and weighted_value) that the type has. Throws a plain sentence. @param {any} t @param {{ group_by?: any, sum?: any, filter?: any }} i */
export function specFor(t, i) {
  const fields = t.fields || [];
  const sf = fields.find((/** @type {any} */ f) => f.kind === "stage");
  const by = i.group_by !== undefined ? String(i.group_by) : sf && sf.name;
  if (!by) throw new Error(`${t.label || t.name} has no stage field to group by. Name a choice field: { group_by }.`);
  const g = fields.find((/** @type {any} */ f) => f.name === by);
  if (!NAME.test(by) || !g || !["stage", "choice", "boolean"].includes(g.kind)) throw new Error(`${by} is not a stage, choice or yes/no field of ${t.label || t.name}.`);
  const wanted = Array.isArray(i.sum) ? i.sum.map(String) : ["amount", "weighted_value"].filter((n) => fields.some((/** @type {any} */ f) => f.name === n));
  for (const n of wanted) if (!fields.some((/** @type {any} */ f) => f.name === n && f.kind === "number")) throw new Error(`${n} is not a number field of ${t.label || t.name}.`);
  return { group_by: by, sum: wanted, spec: { ...(i.filter && typeof i.filter === "object" ? { filter: i.filter } : {}), group_by: [by], measures: [{ fn: "count" }, ...wanted.map((n) => ({ fn: "sum", field: n }))] } };
}

/** The answer in the shape a board reads: one entry per stage or option, in the field's own order, empty ones included, and a grand total. @param {any} t @param {string} by @param {string[]} sums @param {{ group: Record<string, any>, values: Record<string, any> }[]} rows */
export function shape(t, by, sums, rows) {
  const f = (t.fields || []).find((/** @type {any} */ x) => x.name === by);
  const order = f && f.kind === "boolean" ? [true, false] : (f && f.options) || [];
  const zero = () => ({ count: 0, ...Object.fromEntries(sums.map((s) => [s, 0])) });
  /** @type {Map<any, any>} */ const byKey = new Map(order.map((/** @type {any} */ k) => [k, { key: k, ...zero() }]));
  const total = zero();
  for (const r of rows) {
    const key = r.group[by] === undefined ? null : r.group[by];
    const entry = byKey.get(key) || (byKey.set(key, { key, ...zero() }), byKey.get(key));
    entry.count += Number(r.values.count || 0); total.count += Number(r.values.count || 0);
    for (const s of sums) { const v = Number(r.values[`sum:${s}`] || 0); entry[s] += v; total[s] += v; }
  }
  return { groups: [...byKey.values()], total };
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function }} h */
export function registerStats({ tool, obj, str, refuse }) {
  tool("records.stats", "Counts and sums per stage or choice for a board: { type, group_by?, sum?, filter? }, over records you may read.",
    obj({ space: str, type: str, group_by: str, sum: { type: "array", items: { type: "string" } }, filter: { type: "object" } }, ["type"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === i.type);
      if (!t) throw refuse(`There is no record type called ${i.type}. Pick one of the types shown in Records.`, "not_found");
      let s; try { s = specFor(t, i); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      const rows = await d.gateway.records.aggregate(d.chain, t.name, s.spec);
      return { type: t.name, group_by: s.group_by, ...shape(t, s.group_by, s.sum, rows) };
    });
}
