// @ts-check
// The record types every Space has before any Kit is installed: tasks, templates, playbooks and team members
// (team/0.3/DESIGN-tasks.md and DESIGN-native-assistant.md). They are plain kernel TypeDefinitions, stored in the
// Space's Twenty like any other type, so a Kit can link to them and a view can list them.
//
// What the kernel owns stays the kernel's: the fields that carry approval truth on a task (state after needs_check,
// outcome, payload, checker, doer) are written by kernel/tasks only. A Kit or a person editing the record in Twenty
// cannot make a task approved: the gateway verifies the version hash and flags a row changed outside (invariant 10).

const text = (/** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind: "text", label, ...more });
const choice = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string[]} */ options, /** @type {object} */ more = {}) => ({ name, kind: "choice", label, options, ...more });
const f = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind, label, ...more });

export const TASK_STATES = ["waiting", "ready", "working", "needs_check", "stuck", "done", "skipped"];
export const TASK_OUTPUT_KINDS = ["fields", "note", "draft", "sent", "decision", "file"];
export const TASK_HOWS = ["template", "tailor", "assistant", "person"];
export const TEMPLATE_KINDS = ["email", "letter", "document", "message"];

/** A task: one doer, an optional checker, a declared output. The record the Now view and the stage board read. */
export const TASK = {
  name: "task", label: "Task", icon: "IconChecklist",
  fields: [
    text("title", "Title", { required: true }),
    f("link", "record", "Belongs to"),
    text("stage", "Stage"),
    f("actor", "doer", "Doer", { required: true }),
    f("actor", "checker", "Checker"),
    f("urls", "helpers", "Helpers (actors, shown not responsible)"),
    choice("output_kind", "Output", TASK_OUTPUT_KINDS, { required: true }),
    text("output_target", "Output target"),
    choice("how", "How", TASK_HOWS),
    f("link", "template", "Template", { to: "template" }),
    f("urls", "inputs", "Inputs"),
    f("urls", "depends_on", "Depends on"),
    f("datetime", "due", "Due"),
    choice("state", "State", TASK_STATES, { required: true }),
    text("stuck_reason", "Stuck: reason"),
    text("stuck_fix", "Stuck: suggested fix"),
    f("datetime", "stuck_since", "Stuck since"),
    f("rich_text", "note", "Note from the doer"),
    text("session", "Working session"),
    choice("outcome", "Outcome", ["approved", "rejected", "answered", "cancelled", "expired"]),
    f("actor", "assigned_by", "Assigned by"),
  ],
};

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
    f("link", "project", "Project"),
    f("rich_text", "instructions", "Role instructions (assistants)"),
    text("doing", "Doing right now"),
    f("datetime", "doing_since", "Doing since"),
  ],
};

export const CORE_TYPES = Object.freeze([TASK, TEMPLATE, PLAYBOOK, TEAM_MEMBER].map((t) => Object.freeze(t)));
