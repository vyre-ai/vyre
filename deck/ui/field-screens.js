// @ts-check
// deck/ui/field-screens: what /u/records and /u/record share: the Store (ui/store.js, else the in-file fallback when it is not there), the link index and the
// options views.js takes. Screens read the Store on every draw and redraw when it changes; they keep no copy of their own.
import { fallbackStore } from "./fallback-store.js";

/** @typedef {import("./contracts.js").Store} Store */
/** @type {Store | null} */
let fallback = null;

/** The Store the generated screens read. @returns {Promise<Store>} */
export async function getFieldStore() {
  try {
    const m = await import("./store.js");
    if (typeof m.getStore === "function") return m.getStore();
  } catch { /* store.js not wired: the fallback below */ }
  return (fallback ||= fallbackStore());
}

/** id -> { title, type } for every record of every type, so a link field shows its target's title. @param {Store} store @param {import("./contracts.js").TypeDef[]} types */
export async function linkIndex(store, types) {
  /** @type {Record<string, { title: string, type: string }>} */
  const out = {};
  const lists = await Promise.all(types.map(t => store.list(t.id).then(rows => ({ t, rows }))));
  for (const { t, rows } of lists) for (const r of rows) out[r.id] = { title: String(r.values?.[t.titleKey] ?? r.id), type: t.id };
  return out;
}

/** The plain state a screen shows when the Store cannot be read. @param {any} e */
export const reasonOf = e => String(e?.message || e || "Something went wrong.");

/** The records that link to one record (a contact's matters), as { id, title, type }, for Linked records. @param {Store} store @param {import("./contracts.js").TypeDef[]} types @param {import("./contracts.js").TypeDef} def @param {string} id */
export async function relatedRecords(store, types, def, id) {
  /** @type {{ id: string, title: string, type: string }[]} */
  const out = [];
  for (const t of types) for (const f of t.fields) if (f.kind === "link" && f.link === def.id)
    for (const r of await store.list(t.id)) if (r.values[f.key] === id) out.push({ id: r.id, title: String(r.values[t.titleKey] ?? r.id), type: t.id });
  return out;
}
