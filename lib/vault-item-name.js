// @ts-check
// The name of a Vault item made from the name a person gave an account: the Vault's names are letters, digits, dot, dash and underscore (up to 128), so "Work Claude" is kept as "Work-Claude". The account keeps the
// name the person typed (its label); the item is found in the Vault by this one. Pure.

/** The Vault item name for an account's label: runs of anything else become one dash, the name starts with a letter or digit, and is at most 100 long. "ai-key" when nothing is left. @param {string} label */
export function itemNameOf(label) {
  const t = String(label || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/-+$/, "").slice(0, 100).replace(/-+$/, "");
  return t || "ai-key";
}

/** The first free name for `base` among the names in use (compared without case): the base itself, else base-2, base-3 ... Null when a hundred are taken. @param {string} base @param {ReadonlySet<string>} used lowercased names */
export function freeItemName(base, used) {
  let item = base, n = 2;
  while (used.has(item.toLowerCase()) && n < 100) item = `${base}-${n++}`;
  return used.has(item.toLowerCase()) ? null : item;
}
