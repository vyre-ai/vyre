// @ts-check
// The business record types every Space has before any Kit is installed: templates, playbooks and team members
// (team/0.3/DESIGN-tasks.md and DESIGN-native-assistant.md). They are plain kernel TypeDefinitions, stored in the
// Space's Twenty like any other type, so a Kit can link to them and a view can list them.
//
// Tasks are not here: tasks, goals, Flows, runs, grants and the log live in the kernel store (one `task.created`, the kernel's), and Twenty holds business records.

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
    f("link", "project", "Project"),
    f("rich_text", "instructions", "Role instructions (assistants)"),
    text("doing", "Doing right now"),
    f("datetime", "doing_since", "Doing since"),
  ],
};

export const CORE_TYPES = Object.freeze([TEMPLATE, PLAYBOOK, TEAM_MEMBER].map((t) => Object.freeze(t)));
