// kernel/tasks/type.js: the `task` record type (DESIGN-tasks-records). A Task is a record of the Space's store, the source of truth for everything a person reads or edits; the kernel keeps only what
// decides who may act (the doer, the checks, the approvals and holds, the state) keyed by the same id. `status` mirrors the kernel's state and is owned by the kernel: `records.update` refuses it, and a card
// move is `tasks.move`. A person or a Kit adds custom fields to this type like any other.
export const TASK_STATUSES = Object.freeze(["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"]);

/** The fields a task's own calls set (and `records.update` routes through `tasks.edit`); every other field of the type is the person's, custom, and plain. */
export const TASK_PERSON_FIELDS = Object.freeze(["title", "note", "due", "parent", "project"]);

export const TASK_TYPE = Object.freeze({
  name: "task", label: "Task", icon: "IconChecklist",
  fields: Object.freeze([
    { name: "title", kind: "text", label: "Title", required: true },
    { name: "note", kind: "rich_text", label: "Note" },
    { name: "due", kind: "datetime", label: "Due" },
    { name: "status", kind: "choice", label: "Status", options: [...TASK_STATUSES], required: true, owned_by: "kernel" },
    { name: "stage", kind: "text", label: "Stage", owned_by: "kernel" },
    { name: "record", kind: "text", label: "Concerns (a record)", owned_by: "kernel" },
    { name: "parent", kind: "text", label: "Parent task (id)" },
    { name: "project", kind: "text", label: "Project (a Project record)" },
    { name: "contact", kind: "text", label: "Contact (a Contact record)" },
    { name: "repeat", kind: "text", label: "Repeat rule (RRULE)" },
    { name: "priority", kind: "number", label: "Priority (0 to 3)" },
    { name: "list", kind: "text", label: "List" },
    { name: "tags", kind: "text", label: "Tags (a JSON list)" },
    { name: "pinned", kind: "boolean", label: "Pinned" },
  ]),
});
