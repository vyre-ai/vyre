// @ts-check
// A Kit type that has a core type's name adds its fields to the core type. It cannot remove a core field (the core fields stay, in their place) and it
// cannot retype one: a field the kit repeats must keep its kind, its targets and its seal. So the Estate kit's `contact` extends the core Contact and
// its `ssn` stays sealed (team/0.3/DESIGN-contacts-comms.md, "any field, on anything").

import { canonical } from "../../kernel/core/canonical.js";

const fail = (/** @type {string} */ message) => Object.assign(new Error(message), { code: "invalid" });
const targets = (/** @type {any} */ f) => (f.to === undefined ? null : [].concat(f.to).sort());

/**
 * @param {any} base the type as the Space holds it (a core type, or a core type already extended by another kit)
 * @param {any} kit the Kit's type with the same name
 * @returns {any} the extended definition
 */
export function extendType(base, kit) {
  if (base.name !== kit.name) throw fail(`${kit.name} cannot extend ${base.name}`);
  const where = (/** @type {string} */ n) => `${base.name}.${n}`;
  const byName = new Map(base.fields.map((/** @type {any} */ f) => [f.name, f]));
  /** @type {any[]} */ const fields = base.fields.map((/** @type {any} */ f) => ({ ...f }));
  for (const kf of kit.fields) {
    const bf = byName.get(kf.name);
    if (!bf) { fields.push({ ...kf }); continue; }
    if (bf.kind !== kf.kind) throw fail(`${where(kf.name)} is a core field of kind ${bf.kind}; a kit cannot change it to ${kf.kind}`);
    if (kf.to !== undefined && canonical(targets(bf)) !== canonical(targets(kf))) throw fail(`${where(kf.name)} points at ${(targets(bf) ?? []).join(" or ") || "any record"}; a kit cannot change that`);
    if (bf.kind === "sealed" && kf.seal && canonical(bf.seal) !== canonical(kf.seal)) throw fail(`${where(kf.name)} is sealed as ${bf.seal?.class}; a kit cannot reseal it`);
    // a choice may grow: the core options keep their order and the kit's new ones follow
    if (Array.isArray(bf.options) && Array.isArray(kf.options)) { const i = fields.findIndex((f) => f.name === kf.name); fields[i] = { ...bf, options: [...bf.options, ...kf.options.filter((/** @type {string} */ o) => !bf.options.includes(o))] }; }
  }
  const out = { ...base, fields };
  if (kit.stages?.length) {
    if (base.stages?.length && canonical(base.stages) !== canonical(kit.stages)) throw fail(`${base.name} already has stages; a kit cannot replace them`);
    out.stages = kit.stages;
  }
  const rules = [...(base.rules ?? [])];
  for (const r of kit.rules ?? []) if (!rules.some((x) => canonical(x) === canonical(r))) rules.push(r);
  if (rules.length) out.rules = rules;
  if (kit.role) {
    if (base.role && canonical(base.role) !== canonical(kit.role)) throw fail(`${base.name} is already marked as a role differently`);
    out.role = kit.role;
  }
  return out;
}

/**
 * Split a Kit's types into the ones that extend a type the Space already holds under the same name (`names`) and the ones that are new.
 * @param {readonly any[]} kitTypes @param {ReadonlyMap<string, any>} held the core types, by name @returns {{ add: any[], change: any[] }}
 */
export function mergeKitTypes(kitTypes, held) {
  /** @type {any[]} */ const add = [], change = [];
  for (const t of kitTypes) { const base = held.get(t.name); if (base) change.push(extendType(base, t)); else add.push(t); }
  return { add, change };
}
