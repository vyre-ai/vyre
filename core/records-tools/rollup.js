// @ts-check
// Roll-ups and calculated fields: a total over the records that point at this one (how many deals a company has, the sum of their amounts), as a computed field the store keeps up to date. A weighted
// value (amount x chance) is kept on each record as `weighted_value` by the tools that change it, so a roll-up can sum it like any stored number.

const NAME = /^[a-z][a-z0-9_]{0,39}$/;
export const ROLLUP_FNS = ["count", "sum", "avg", "min", "max"];

/** The computed field a roll-up adds to its type. Throws a plain sentence. @param {{ name?: string, label?: string, over?: { type?: string, via?: string }, fn?: string, field?: string }} i @param {string} typeName */
export function rollupField(i, typeName) {
  const name = String(i.name || "");
  if (!NAME.test(name)) throw new Error("A roll-up needs a name made of lowercase letters, digits and underscores.");
  if (!ROLLUP_FNS.includes(String(i.fn))) throw new Error(`fn is one of ${ROLLUP_FNS.join(", ")}.`);
  const o = i.over || {};
  if (typeof o.type !== "string" || typeof o.via !== "string" || !NAME.test(o.type) || !NAME.test(o.via)) throw new Error("over is { type, via }: the type that points at this one and the field it points with.");
  if (i.fn !== "count" && !NAME.test(String(i.field))) throw new Error(`${i.fn} adds up a field: give field, for example amount.`);
  return { name, kind: "number", label: String(i.label || name).slice(0, 60), computed: { over: { type: o.type, via: o.via, fn: i.fn, ...(i.fn === "count" ? {} : { field: i.field }) } } };
}

/** weighted_value for a record: amount x probability / 100, kept to the cent. Null when either is missing. @param {Record<string, any>} data */
export function weightedOf(data) {
  const a = Number(data.amount), p = Number(data.probability);
  if (data.amount === undefined || data.amount === null || data.amount === "" || data.probability === undefined || data.probability === null || data.probability === "" || !Number.isFinite(a) || !Number.isFinite(p)) return null;
  return Math.round(a * p) / 100;
}

/** The patch with weighted_value brought up to date, for a type that has amount, probability and weighted_value fields. @param {any[]} fields @param {Record<string, any>} data the record now @param {Record<string, any>} patch */
export function withWeighted(fields, data, patch) {
  const has = (/** @type {string} */ n) => fields.some((f) => f.name === n);
  if (!has("amount") || !has("probability") || !has("weighted_value")) return patch;
  if (!("amount" in patch) && !("probability" in patch)) return patch;
  const w = weightedOf({ ...data, ...patch });
  return { ...patch, weighted_value: w };
}

/** @param {{ tool: Function, obj: Function, str: any, refuse: Function }} h */
export function registerRollups({ tool, obj, str, refuse }) {
  tool("records.rollup.add", "Add a total to a type over the records that point at it: { type, name, label?, over: { type, via }, fn: count|sum|avg|min|max, field? }. For example the sum of the deals' weighted_value on a company. The store keeps it up to date. Who may change a type is the kernel's to decide.",
    obj({ space: str, type: str, name: str, label: str, over: { type: "object" }, fn: str, field: str }, ["type", "name", "over", "fn"]), async (/** @type {any} */ i, /** @type {any} */ d) => {
      const t = ((await d.gateway.definitions(d.chain)) || []).find((/** @type {any} */ x) => x.name === i.type);
      if (!t) throw refuse(`There is no record type called ${i.type}. Pick one of the types shown in Records.`, "not_found");
      let f; try { f = rollupField(i, t.name); } catch (e) { throw refuse(/** @type {Error} */ (e).message, "bad_input"); }
      if ((t.fields || []).some((/** @type {any} */ x) => x.name === f.name)) throw refuse(`${t.label || t.name} already has a field called ${f.name}. Pick another name.`, "duplicate");
      await d.gateway.records.define(d.chain, { change_types: [{ ...t, fields: [...t.fields, f] }] });
      return { field: f };
    });
}
