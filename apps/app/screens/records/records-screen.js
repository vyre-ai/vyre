// @ts-check
// /u/records/<type> as a screen in the design language: one `records` block (data source: the space's own records) that draws the page. The block's behaviour (sorting, filters, stored views,
// the board, the calendar, the dashboard) is the type's own; this is only the description of the route, which is why it is data.

/** @param {string} type @param {string} [view] a stored view of the type, opened by name */
export const recordsScreen = (type, view) => ({
  v: /** @type {const} */ (2), id: "records", layout: { block: "recs" },
  blocks: { recs: { type: "records", props: { page: true }, data: { records: { type, ...(view ? { view } : {}) } } } },
});

/**
 * Whether a type's older records are waiting for their ID: the type has an ID field, one of its records has none, and the person may define types (an owner or an admin: `canDefine`). Opening such a type asks for
 * the type's own definition again, unchanged: records.define then gives those records their IDs, oldest first, under that person's own chain (core/records-tools). Asked once for a type in a visit.
 * @param {{ def: any, rows: any[], canDefine: boolean }} o
 */
export const needsIdFill = ({ def, rows, canDefine }) => Boolean(canDefine && def && Array.isArray(def.fields) && def.fields.some((/** @type {any} */ f) => f && f.name === "ref") && Array.isArray(rows) && rows.some((r) => r && r.data && !r.data.ref));
