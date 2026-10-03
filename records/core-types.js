// @ts-check
// The business record types every Space has before any Kit is installed: events, templates, playbooks, team members and the people types (contact, organization, contact-point, communication)
// (team/0.3/DESIGN-tasks.md and DESIGN-native-assistant.md). They are plain kernel TypeDefinitions, stored in the
// Space's Twenty like any other type, so a Kit can link to them and a view can list them.
//
// Tasks are not here: tasks, goals, Flows, runs, grants and the log live in the kernel store (one `task.created`, the kernel's), and Twenty holds business records.

import { CONTACT_TYPES } from "./contacts/types.js";

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
  ],
};

export const CORE_TYPES = Object.freeze([EVENT, TEMPLATE, PLAYBOOK, TEAM_MEMBER, ...CONTACT_TYPES].map((t) => Object.freeze(t)));
