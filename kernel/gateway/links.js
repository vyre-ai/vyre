// @ts-check
// kernel/gateway/links.js: links between records and their named inverses (plan item 9). A `link` field with a target type (`to`) is one end of a relation: the other end is its inverse,
// a named, read-only field on the target type ("Leads" on a Contact, shown on every Contact). `many: true` makes the link a list of records (many-to-many; the inverse is a list too).
// The gateway owns the rules and the ids (the target must be a live record of that type); a store only holds the links the best way it can (Twenty as real RELATION fields, the built-in
// store as JSON). A link with no `to` points at any record and has no inverse. Pure: no store, no clock.
import { KernelError } from "../core/errors.js";

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const bad = (/** @type {string} */ m) => new KernelError("bad_input", m);

/** "Contact" -> "contacts", "Lead" -> "leads", "Matter" -> "matters", "Company" -> "companies", "Address" -> "addresses". @param {string} w */
export function plural(w) { return /(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`; }
/** A label as a field name: "Lead contacts (Referrer)" -> "lead_contacts_referrer". @param {string} s */
export const snake = s => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 41);
const title = (/** @type {string} */ s) => String(s).trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").replace(/^./, c => c.toUpperCase());

/** @typedef {{ name: string, label: string }} Inverse */
/** @typedef {{ name: string, label: string, from_type: string, from_field: string, many: boolean }} InverseView */

/**
 * The inverse a link would get by default: the plural of the source type's label ("Leads"), or, when that is taken on the target, the label with the field's own ("Leads (Referrer)").
 * @param {any} source the type the link is on @param {any} field @param {(name: string, label: string) => boolean} taken whether a name or label is used on the target already
 * @returns {Inverse | null}
 */
export function deriveInverse(source, field, taken) {
  const base = title(plural(String(source.label || source.name)));
  const tries = [base, `${base} (${field.label || title(field.name)})`, `${base} (${title(field.name)})`];
  for (const label of tries) { const name = snake(label); if (NAME.test(name) && !taken(name, label)) return { name, label }; }
  return null;
}

/** The names a type's own fields and inverses use, compared in the lower snake form Twenty and the store both end up with. @param {any} t @param {InverseView[]} inv */
const usedOn = (t, inv) => {
  const names = new Set(), labels = new Set();
  for (const f of t.fields || []) { names.add(snake(f.name)); if (f.label) labels.add(snake(f.label)); }
  for (const i of inv) { names.add(snake(i.name)); labels.add(snake(i.label)); }
  return { names, labels };
};

/**
 * Every inverse of every link in `defs`, by target type. A link that carries an `inverse` uses it; one that does not (a definition from before links had inverses) gets the default,
 * worked out in a fixed order (type name, then field order) so the answer is the same every time. @param {any[]} defs
 * @returns {Map<string, InverseView[]>}
 */
export function inversesOf(defs) {
  /** @type {Map<string, InverseView[]>} */ const out = new Map();
  const byName = new Map(defs.map(t => [t.name, t]));
  const ordered = [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // explicit inverses first, so a default never takes a name somebody asked for
  for (const t of ordered) for (const f of t.fields || []) {
    if (f.kind !== "link" || !f.to || !byName.has(f.to) || !f.inverse) continue;
    const list = out.get(f.to) || []; out.set(f.to, list);
    list.push({ name: f.inverse.name, label: f.inverse.label, from_type: t.name, from_field: f.name, many: f.many === true });
  }
  for (const t of ordered) for (const f of t.fields || []) {
    if (f.kind !== "link" || !f.to || !byName.has(f.to) || f.inverse) continue;
    const target = byName.get(f.to);
    const list = out.get(f.to) || []; out.set(f.to, list);
    const { names, labels } = usedOn(target, list);
    const inv = deriveInverse(t, f, (n, l) => names.has(snake(n)) || labels.has(snake(l)));
    if (inv) list.push({ ...inv, from_type: t.name, from_field: f.name, many: f.many === true });
  }
  return out;
}

/**
 * Check the links of a definition diff and give each one its inverse, stored on the field so it never changes under data. `known` is every definition the Space holds now; the diff's own
 * types count too (a type may link to one defined in the same diff). Returns the diff with `inverse` filled in. @param {any} diff @param {any[]} known
 */
export function withInverses(diff, known) {
  const removed = new Set(diff.remove_types || []);
  const changed = new Map([...(diff.add_types || []), ...(diff.change_types || [])].map((/** @type {any} */ t) => [t.name, t]));
  /** every definition as it will stand after the diff */
  const after = [...known.filter(t => !removed.has(t.name) && !changed.has(t.name)), ...changed.values()];
  const byName = new Map(after.map(t => [t.name, t]));
  /** @type {Map<string, any>} */ const fixed = new Map();
  for (const t of changed.values()) {
    let touched = false;
    const fields = (t.fields || []).map((/** @type {any} */ f) => {
      if (f.kind !== "link") { if (f.many !== undefined || f.inverse !== undefined) throw bad(`${t.name}.${f.name}: only a link has many or an inverse`); return f; }
      if (f.many !== undefined && typeof f.many !== "boolean") throw bad(`${t.name}.${f.name}: many is true or false`);
      if (!f.to) { if (f.inverse !== undefined) throw bad(`${t.name}.${f.name}: a link to any record has no inverse; name the type it links to`); return f; }
      if (!byName.has(f.to)) throw bad(`${t.name}.${f.name} links to ${f.to}, which is not a type here`);
      if (f.inverse !== undefined) {
        const i = f.inverse;
        if (!i || typeof i !== "object" || typeof i.name !== "string" || !NAME.test(i.name) || typeof i.label !== "string" || !i.label.trim() || i.label.length > 60) throw bad(`${t.name}.${f.name}: the inverse is { name, label } (a lowercase name and a label)`);
        return f;
      }
      touched = true;
      return { ...f, inverse: null };
    });
    fixed.set(t.name, touched ? { ...t, fields } : t);
  }
  // give the new links their defaults, one at a time, each seeing the ones before it
  const result = new Map();
  /** @type {Map<string, any>} */ const live = new Map(after.map(t => [t.name, fixed.get(t.name) || t]));
  const taken = (/** @type {string} */ target, /** @type {string} */ name, /** @type {string} */ label, /** @type {string} */ exceptType, /** @type {string} */ exceptField) => {
    const tt = live.get(target);
    const { names, labels } = usedOn({ fields: (tt.fields || []).filter((/** @type {any} */ x) => x.kind) }, [...inversesFlat(live, target, exceptType, exceptField)]);
    return names.has(snake(name)) || labels.has(snake(label));
  };
  for (const [name, t] of fixed) {
    const fields = (t.fields || []).map((/** @type {any} */ f) => {
      if (f.kind !== "link" || !f.to) return f;
      if (f.inverse === null) {
        const inv = deriveInverse(t, f, (n, l) => taken(f.to, n, l, t.name, f.name));
        if (!inv) throw bad(`${t.name}.${f.name}: no free name for its inverse on ${f.to}; give it one (inverse: { name, label })`);
        const nf = { ...f, inverse: inv };
        live.set(name, { ...live.get(name), fields: live.get(name).fields.map((/** @type {any} */ x) => (x.name === f.name ? nf : x)) });
        return nf;
      }
      // an explicit inverse is checked against everything else on the target
      if (taken(f.to, f.inverse.name, f.inverse.label, t.name, f.name)) throw bad(`${t.name}.${f.name}: ${f.to} already has a field or an inverse called ${f.inverse.name}`);
      return f;
    });
    result.set(name, { ...t, fields });
  }
  const out = { ...diff };
  if (diff.add_types) out.add_types = diff.add_types.map((/** @type {any} */ t) => result.get(t.name) || t);
  if (diff.change_types) out.change_types = diff.change_types.map((/** @type {any} */ t) => result.get(t.name) || t);
  return out;
}

/** The inverses already standing on `target`, from every link in `live` but the one being checked. */
function* inversesFlat(/** @type {Map<string, any>} */ live, /** @type {string} */ target, /** @type {string} */ exceptType, /** @type {string} */ exceptField) {
  for (const t of live.values()) for (const f of t.fields || []) {
    if (f.kind !== "link" || f.to !== target || !f.inverse || (t.name === exceptType && f.name === exceptField)) continue;
    yield { name: f.inverse.name, label: f.inverse.label };
  }
}

/** The filter that finds the records whose link field holds `urn` (a single link equals it, a list contains it). @param {any} field @param {string} urn */
export const linkFilter = (field, urn) => ({ field: field.name, op: field.many === true ? "contains" : "eq", value: { urn } });

/** Put `to` where `from` was in a link value: a single link becomes `to`, a list swaps the entry (and drops a repeat). @param {any} field @param {any} value @param {string} from @param {string} to */
export function swapLink(field, value, from, to) {
  if (field.many === true) {
    const list = Array.isArray(value) ? value : [];
    const out = [], seen = new Set();
    for (const x of list) { const u = x && x.urn === from ? to : x && x.urn; if (!u || seen.has(u)) continue; seen.add(u); out.push({ urn: u }); }
    return out;
  }
  return { urn: to };
}
