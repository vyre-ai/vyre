// @ts-check
// The business record types every Space has before any Kit is installed: events, templates, playbooks and team members
// (team/0.3/DESIGN-tasks.md and DESIGN-native-assistant.md). They are plain kernel TypeDefinitions, stored in the
// Space's Twenty like any other type, so a Kit can link to them and a view can list them.
//
// Tasks are here as a record type (team/0.3/DESIGN-tasks-records.md): what a person reads, edits, links or reports on is a field of the task record; who may act and what the approvals
// depend on stay kernel state keyed by the same id. Goals, Flows, runs, grants and the log live in the kernel store.

const text = (/** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind: "text", label, ...more });
const choice = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string[]} */ options, /** @type {object} */ more = {}) => ({ name, kind: "choice", label, options, ...more });
const f = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind, label, ...more });

export const TEMPLATE_KINDS = ["email", "letter", "document", "message"];

/** A template: email, letter or document text with slots. Sealed values are filled by the kernel at send time, never by a model. */
export const TEMPLATE = {
  name: "template", label: "Template", icon: "IconTemplate",
  fields: [
    text("name", "Name", { required: true }),
    choice("kind", "Kind", TEMPLATE_KINDS, { required: true }),
    text("subject", "Subject"),
    f("rich_text", "body", "Body", { required: true }),
    text("kit", "From Kit"),
  ],
};

/** A playbook: how this firm does something, loaded into an assistant's situation only where it applies. */
export const PLAYBOOK = {
  name: "playbook", label: "Playbook", icon: "IconBook",
  fields: [
    text("name", "Name", { required: true }),
    text("applies_to", "Applies to (a type, a stage or a role)"),
    f("rich_text", "body", "Playbook", { required: true }),
    text("kit", "From Kit"),
  ],
};

/** A team member on a project: a person or an assistant teammate, with the role it plays there. */
export const TEAM_MEMBER = {
  name: "team-member", label: "Team member", icon: "IconUsers",
  fields: [
    text("name", "Name", { required: true }),
    f("actor", "actor", "Person or assistant", { required: true }),
    choice("kind", "Kind", ["person", "assistant"], { required: true }),
    text("role", "Role"),
    text("skills", "Skills (words, comma separated; a Flow that names skills picks among those who have them)"),
    f("link", "project", "Project"),
    f("rich_text", "instructions", "Role instructions (assistants)"),
    text("doing", "Doing right now"),
    f("datetime", "doing_since", "Doing since"),
  ],
};

/** An event on the Space's calendar. The calendar is a view of these (and of any record with a date field). `source` says where it came from; `calendar` and `external_id` tie it to an outside calendar it syncs with. */
export const EVENT_SOURCES = ["vyre", "google"];
export const EVENT = {
  name: "event", label: "Event", icon: "IconCalendarEvent",
  fields: [
    text("title", "Title", { required: true }),
    f("datetime", "starts_at", "Starts", { required: true }),
    f("datetime", "ends_at", "Ends"),
    f("boolean", "all_day", "All day"),
    text("time_zone", "Time zone"),
    text("place", "Place"),
    f("emails", "people", "People (email addresses)"),
    f("link", "record", "Belongs to"),
    choice("source", "Came from", EVENT_SOURCES),
    text("calendar", "Outside calendar (route)"),
    text("external_id", "Outside id"),
    f("rich_text", "notes", "Notes"),
    f("url", "url", "Link (the event on its calendar)"),
    text("rrule", "Repeats (an RRULE, such as FREQ=WEEKLY;BYDAY=MO)"),
  ],
};

/**
 * One person, once (team/0.3/DESIGN-contacts-comms.md). A contact never changes type: what a person is to the Space (prospect, client, ambassador) is a role,
 * a record type marked `role` that links here. `email` and `phone` are the person's main address and number, each unique in the Space, which is what stops a
 * second record for the same person and how a message finds its contact; any others go in `other_emails` and `other_phones` (not unique: a list cannot be).
 * Addresses are written lower case and numbers in E.164 by whatever writes them.
 */
