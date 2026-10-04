// @ts-check
// deck/ui/types: the sample type definitions, as the kernel's own TypeDefinition values (kernel/contracts/fields.d.ts): a name, a label, an icon, fields of the
// kernel's FieldKind set, and stages that carry task templates. Every list, board, calendar, dashboard and record page in the Deck is drawn from one of these plus
// its ViewDefinition (view-defs.js), and nothing else (ui/views.js): a new type is a new entry here, never a new screen. The mock store serves them from types().
// They follow the approved prototype (team/0.2.2/prototype-src/p3a.js) and ui-primitives.md section 5. Sample names come from the made-up world.
//
// Mapping from the Deck's first sketch: email, phone and richText became emails, phones and rich_text (a person has more than one number); link became link or ref
// (both name a record type in `to`); a field's key became its `name`; a stage field's list became its `options`; sealed became a `seal` config on a sealed field
// (level "human": only the reveal roles, each reveal with fresh presence; level "ai": no model ever, people per grant).

/** @typedef {import("./contracts.js").TypeDefinition} TypeDefinition */
/** @typedef {import("./contracts.js").FieldDefinition} FieldDefinition */
/** @typedef {import("./contracts.js").StageDef} StageDef */
/** @typedef {import("./contracts.js").TaskTemplateDef} TaskTemplateDef */

export const MATTER_STAGES = ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"];
export const PROJECT_STAGES = ["Plan", "Build", "Review", "Ship"];
export const TRIP_STAGES = ["Dreaming", "Booked", "Packing", "Away", "Back"];

const DAY = 86_400_000;

/**
 * The Kit "Estate planning matter": the tasks each stage makes (DESIGN-tasks.md, idea 5), as the kernel's TaskTemplateDef. A doer is a reference ("teammate:research",
 * "person:alex"); the title may hold {client}; depends_on names tasks of the same stage by title; the template is a Template record's name.
 * @type {Record<string, TaskTemplateDef[]>}
 */
export const ESTATE_KIT_TASKS = {
  Intake: [
    { title: "Research the client", doer: "teammate:research", output: { kind: "fields", target: "situation,assets,pressure,research" }, how: "assistant" },
    { title: "Welcome email for {client}", doer: "teammate:intake", checker: "person:alex", output: { kind: "sent", target: "Email to {client}" }, how: "tailor", template: "Welcome",
      depends_on: ["Research the client"] },
  ],
  Engagement: [
    { title: "Engagement letter", doer: "teammate:drafting", checker: "person:alex", output: { kind: "sent", target: "Letter for signature" }, how: "tailor", template: "Engagement letter", due_offset_ms: DAY },
    { title: "Review the draft with {client}", doer: "person:alex", output: { kind: "decision", target: "Approved or changes" }, how: "person", depends_on: ["Engagement letter"], due_offset_ms: 3 * DAY },
  ],
  Drafting: [{ title: "Draft the trust and will", doer: "teammate:drafting", checker: "person:chris", output: { kind: "file", target: "Trust and will" }, how: "assistant", due_offset_ms: 5 * DAY }],
  Signing: [
    { title: "Signing date", doer: "person:alex", output: { kind: "fields", target: "signing" }, how: "person" },
    { title: "Collect signatures", doer: "person:alex", output: { kind: "file", target: "Signed documents" }, how: "person", depends_on: ["Signing date"] },
  ],
  Funding: [{ title: "Fund the trust and record the deed", doer: "agent:rev", checker: "person:chris", output: { kind: "file", target: "Recorded deed" }, how: "assistant" }],
};

