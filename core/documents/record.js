// @ts-check
// record: what a filed document looks like as a record of the Space's Document type. The type is the Space's own (the Documents Kit defines one; a firm can change it), so nothing here assumes its
// fields: a value is written only to a field the type has, a link field holds { urn } (never a bare string), and a choice field takes only one of its options.
import { segments } from "../../kernel/core/urn.js";

/**
 * @param {{ name: string, kind?: string, options?: string[], to?: string, many?: boolean }[]} fields the Document type's fields
 * @param {Record<string, any>} data what Documents knows about the document
 * @param {{ space: string, project: (ref: string) => Promise<string | null> }} o `project` turns a project's name or slug into its record's urn, or null
 * @returns {Promise<Record<string, any>>} the row to create
 */
export async function documentRow(fields, data, o) {
  /** @type {Record<string, any>} */ const row = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(data, f.name)) continue;
    const v = data[f.name];
    if (v === undefined || v === null || v === "") continue;
    if (f.kind === "link") {
      const raw = typeof v === "object" && v && typeof v.urn === "string" ? v.urn : String(v);
      const s = segments(raw);
      const urn = s && s.length === 3 && s[0] === o.space ? raw : f.name === "project" ? await o.project(raw) : null;
      if (!urn) continue;
      row[f.name] = f.many === true ? [{ urn }] : { urn };
    } else if (f.kind === "choice") {
      if (Array.isArray(f.options) && f.options.includes(v)) row[f.name] = v;
    } else row[f.name] = v;
  }
  return row;
}
