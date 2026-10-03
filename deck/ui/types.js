// @ts-check
// deck/ui/types: the sample type definitions, as data (contracts.js TypeDef). Every list, board, calendar, dashboard and record page in the Deck is
// drawn from one of these and nothing else (ui/views.js): a new type is a new entry here, never a new screen. The mock store serves them from types().
// They follow the approved prototype (team/0.2.2/prototype-src/p3a.js) and ui-primitives.md section 5. Sample names come from the made-up world.

/** @typedef {import("./contracts.js").TypeDef} TypeDef */
/** @typedef {import("./contracts.js").FieldDef} FieldDef */

export const MATTER_STAGES = ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"];
export const PROJECT_STAGES = ["Plan", "Build", "Review", "Ship"];
export const TRIP_STAGES = ["Dreaming", "Booked", "Packing", "Away", "Back"];

/** @type {TypeDef & { initials?: boolean }} */
export const contact = {
  id: "contact", name: "Contact", plural: "Contacts", icon: "users", space: "harlow", titleKey: "name", initials: true,
  fields: [
    { key: "name", label: "Name", kind: "text", required: true },
    { key: "role", label: "Role", kind: "choice", options: ["Client", "Referrer", "Vendor", "Friend", "Family"] },
    { key: "email", label: "Email", kind: "email" },
    { key: "phone", label: "Phone", kind: "phone" },
    { key: "rating", label: "Fit", kind: "rating" },
    { key: "address", label: "Address", kind: "address" },
    { key: "dob", label: "Date of birth", kind: "date" },
    { key: "ssn", label: "SSN", kind: "sealed" },
    { key: "acct", label: "Account number", kind: "sealed" },
    { key: "notes", label: "Notes", kind: "richText" },
    { key: "matter", label: "Matter", kind: "link", link: "matter" },
  ],
  views: {
    list: { columns: ["role", "email", "phone", "rating"], sort: "name" },
    board: { groupBy: "role", card: ["email", "rating"] },
  },
};

/** @type {TypeDef} */
export const matter = {
  id: "matter", name: "Matter", plural: "Matters", icon: "records", space: "harlow", titleKey: "title", holdsWork: true,
  fields: [
    { key: "title", label: "Title", kind: "text", required: true },
    { key: "client", label: "Client", kind: "link", link: "contact" },
    { key: "plan", label: "Plan", kind: "choice", options: ["Will", "Trust", "Both"] },
    { key: "situation", label: "Family situation", kind: "text" },
    { key: "assets", label: "Assets in play", kind: "text" },
    { key: "pressure", label: "Time pressure", kind: "text" },
    { key: "fee", label: "Fee", kind: "money", currency: "USD" },
    { key: "stage", label: "Stage", kind: "stage", stages: MATTER_STAGES },
    { key: "owner", label: "Owner", kind: "actor" },
    { key: "opened", label: "Opened", kind: "date" },
    { key: "closing", label: "Closing", kind: "date" },
    { key: "docs", label: "Main document", kind: "file" },
  ],
  views: {
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
};

/** @type {TypeDef} */
export const project = {
  id: "project", name: "Project", plural: "Projects", icon: "projects", space: "mine", titleKey: "title", holdsWork: true,
  fields: [
    { key: "title", label: "Title", kind: "text", required: true },
    { key: "stage", label: "Phase", kind: "stage", stages: PROJECT_STAGES },
    { key: "owner", label: "Owner", kind: "actor" },
    { key: "priority", label: "Priority", kind: "choice", options: ["Low", "Normal", "High"] },
    { key: "budget", label: "Budget", kind: "money", currency: "USD" },
    { key: "due", label: "Due", kind: "date" },
    { key: "brief", label: "Brief", kind: "file" },
    { key: "notes", label: "Notes", kind: "richText" },
  ],
  views: {
    list: { columns: ["stage", "owner", "priority", "due"], sort: "due" },
    board: { groupBy: "stage", card: ["title", "owner", "due"] },
    calendar: { date: "due" },
    dashboard: { widgets: [{ kind: "countBy", field: "stage" }, { kind: "sum", field: "budget", where: "stage != Ship" }, { kind: "recent" }] },
  },
};

/** @type {TypeDef} */
export const trip = {
  id: "trip", name: "Trip", plural: "Trips", icon: "planner", space: "mine", titleKey: "title", holdsWork: true,
  fields: [
    { key: "title", label: "Title", kind: "text", required: true },
    { key: "stage", label: "Status", kind: "stage", stages: TRIP_STAGES },
    { key: "where", label: "Destination", kind: "address" },
    { key: "leaves", label: "Leaves", kind: "date" },
    { key: "returns", label: "Returns", kind: "date" },
    { key: "budget", label: "Budget", kind: "money", currency: "USD" },
    { key: "with", label: "Travelling with", kind: "actor" },
    { key: "booking", label: "Booking code", kind: "sealed", showLast4: true },
    { key: "plan", label: "Itinerary", kind: "file" },
    { key: "notes", label: "Notes", kind: "richText" },
  ],
  views: {
    list: { columns: ["stage", "where", "leaves", "budget"], sort: "leaves" },
    board: { groupBy: "stage", card: ["title", "leaves", "budget"] },
    calendar: { date: "leaves" },
  },
};

/** @type {TypeDef} */
export const template = {
  id: "template", name: "Template", plural: "Templates", icon: "lines", space: "harlow", titleKey: "name",
  fields: [
    { key: "name", label: "Name", kind: "text", required: true },
    { key: "kind", label: "Kind", kind: "choice", options: ["Email", "Letter", "Form"] },
    { key: "body", label: "Body", kind: "richText" },
    { key: "owner", label: "Owner", kind: "actor" },
    { key: "uses", label: "Times used", kind: "number" },
    { key: "updated", label: "Updated", kind: "date" },
    { key: "source", label: "Source file", kind: "file" },
  ],
  views: {
    list: { columns: ["kind", "owner", "uses", "updated"], sort: "name" },
    board: { groupBy: "kind", card: ["owner", "uses"] },
  },
};

/** @type {TypeDef[]} */
export const types = [contact, matter, project, trip, template];
export const TYPES = types;
export default types;

/** @param {string} id @returns {TypeDef | undefined} */
export const typeById = id => types.find(t => t.id === id);
