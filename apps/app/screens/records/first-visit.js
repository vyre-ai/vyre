// @ts-check
// The first visit to Records in a new Space: almost nothing is there yet, so the page asks "What does your team do?" (one sentence; the Engineer proposes the types, roles, stages and views) and offers sample data
// that comes out again in one click. These are the two questions the screen asks of the world: is it the first visit, and is sample data on.

/** The records that are sample data: tagged so by the box (records.sample.add), in their labels or their data. @param {any} rec */
export const isSample = (rec) => !!(rec && ((rec.labels && rec.labels.sample) || (rec.data && rec.data.sample === true)));

/** How many sample records the Space holds. @param {{ byType?: Record<string, any[]> } | undefined} world */
export const sampleCount = (world) => Object.values((world && world.byType) || {}).reduce((n, rows) => n + (rows || []).filter(isSample).length, 0);

/** Whether this is a day-one Space: no sample data, and no more than a handful of records in all (the person, the team, their company). @param {{ byType?: Record<string, any[]> } | undefined} world @param {number} [few] */
export function isDayOne(world, few = 6) {
  const rows = Object.values((world && world.byType) || {}).reduce((n, r) => n + (r || []).length, 0);
  return rows <= few && sampleCount(world) === 0;
}
