// @ts-check
// The planner's record types. A Reminder is an alarm, a timer, a reminder or a /later task (an instruction that runs at a time); a Note is a note. Both are plain
// record types of the Space, so the app lists them like any other (/u/records/reminder, /u/records/note) and a Kit can link to them. The firing of a ring is the

// the Space's Event records, so neither has a type here.
//
// Times a person reads (`at`, `snooze_until`, `done_at`, `removed_at`) are datetimes. The engine's own moments (`next_fire`, `created`, `updated`) are numbers in ms.

const text = (/** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind: "text", label, ...more });
/** The engine's own bookkeeping: a field no role sees or writes (`hidden_from`, the contract's one way to hide a field from people), so a record page, table or form lists only what a person sets. The planner's own chain has no role and reads and writes it. */
const ALL_ROLES = ["owner", "admin", "manager", "member", "temp"];
const hide = (/** @type {any} */ f) => ({ ...f, hidden_from: ALL_ROLES });
const num = (/** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind: "number", label, ...more });
const bool = (/** @type {string} */ name, /** @type {string} */ label) => ({ name, kind: "boolean", label });
const when = (/** @type {string} */ name, /** @type {string} */ label) => ({ name, kind: "datetime", label });

export const REMINDER_KINDS = ["alarm", "timer", "reminder", "task"];
export const ITEM_STATES = ["open", "done", "cancelled"];

/** What a Reminder and a Note share: how a person files and finds them. */
const FILING = [text("list", "List"), num("priority", "Priority (0 to 3)"), bool("pinned", "Pinned"), text("tags", "Tags (a JSON list)"), text("project", "Project"), text("thread", "Thread")];
/** Who added it, as the planner keeps it: `source` is the caller, `added_by` an agent's name (empty for the person and their assistant). */
const MADE = [hide(text("source", "Added by (caller)")), hide(text("added_by", "Added by (agent)")), hide(num("created", "Created (ms)")), hide(num("updated", "Updated (ms)")), when("removed_at", "Deleted"), when("done_at", "Done")];

/** An alarm, a timer, a reminder, or a /later task that runs an instruction at a time. */
export const REMINDER = {
  name: "reminder", label: "Reminder", icon: "IconBell",
  // The views a client offers for this type before anyone makes one: the same shape as defineView (records/language/sdk.js). A calendar needs the date field it is laid out by.
  views: [{ name: "reminders_calendar", type: "calendar", of: "reminder", label: "Calendar", dateField: "at" }, { name: "reminders_list", type: "list", of: "reminder", label: "List", sort: [{ field: "at", dir: "asc" }] }],
  fields: [
    text("title", "Title", { required: true }),
    { name: "kind", kind: "choice", label: "Kind", options: REMINDER_KINDS, required: true },
    { name: "state", kind: "choice", label: "State", options: ITEM_STATES, required: true },
    when("at", "Rings at"),
    text("tz", "Time zone"), hide(bool("floating", "Follows the planner's zone")), hide(text("wall", "Time of day (HH:MM)")), hide(text("date", "Date (YYYY-MM-DD)")),
    text("repeat", "Repeat rule (JSON)"), num("duration_ms", "Timer length (ms)"),
    when("snooze_until", "Snoozed until"), hide(num("next_fire", "Next ring (ms, the planner's own)")),
    { name: "body", kind: "rich_text", label: "Notes or the instruction a task runs" },
    ...FILING, ...MADE,
    text("waits_on", "Runs when this item is done"), hide(num("run_count", "Times run")), hide(text("last_result", "Last result")), bool("paused", "Paused"), hide(num("waits_on_fired", "Last completion it ran for")),
  ],
};

export const NOTE = {
  name: "note", label: "Note", icon: "IconNote",
  fields: [
    text("title", "Title", { required: true }),
    { name: "state", kind: "choice", label: "State", options: ITEM_STATES, required: true },
    { name: "body", kind: "rich_text", label: "Note" },
    ...FILING, ...MADE,
  ],
};

/** One ring of an item or an event: when it was due, how often it rang, how it was answered. */
export const FIRING = {
  name: "planner_firing", label: "Ring", icon: "IconBellRinging",
  fields: [
    text("fid", "Ring id", { required: true, unique: true }), text("item", "Item", { required: true }), text("kind", "Kind", { required: true }),
    num("due", "Due (ms)", { required: true }), num("ring", "Ring number"), bool("missed", "Missed"), text("state", "State", { required: true }),
    num("fired_at", "Fired (ms)"), num("next_ring", "Next ring (ms)"), num("acked_at", "Answered (ms)"), text("action", "Answer"), text("by", "Answered by"), num("until", "Snoozed until (ms)"),
  ],
};

/** The planner's settings: one record per key, the value as JSON. */
export const STATE = {
  name: "planner_state", label: "Planner setting", icon: "IconSettings",
  fields: [text("key", "Key", { required: true, unique: true }), text("value", "Value (JSON)", { required: true })],
};

export const PLANNER_TYPES = Object.freeze([REMINDER, NOTE, FIRING, STATE].map(t => Object.freeze(t)));
