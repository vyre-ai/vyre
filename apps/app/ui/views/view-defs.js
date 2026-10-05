// @ts-check
// @vyre/ui/views/view-defs (moved from deck/ui/view-defs.js): how each type is shown, as UI-side configuration keyed by the type's name. The kernel's TypeDefinition says what a record IS (fields, stages,
// rules); it has no list columns, no board grouping, no calendar date and no dashboard widgets, no plural, no title field. Those live here until the kernel has a
// `def.view` the Deck can read (SPEC-core-contract.md 5.1 names the reserved kind). A ViewDefinition only ever names fields by their `name`.
//
// The type's own `views` (stored with the definition, kernel/contracts ViewDef) come first: viewDefOf lays the first list, board and calendar view of a type over
// what this table says, so a Kit or a person can change how a type is shown without touching the UI. This table is only the default for a type that stores none.
//
//   list       { columns, sort, sortDir, filter }   the table (`filter`: an Expression over the record, only records it holds for are shown)
//   board      { groupBy, card, filter }      columns by a choice or stage field
//   calendar   { date, filter }               a month grid on a date field
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

/** The view definition of a type: the table's entry or a plain one, with the type's stored views laid over it. @param {{ name: string, label?: string, kind?: string, fields: readonly { name: string, kind?: string }[], views?: readonly StoredView[] }} def @param {Record<string, ViewDefinition>} [table] @param {string} [viewName] the stored view of each kind to show, by name @returns {ViewDefinition} */
export function viewDefOf(def, table = viewDefs, viewName) {
  const base = defaultViewDef(def, table);
  return def.views && def.views.length ? withStoredViews(base, def, viewName) : base;
}

/** The type's stored views of one kind (`list`, `board` or `calendar`), in the order stored: what a switcher offers by name. @param {{ views?: readonly StoredView[] }} def @param {string} type */
export const storedViewsOf = (def, type) => (def.views || []).filter(v => v.type === type).map(v => ({ name: v.name, label: v.label || v.name, type: v.type }));

/** @typedef {{ name: string, type: string, label?: string, groupBy?: string, dateField?: string, columns?: readonly string[], filter?: string, sort?: { field: string, dir?: "asc"|"desc" } }} StoredView */

/** The first stored view of each kind decides that mode, or the one named `viewName` for its own kind. A name a type does not have is dropped, so a stale view never breaks a screen. @param {ViewDefinition} base @param {{ fields: readonly { name: string }[], views?: readonly StoredView[] }} def @param {string} [viewName] @returns {ViewDefinition} */
function withStoredViews(base, def, viewName) {
  const has = (/** @type {string | undefined} */ n) => typeof n === "string" && def.fields.some(f => f.name === n);
  const cols = (/** @type {readonly string[] | undefined} */ c) => (c || []).filter(has);
  const first = (/** @type {string} */ type) => (def.views || []).find(v => v.type === type && v.name === viewName) || (def.views || []).find(v => v.type === type);
  const out = { ...base };
  const list = first("list"), board = first("board"), cal = first("calendar");
  if (list) {
    const columns = cols(list.columns);
    out.list = { ...(base.list || { columns: [] }), ...(columns.length ? { columns } : {}), ...(list.sort && has(list.sort.field) ? { sort: list.sort.field, sortDir: list.sort.dir === "desc" ? "desc" : "asc" } : {}), ...(list.filter ? { filter: list.filter } : {}) };
  }
  if (board && has(board.groupBy)) {
    const card = cols(board.columns);
    out.board = { groupBy: /** @type {string} */ (board.groupBy), card: card.length ? card : base.board?.card ?? out.list?.columns ?? [], ...(board.filter ? { filter: board.filter } : {}) };
  }
  if (cal && has(cal.dateField)) out.calendar = { date: /** @type {string} */ (cal.dateField), ...(cal.filter ? { filter: cal.filter } : {}) };
  return out;
}

/** What the type shows with nothing stored: the table's entry, or a plain list (title is the first field, five columns) for a type this table does not know. @param {{ name: string, label?: string, kind?: string, fields: readonly { name: string, kind?: string }[] }} def @param {Record<string, ViewDefinition>} table @returns {ViewDefinition} */
function defaultViewDef(def, table) {
  if (table[def.name]) return table[def.name];
  // A type this table does not know (a space's own, or one a Kit added): a plain list. It holds work, and shows under Projects, only when its definition says so
  // (`kind: "project"`, set in Customize or by a Kit). Having a stage is not enough: a role such as a Prospect has stages and is not a project.
  // A board groups by the stage field, or by the first choice field when there is no stage (a Lead by its Practice area).
  const group = def.fields.find(f => f.kind === "stage") || def.fields.find(f => f.kind === "choice");
  return {
    plural: `${def.label || def.name}s`, titleField: def.fields[0]?.name || "name", list: { columns: def.fields.slice(1, 5).map(f => f.name) },
    ...(def.kind === "project" ? { holdsWork: true } : {}),
    ...(group ? { board: { groupBy: group.name, card: def.fields.filter(f => f !== group).slice(0, 3).map(f => f.name) } } : {}),
  };
}

/** A private copy, so a test or a screen that edits a view leaves the shared table alone. */
export const cloneViewDefs = () => /** @type {Record<string, ViewDefinition>} */ (structuredClone(viewDefs));
