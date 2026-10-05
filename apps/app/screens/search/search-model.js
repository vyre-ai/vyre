// @ts-check
// Search: one box over what this device already holds. The person's records (titles and plain text fields, never a sealed one) and, from the box, the groups mentions.search answers (files, vault names, artifacts,
// GitHub). Pure, so Node tests it.

/** @typedef {{ kind: string, label: string, items: { id: string, name: string, hint?: string }[] }} Group */

/** Does one record's plain text hold every word typed? Sealed values are never read. @param {any} rec @param {string} q */
export function matches(rec, q) {
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const hay = [];
  const data = rec && typeof rec.data === "object" && rec.data ? rec.data : rec && typeof rec.fields === "object" && rec.fields ? rec.fields : {};
  for (const v of Object.values(data)) if (typeof v === "string") hay.push(v.toLowerCase());
  hay.push(String(rec?.id ?? "").toLowerCase());
  const all = hay.join(" \n ");
  return words.every((w) => all.includes(w));
}

/**
 * The record group: every type's records that match, with the type's label as the hint. `titleOf(def, rec)` names a row. At most `limit` per search.
 * @param {{ types: any[], byType: Record<string, any[]> } | null | undefined} world @param {string} q @param {(def: any, rec: any) => string} titleOf @param {number} [limit]
 * @returns {Group | null}
 */
export function recordGroup(world, q, titleOf, limit = 12) {
  if (!world || !String(q).trim()) return null;
  const items = [];
  for (const def of world.types ?? []) {
    if (def.internal || /^(def-|flow-|kit-)/.test(String(def.name))) continue;
    for (const rec of (world.byType?.[def.name] ?? [])) {
      if (!matches(rec, q) && !String(titleOf(def, rec)).toLowerCase().includes(String(q).trim().toLowerCase())) continue;
      items.push({ id: String(rec.urn ?? rec.id), name: String(titleOf(def, rec)), hint: String(def.label ?? def.name) });
      if (items.length >= limit) return { kind: "record", label: "Records", items };
    }
  }
  return items.length ? { kind: "record", label: "Records", items } : null;
}

/** Where a result opens. Null: it only reads. @param {string} kind @param {string} id */
export function routeFor(kind, id) {
  if (kind === "record") return `/u/record/${String(id).split("/").pop()}`;
  if (kind === "vault") return "/u/vault";
  if (kind === "drive") return "/u/drive";
  if (kind === "session") return `/session/${id}`;
  return null;
}

/** mentions.search's answer as groups. @param {any} a @returns {Group[]} */
export function groupsOf(a) {
  return (Array.isArray(a?.groups) ? a.groups : []).filter((/** @type {any} */ g) => g && Array.isArray(g.items) && g.items.length)
    .map((/** @type {any} */ g) => ({ kind: String(g.kind), label: String(g.label || g.kind), items: g.items.map((/** @type {any} */ i) => ({ id: String(i.id), name: String(i.name), ...(i.hint ? { hint: String(i.hint) } : {}) })) }));
}
