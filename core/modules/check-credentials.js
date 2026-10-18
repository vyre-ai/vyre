// @ts-check
// The shape check for a module's needs.credentials (moved out of index.js unchanged).

const NEED = /^[a-z][a-z0-9_-]{0,40}$/;
/**
 * needs.credentials (ADR 0028, decision 9a): what a module needs from the Vault, which the vault
 * lists and fills. The kind and provider words are the vault's to check; this checks the shape.
 * @param {any} list
 */
export function checkCredentials(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return ["needs.credentials must be a list"];
  const out = [], ids = new Set();
  for (const [i, c] of list.entries()) {
    const at = `needs.credentials[${i}]`;
    if (!c || typeof c !== "object" || Array.isArray(c)) { out.push(`${at} must be an object`); continue; }
    if (!NEED.test(String(c.id ?? ""))) out.push(`${at}.id must be a lowercase name`);
    else if (ids.has(c.id)) out.push(`${at}.id ${c.id} is declared twice`);
    ids.add(c.id);
    for (const k of ["kind", "provider", "purpose"]) if (typeof c[k] !== "string" || !c[k]) out.push(`${at}.${k} must be a string`);
    if (c.item !== undefined && !/^[A-Za-z0-9_.-]{1,128}$/.test(String(c.item))) out.push(`${at}.item must be a vault item name`);
    if (c.group !== undefined && !NEED.test(String(c.group))) out.push(`${at}.group must be a lowercase name`);
    if (c.optional !== undefined && typeof c.optional !== "boolean") out.push(`${at}.optional must be true or false`);
    // multiple: one item per account, named <module>-<label> when the person connects it.
    if (c.multiple !== undefined && typeof c.multiple !== "boolean") out.push(`${at}.multiple must be true or false`);
    if (c.multiple === true && c.item !== undefined) out.push(`${at}.item cannot be set with multiple: each item is named <module>-<label>`);
  }
  return out;
}
