// @ts-check
// deck/ui/view-defs: how each type is shown, as UI-side configuration keyed by the type's name. The kernel's TypeDefinition says what a record IS (fields, stages,
// rules); it has no list columns, no board grouping, no calendar date and no dashboard widgets, no plural, no title field. Those live here until the kernel has a
// `def.view` the Deck can read (SPEC-core-contract.md 5.1 names the reserved kind). A ViewDefinition only ever names fields by their `name`.
//
//   list       { columns, sort }              the table
//   board      { groupBy, card }              columns by a choice or stage field
//   calendar   { date }                       a month grid on a date field
//   dashboard  { widgets: [{ kind: "sum"|"countBy"|"funnel"|"recent", field?, where? }] }
//   titleField the field that names a record (its title on every card and row)
//   plural     the plural of the label, for headings ("Contacts")
//   holdsWork  the type appears under Projects and its record page has tasks, members, chats and files
//   initials   draw a tile of the title's initials before it (people-like types)

/** @typedef {{ kind: "sum"|"countBy"|"funnel"|"recent", field?: string, where?: string }} Widget */
/** @typedef {{ plural: string, titleField: string, holdsWork?: boolean, initials?: boolean, list?: { columns: string[], sort?: string }, board?: { groupBy: string, card: string[] },
 *   calendar?: { date: string }, dashboard?: { widgets: Widget[] } }} ViewDefinition */

/** @type {Record<string, ViewDefinition>} */
export const viewDefs = {
  contact: {
    plural: "Contacts", titleField: "name", initials: true,
    list: { columns: ["role", "email", "phone", "rating"], sort: "name" },
    board: { groupBy: "role", card: ["email", "rating"] },
  },
  matter: {
    plural: "Matters", titleField: "title", holdsWork: true,
    list: { columns: ["client", "stage", "fee", "owner"], sort: "closing" },
    board: { groupBy: "stage", card: ["title", "client", "fee", "owner"] },
    calendar: { date: "closing" },
    dashboard: { widgets: [
      { kind: "sum", field: "fee", where: "stage != Closed" },
      { kind: "countBy", field: "stage" },
      { kind: "funnel", field: "stage", where: "Intake..Signing" },
      { kind: "recent" },
    ] },
  },
  project: {
    plural: "Projects", titleField: "title", holdsWork: true,
    list: { columns: ["stage", "owner", "priority", "due"], sort: "due" },
    board: { groupBy: "stage", card: ["title", "owner", "due"] },
    calendar: { date: "due" },
    dashboard: { widgets: [{ kind: "countBy", field: "stage" }, { kind: "sum", field: "budget", where: "stage != Ship" }, { kind: "recent" }] },
  },
  trip: {
    plural: "Trips", titleField: "title", holdsWork: true,
    list: { columns: ["stage", "where", "leaves", "budget"], sort: "leaves" },
    board: { groupBy: "stage", card: ["title", "leaves", "budget"] },
    calendar: { date: "leaves" },
  },
  template: {
    plural: "Templates", titleField: "name",
    list: { columns: ["kind", "owner", "uses", "updated"], sort: "name" },
    board: { groupBy: "kind", card: ["owner", "uses"] },
  },
};

/** The view definition of a type, or a plain one (title is the first field, five columns) for a type this table does not know. @param {{ name: string, label?: string, fields: readonly { name: string }[] }} def @param {Record<string, ViewDefinition>} [table] @returns {ViewDefinition} */
export function viewDefOf(def, table = viewDefs) {
  return table[def.name] || { plural: `${def.label || def.name}s`, titleField: def.fields[0]?.name || "name", list: { columns: def.fields.slice(1, 5).map(f => f.name) } };
}

/** A private copy, so a test or a screen that edits a view leaves the shared table alone. */
export const cloneViewDefs = () => /** @type {Record<string, ViewDefinition>} */ (structuredClone(viewDefs));
