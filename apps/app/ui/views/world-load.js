// @ts-check
// How the records world asks the Store for each type's list. By default every type is read whole; a screen may name a filter for the one type it shows (records.list takes it, "$me" meaning the caller),
// so a long list is cut by the box and not by the screen after paging.

/** The second argument of Store.list for a type: { filter } when the screen named one for it, else nothing, so existing callers read exactly what they did. @param {string} type @param {Record<string, object | undefined> | undefined} filters @returns {{ filter?: any }} */
export function listQuery(type, filters) {
  const f = filters && filters[type];
  return f && typeof f === "object" ? { filter: f } : {};
}

/** A stable key for the filters, so the loader runs again when they change and not on every render. @param {Record<string, object | undefined> | undefined} filters */
export const filtersKey = (filters) => JSON.stringify(Object.entries(filters || {}).filter(([, v]) => v).sort(([a], [b]) => (a < b ? -1 : 1)));