export const CONTACT = {
  name: "contact", label: "Contact", icon: "IconUser",
  fields: [
    text("name", "Name", { required: true }),
    text("email", "Email", { unique: true }),
    text("phone", "Phone", { unique: true }),
    f("emails", "other_emails", "Other emails"),
    f("phones", "other_phones", "Other phones"),
    text("job_title", "Job title"),
    // IANA, e.g. America/Los_Angeles: what their local time is (the assistant's brief and the contact card read it)
    text("time_zone", "Time zone", { format: "time_zone" }),
    f("link", "organization", "Organization", { to: "organization" }),
    f("address", "address", "Address"),
    f("rich_text", "notes", "Notes"),
  ],
};

/** A firm or company, once. `domain` is unique so a message from anyone at that domain can be tied to it. */
export const ORGANIZATION = {
  name: "organization", label: "Organization", icon: "IconBuilding",
  fields: [
    text("name", "Name", { required: true }),
    text("domain", "Domain", { unique: true }),
    f("url", "website", "Website"),
    text("phone", "Phone"),
    f("address", "address", "Address"),
    f("rich_text", "notes", "Notes"),
  ],
};

export const POINT_KINDS = ["email", "phone"];

/**
 * One address or number a contact is reached at, one record each. `address` is unique in the Space (lower case email, E.164 phone), so an address held as a
 * second or third way to reach someone is as unique as the main one and a message finds its contact by one lookup. The contact's main `email` and `phone` stay
 * on the contact; `addContactPoint` in records/comms/log.js refuses an address that is another contact's main one. Merging relinks the points like any link.
 */
export const CONTACT_POINT = {
  name: "contact_point", label: "Contact point", icon: "IconAt",
  fields: [
    f("link", "contact", "Contact", { to: "contact", required: true }),
    choice("kind", "Kind", POINT_KINDS, { required: true }),
    text("address", "Address or number", { required: true, unique: true }),
    text("label", "Label"),
  ],
};

export const COMMUNICATION_KINDS = ["email", "meeting", "call", "text", "letter", "chat"];
export const PARTICIPANT_AS = ["from", "to", "cc", "bcc", "attendee", "organizer", "caller", "callee"];

/**
 * Everything said to or by someone: an email, a meeting, a call, a text, a letter, a chat. `source_key` is the connector and its own id for the item
 * ("gmail:18f3a..."), unique, so logging the same message twice makes one record. `mailbox` says whose inbox or calendar it came through (who may see it
 * follows that). `body` is kept only where the Space chose to keep full text; `excerpt` and `original_url` (back to the original) are the default. Who was on it:
 * the `participant` records. What it concerns: `record`.
 */
export const COMMUNICATION = {
  name: "communication", label: "Communication", icon: "IconMessage",
  fields: [
    choice("kind", "Kind", COMMUNICATION_KINDS, { required: true }),
    choice("direction", "Direction", ["inbound", "outbound", "internal"]),
    f("datetime", "at", "When", { required: true }),
    text("subject", "Subject"),
    text("excerpt", "Excerpt"),
    f("rich_text", "body", "Full text"),
    f("url", "original_url", "Link to the original"),
    text("thread", "Thread"),
    text("source_key", "Connector and its id", { unique: true }),
    text("mailbox", "Mailbox or calendar"),
    f("link", "record", "Concerns"),
  ],
};

/** One person on one communication, and how they were on it. Many contacts per communication and many communications per contact. `address` is what the message said (the email or number), kept when no contact matched. */
export const PARTICIPANT = {
  name: "participant", label: "Participant", icon: "IconUsers",
  fields: [
    f("link", "communication", "Communication", { to: "communication", required: true }),
    f("link", "contact", "Contact", { to: "contact" }),
    text("address", "Address as written"),
    choice("how", "How", PARTICIPANT_AS, { required: true }),
  ],
};


export const TASK_STATUS = ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"];
export const TASK_SOURCES = ["gate_hold", "grant_request", "pairing", "kit_install", "reveal_request", "continue_in_space", "flow_step", "assistant_request", "memory_proposal", "manual"];

/**
 * A task: a to-do, a step a person or an agent does, a thing waiting on a check. The record id is the task id. `status` is owned by the kernel (`owned_by: "kernel"`: written only
 * by the tasks service, which keeps it in step with the task's state); `stage` is the Space's own pipeline, separate from status, so a Kit or a person can add stages without touching it.
 * `tags` is one text (a JSON list for now). `stage`, `status` and `record` are written only by the kernel (`owned_by`). The default views are a board by status, a list and a calendar by due; like any type it takes custom fields, stages and views.
 */
