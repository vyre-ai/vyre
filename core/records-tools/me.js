// @ts-check
// "Mine": the token "$me" in a list filter means the person making the call, resolved here from the chain and never from the body. Notes, communications and events carry an `owner` ("person:<id>"),
// filled in when the record is made, so Mine / Team / Everyone are three filters: { field: "owner", op: "eq", value: "$me" }, a filter on owner "ne" "$me", and none.

export const ME = "$me";
export const OWNED = new Set(["record-note", "communication", "event"]);

/** The filter with "$me" replaced by the caller. @param {any} filter @param {string} person the person's id */
export function withMe(filter, person) {
  const who = `person:${person}`;
  const walk = (/** @type {any} */ v) => (v === ME ? who : Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(filter);
}

/** The data of a new record with its owner filled in for the types that have one (a value the caller names is replaced: nobody makes a record for another person this way). @param {string} type @param {any} fields the type's fields @param {Record<string, any>} data @param {string} person */
export function withOwner(type, fields, data, person) {
  if (!OWNED.has(type) || !(fields || []).some((/** @type {any} */ f) => f.name === "owner")) return data;
  return { ...data, owner: `person:${person}` };
}
