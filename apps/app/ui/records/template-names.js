// @ts-check
// A project's Template field holds the template's id (tpl_ad-campaign); a person reads its name. Names are read once from the project templates and kept (this visit), and an id that has no name yet
// is shown as words made from it ("Ad campaign"), never as the id.

/** @type {Map<string, string>} */
const names = new Map();
/** @type {Set<() => void>} */
const subs = new Set();

/** Words from an id: "tpl_ad-campaign" reads "Ad campaign". @param {string} id */
export function wordsFromId(id) {
  const w = String(id).replace(/^tpl[_-]/i, "").replace(/[_-]+/g, " ").trim();
  return w ? w[0].toUpperCase() + w.slice(1) : "";
}

/** What to show for a template id: its name when known, else words from the id; empty stays empty. @param {any} id */
export function templateLabel(id) {
  const v = typeof id === "string" ? id : id && typeof id === "object" ? String(id.template ?? id.id ?? "") : "";
  if (!v) return id;
  return names.get(v) || wordsFromId(v) || v;
}

/** True for the one field that holds a template id. @param {any} rec @param {{ name?: string }} f */
export const isTemplateField = (rec, f) => !!rec && rec.type === "project" && !!f && f.name === "template";

/** Keep the names of some template rows (the newest version's name wins is not needed: every version of a template shares its name). @param {any[]} rows */
export function keepTemplateNames(rows) {
  let changed = false;
  for (const r of rows || []) {
    const id = r && r.data && String(r.data.template || ""), name = r && r.data && String(r.data.name || "").trim();
    if (id && name && names.get(id) !== name) { names.set(id, name); changed = true; }
  }
  if (changed) for (const f of [...subs]) { try { f(); } catch { /* a redraw must not stop the others */ } }
}

/** Be told when names arrive. @param {() => void} f */
export function onTemplateNames(f) { subs.add(f); return () => { subs.delete(f); }; }
export const haveTemplateNames = () => names.size > 0;
