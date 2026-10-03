// @ts-check
// The people types every Space has (team/0.3/DESIGN-contacts-comms.md): a Contact is one person once, an Organization is one firm once, a contact-point is one
// way of reaching either (an address that is unique in the Space, which is what stops a second record for the same person), and a Communication is
// one thing said, with the child record that ties it to each contact on it. What a contact IS to the Space (prospect, client, ambassador) is a role:
// another type, marked `role`, that points at a contact (see roles.js).
//
// The first text field of a type is its title in Twenty, and a title column cannot carry a unique index, so the unique fields below never come first.

const f = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {string} */ label, /** @type {object} */ more = {}) => ({ name, kind, label, ...more });
const choice = (/** @type {string} */ name, /** @type {string} */ label, /** @type {string[]} */ options, /** @type {object} */ more = {}) => ({ name, kind: "choice", label, options, ...more });

export const POINT_KINDS = ["email", "phone"];
export const COMMUNICATION_KINDS = ["email", "meeting", "call", "text", "letter", "chat"];
export const DIRECTIONS = ["inbound", "outbound", "none"];
export const PARTICIPATION = ["from", "to", "cc", "bcc", "attendee", "organizer", "other"];

/** One person. Reached through their contact-points; a Kit adds its own fields to this type by naming a type "contact". */
export const CONTACT = {
  name: "contact", label: "Contact", icon: "IconUser",
  fields: [
    f("text", "full_name", "Full name", { required: true }),
    f("text", "job_title", "Job title"),
    f("link", "organization", "Organization", { to: "organization" }),
    f("rich_text", "notes", "Notes"),
  ],
};

/** One firm or company. */
export const ORGANIZATION = {
  name: "organization", label: "Organization", icon: "IconBuilding",
  fields: [
    f("text", "name", "Name", { required: true }),
    f("url", "website", "Website"),
    f("rich_text", "notes", "Notes"),
  ],
};

/** One way of reaching a contact or an organization. `value` is the normal form (lower-cased email, E.164 phone) and is unique in the Space. */
export const CONTACT_POINT = {
  name: "contact-point", label: "Contact point", icon: "IconAt",
  fields: [
    f("text", "label", "Label (work, mobile)"),
    choice("kind", "Kind", POINT_KINDS, { required: true }),
    f("text", "value", "Address", { required: true, unique: true, normal: "address" }),
    f("link", "owner", "Belongs to", { required: true, to: ["contact", "organization"] }),
    f("boolean", "is_primary", "Primary"),
    f("boolean", "is_verified", "Verified"),
    f("datetime", "verified_at", "Verified at"),
  ],
};

/** One thing said: an email, a meeting, a call, a text, a letter, a chat. The excerpt and a link back are kept by default; `source_key` makes a re-delivery a no-op. */
export const COMMUNICATION = {
  name: "communication", label: "Communication", icon: "IconMessage",
  fields: [
    f("text", "subject", "Subject"),
    choice("kind", "Kind", COMMUNICATION_KINDS, { required: true }),
    choice("direction", "Direction", DIRECTIONS, { required: true }),
    f("datetime", "occurred_at", "When", { required: true }),
    f("text", "excerpt", "Excerpt"),
    f("url", "original", "Link to the original"),
    f("text", "source", "Came from (connector)"),
    f("text", "source_id", "Id at the source"),
    f("text", "source_key", "Source and id together", { unique: true }),
    f("text", "thread", "Thread"),
    f("link", "about", "About (the role or record it concerns)"),
  ],
};

/** Ties one Communication to one Contact on it (many to many). `key` is `<communication id>:<contact id>`, so attaching twice is a no-op. */
export const COMMUNICATION_PARTY = {
  name: "communication-party", label: "Communication party", icon: "IconUsers",
  fields: [
    f("text", "address", "Address it matched"),
    f("text", "key", "Communication and contact together", { required: true, unique: true }),
    f("link", "communication", "Communication", { required: true, to: "communication" }),
    f("link", "contact", "Contact", { required: true, to: "contact" }),
    choice("participation", "Took part as", PARTICIPATION),
    f("datetime", "occurred_at", "When (copied, so a contact's timeline sorts in one query)"),
  ],
};

export const CONTACT_TYPES = Object.freeze([ORGANIZATION, CONTACT, CONTACT_POINT, COMMUNICATION, COMMUNICATION_PARTY].map((t) => Object.freeze(t)));
