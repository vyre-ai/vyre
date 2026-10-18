// @ts-check
// Who a list is about, for the types whose rows belong to a person: Notes (Mine, Shared with me, Space), Communications (Mine, On records I can see) and Events (Mine, Team, Everyone). The box already cuts every
// list to what the caller may read, so these only narrow it by the row's owner ("person:<id>", set on create) and, for Space, its visibility.

const SCOPES = {
  note: [["mine", "Mine"], ["shared", "Shared with me"], ["space", "Space"]],
  "record-note": [["mine", "Mine"], ["shared", "Shared with me"], ["space", "Space"]],
  communication: [["mine", "Mine"], ["visible", "On records I can see"]],
  event: [["mine", "Mine"], ["team", "Team"], ["everyone", "Everyone"]],
};

/** The scopes a type offers, in order, or an empty list for a type that has none. @param {string} type @returns {[string, string][]} */
export const scopesFor = (type) => /** @type {any} */ (SCOPES)[type] || [];

/** A person id without the "person:" prefix. @param {unknown} v */
const bare = (v) => String(v || "").replace(/^person:/, "");

/** The rows a scope shows. A row without an owner is nobody's, so it is never "Mine". @param {any[]} rows @param {string} scope @param {string | undefined} me */
export function filterByScope(rows, scope, me) {
  const mine = (/** @type {any} */ r) => !!me && !!bare(r && r.data && r.data.owner) && bare(r.data.owner) === bare(me);
  switch (scope) {
    case "mine": return rows.filter(mine);
    case "shared": case "team": return rows.filter((r) => !mine(r));
    case "space": return rows.filter((r) => r && r.data && r.data.visibility === "space");
    default: return rows;
  }
}

/** The scope a type opens on: Mine for Notes and Communications, Team for Events (the people you work with, and the Busy blocks of the rest). @param {string} type */
export const defaultScope = (type) => (type === "event" ? "team" : (scopesFor(type)[0] || [""])[0]);

/** The records.list filter that cuts a scope on the box ("$me" is the caller), or undefined when the scope keeps every row it may read. @param {string} scope */
export function scopeFilter(scope) {
  if (scope === "mine") return { field: "owner", op: "eq", value: "$me" };
  if (scope === "shared" || scope === "team") return { field: "owner", op: "ne", value: "$me" };
  if (scope === "space") return { field: "visibility", op: "eq", value: "space" };
  return undefined;
}

/** One line under the scope tabs of Events, in the words of the approved design. @param {string} type @param {string} scope */
export function scopeNote(type, scope) {
  if (type !== "event") return "";
  return /** @type {Record<string, string>} */ ({ mine: "Your events and the ones you are on.", team: "Space events and your team's calendars. Private ones show as Busy.", everyone: "Only events shared with the whole Space." })[scope] || "";
}