export const TASK = {
  name: "task", label: "Task", icon: "IconChecklist",
  fields: [
    text("title", "Title", { required: true }),
    f("rich_text", "note", "Note"),
    f("datetime", "due", "Due"),
    choice("status", "Status", TASK_STATUS, { required: true, owned_by: "kernel" }),
    { name: "stage", kind: "text", label: "Stage", owned_by: "kernel" },
    f("link", "parent", "Part of", { to: "task" }),
    f("link", "project", "Project", { to: "project" }),
    f("link", "record", "About", { owned_by: "kernel" }),
    f("link", "contact", "Contact", { to: "contact" }),
    text("repeat", "Repeats"),
    f("datetime", "repeat_until", "Repeats until"),
    f("number", "priority", "Priority"),
    text("list", "List"),
    text("tags", "Tags"),
    // the planner's own bookkeeping, hidden from every role (the contract's own hiding); only the kernel service reads it
    text("planner", "Planner (engine bookkeeping)", { hidden_from: ["owner", "admin", "manager", "member", "temp"] }),
    f("boolean", "pinned", "Pinned"),
    text("tz", "Time zone"),
    f("boolean", "floating", "Same wall time in every zone"),
    text("wall", "Wall time"),
    f("date", "date", "Date"),
    choice("source", "Source", TASK_SOURCES),
  ],
  views: [
    { name: "tasks_board", type: "board", label: "Tasks by status", groupBy: "status", columns: ["title", "due", "priority"] },
    { name: "tasks_list", type: "list", label: "All tasks", columns: ["title", "status", "due", "project"], sort: { field: "due", dir: "asc" } },
    { name: "tasks_calendar", type: "calendar", label: "Due dates", dateField: "due" },
  ],
};

/**
 * A Project: the one hub for a piece of work (team/0.3/DESIGN-project-hub.md). Its sessions, Drive folder, repo, memory room, people, artifacts and accounts hang off this record. `slug` is the stable
 * key every text column that names a project holds; `drive_path` and `memory_scope` are addresses the kernel writes at create; `repo` is a git remote (a local path lives with the computer, not here).
 */
export const PROJECT = {
  name: "project", label: "Project", icon: "IconFolder", kind: "project",
  fields: [
    text("name", "Name", { required: true }),
    // not required: a record made by a Kit or an import has none until `work.project.create` or the hub fills it
    text("slug", "Short name used in addresses", { unique: true }),
    choice("status", "Status", ["active", "archived"]),
    f("link", "client", "Client", { to: "contact" }),
    text("drive_path", "Drive folder"),
    text("repo", "Repository"),
    text("memory_scope", "Memory scope"),
    f("datetime", "archived_at", "Archived"),
  ],
};

/** One session's summary, kept with its Project (DESIGN-project-hub.md). Never transcript text: the transcript and checkpoints stay sealed in the kernel, `transcript` points at them. */
export const SESSION_SUMMARY = {
  name: "session-summary", label: "Session", icon: "IconMessage",
  fields: [
    text("title", "Title"),
    f("link", "project", "Project", { to: "project" }),
    text("people", "People"),
    text("agents", "Agents"),
    text("provider", "Provider"),
    text("model", "Model"),
    text("account", "Account"),
    f("datetime", "started", "Started"),
    f("datetime", "ended", "Ended"),
    choice("status", "Status", ["working", "done", "stopped", "failed"]),
    f("rich_text", "summary", "Summary"),
    text("thread", "Session id", { unique: true }),
    text("transcript", "Transcript (kernel address)"),
    text("transcript_file", "Transcript file on its machine"),
    text("machine", "Machine the transcript file is on"),
    text("drive", "Drive folder"),
  ],
};

export const CORE_TYPES = Object.freeze([CONTACT, CONTACT_POINT, ORGANIZATION, COMMUNICATION, PARTICIPANT, EVENT, TEMPLATE, PLAYBOOK, TEAM_MEMBER, PROJECT, SESSION_SUMMARY, TASK].map((t) => Object.freeze(t)));
