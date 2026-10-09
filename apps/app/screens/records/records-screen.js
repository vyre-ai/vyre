// @ts-check
// /u/records/<type> as a screen in the design language: one `records` block (data source: the space's own records) that draws the page. The block's behaviour (sorting, filters, stored views,
// the board, the calendar, the dashboard) is the type's own; this is only the description of the route, which is why it is data.

/** @param {string} type @param {string} [view] a stored view of the type, opened by name */
export const recordsScreen = (type, view) => ({
  v: /** @type {const} */ (2), id: "records", layout: { block: "recs" },
  blocks: { recs: { type: "records", props: { page: true }, data: { records: { type, ...(view ? { view } : {}) } } } },
});
