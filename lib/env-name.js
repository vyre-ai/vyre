// @ts-check
// env-name: the one rule for a Vault field's name. A field is named like an environment variable, and its name is case-insensitive: "ghl api-key", "Ghl_Api_Key" and "GHL_API_KEY"
// are one name, shown and matched as GHL_API_KEY (UPPER_SNAKE). The Vault screens, the vault's release and run paths and the needs all ask this file, so a Flow that asks for
// ghl_api_key gets GHL_API_KEY. A stored name is never renamed on disk by a read: it is matched by its canonical form, and renamed only when the person next edits the item.
// Names only: nothing here sees a value.

/**
 * A field name in its one form: letters and digits in upper case, every run of anything else one underscore, none at either end. A name that would start with a digit gets a
 * leading underscore, so it is still an environment variable name. "" when nothing usable is left.
 * @param {string} name
 * @returns {string}
 */
export function canonical(name) {
  const s = canon(name).slice(0, 64);
  return /^[0-9]/.test(s) ? `_${s}`.slice(0, 64) : s;
}

/** A name as the Vault compares it, item or field: upper case, every run of other characters one underscore. "Northwind CRM" and northwind-crm are both NORTHWIND_CRM. The placeholders
 * (core/vault/use.js) and the field matching here use this one rule. @param {unknown} s */
export const canon = s => String(s ?? "").trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** Is this already the one form (what agents and Flows get as the name)? @param {string} name */
export const isCanonical = name => /^[A-Z_][A-Z0-9_]{0,63}$/.test(String(name)) && canonical(name) === name;

/** Do two names name the same field? @param {string} a @param {string} b */
export const sameName = (a, b) => canon(a) !== "" && canon(a) === canon(b);

/**
 * The stored name that answers a wanted one: the exact name when the item has it, else the one stored name with the same canonical form. When two stored names share that form
 * (an older item), none is picked: the person renames one first. Returns the wanted name unchanged when nothing matches, so the caller's own "no field" words still apply.
 * @param {string[]} names the item's stored field names
 * @param {string} want
 * @returns {string}
 */
export function fieldIn(names, want) {
  if (!want || names.includes(want)) return want;
  const hits = names.filter(n => sameName(n, want));
  return hits.length === 1 ? hits[0] : want;
}

/**
 * The fields of one item whose names clash once made canonical (an older item with API_KEY and api_key): each clash as its canonical form and the stored names in it.
 * @param {string[]} names
 * @returns {{ name: string, stored: string[] }[]}
 */
export function clashes(names) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const n of names) { const c = canonical(n); if (!c) continue; by.set(c, [...(by.get(c) || []), n]); }
  return [...by.entries()].filter(([, xs]) => xs.length > 1).map(([name, stored]) => ({ name, stored }));
}