/** @type {TypeDefinition} */
export const contact = {
  name: "contact", label: "Contact", icon: "users",
  fields: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "role", label: "Role", kind: "choice", options: ["Client", "Referrer", "Vendor", "Friend", "Family"] },
    { name: "email", label: "Email", kind: "emails" },
    { name: "phone", label: "Phone", kind: "phones" },
    { name: "rating", label: "Fit", kind: "rating" },
    { name: "address", label: "Address", kind: "address" },
    { name: "dob", label: "Date of birth", kind: "date" },
    { name: "ssn", label: "SSN", kind: "sealed", seal: { level: "human", class: "us-ssn" } },
    { name: "acct", label: "Account number", kind: "sealed", seal: { level: "human", class: "bank-account" } },
    { name: "notes", label: "Notes", kind: "rich_text" },
    { name: "matter", label: "Matter", kind: "link", to: "matter" },
  ],
};

/** @type {TypeDefinition} */
export const matter = {
  name: "matter", label: "Matter", kind: "project", icon: "records",
  fields: [
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "client", label: "Client", kind: "link", to: "contact" },
    { name: "plan", label: "Plan", kind: "choice", options: ["Will", "Trust", "Both"] },
    { name: "situation", label: "Family situation", kind: "text" },
    { name: "assets", label: "Assets in play", kind: "text" },
    { name: "pressure", label: "Time pressure", kind: "text" },
    { name: "fee", label: "Fee", kind: "money" },
    { name: "stage", label: "Stage", kind: "stage", options: MATTER_STAGES },
    { name: "owner", label: "Owner", kind: "actor" },
    { name: "opened", label: "Opened", kind: "date" },
    { name: "closing", label: "Closing", kind: "date" },
    { name: "docs", label: "Main document", kind: "file" },
  ],
  stages: MATTER_STAGES.map(name => ({ name, ...(ESTATE_KIT_TASKS[name] ? { tasks: ESTATE_KIT_TASKS[name] } : {}) })),
};

/** @type {TypeDefinition} */
export const project = {
  name: "project", label: "Project", kind: "project", icon: "projects",
  fields: [
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "stage", label: "Phase", kind: "stage", options: PROJECT_STAGES },
    { name: "owner", label: "Owner", kind: "actor" },
    { name: "priority", label: "Priority", kind: "choice", options: ["Low", "Normal", "High"] },
    { name: "budget", label: "Budget", kind: "money" },
    { name: "due", label: "Due", kind: "date" },
    { name: "brief", label: "Brief", kind: "file" },
    { name: "notes", label: "Notes", kind: "rich_text" },
  ],
};

/** @type {TypeDefinition} */
export const trip = {
  name: "trip", label: "Trip", kind: "project", icon: "planner",
  fields: [
    { name: "title", label: "Title", kind: "text", required: true },
    { name: "stage", label: "Status", kind: "stage", options: TRIP_STAGES },
    { name: "where", label: "Destination", kind: "address" },
    { name: "leaves", label: "Leaves", kind: "date" },
    { name: "returns", label: "Returns", kind: "date" },
    { name: "budget", label: "Budget", kind: "money" },
    { name: "with", label: "Travelling with", kind: "actor" },
    { name: "booking", label: "Booking code", kind: "sealed", seal: { level: "ai", class: "free", hint_allowed: true } },
    { name: "plan", label: "Itinerary", kind: "file" },
    { name: "notes", label: "Notes", kind: "rich_text" },
  ],
};

/** @type {TypeDefinition} */
export const template = {
  name: "template", label: "Template", icon: "lines",
  fields: [
    { name: "name", label: "Name", kind: "text", required: true },
    { name: "kind", label: "Kind", kind: "choice", options: ["Email", "Letter", "Form"] },
    { name: "body", label: "Body", kind: "rich_text" },
    { name: "owner", label: "Owner", kind: "actor" },
    { name: "uses", label: "Times used", kind: "number" },
    { name: "updated", label: "Updated", kind: "date" },
    { name: "source", label: "Source file", kind: "file" },
  ],
};

/** @type {TypeDefinition[]} */
export const types = [contact, matter, project, trip, template];
export const TYPES = types;
export default types;

/** @param {string} name @returns {TypeDefinition | undefined} */
export const typeByName = name => types.find(t => t.name === name);
