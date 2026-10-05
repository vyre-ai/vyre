// @ts-check
// The default "Log communications" Flow (team/0.3/DESIGN-contacts-comms.md, idea 3; platform gaps item 6). One per connected mailbox or calendar. It starts on the watcher the connector's poll
// made (core/watchers/connector-preset.js) and files what the watcher found as Communication records attached to contacts by address, with native Flow steps and nothing else, so a space can
// open it on the canvas and change it: log only some mailboxes, skip internal mail, make a contact for a stranger or not.
//
//   upsert   one Communication per item, keyed on its source_key (the connector and the item's own id), so seeing the same thing twice files it once and a changed meeting updates it
//   repeat   for each person on it: find the contact by main email, else by a further address (a contact point), and file one Participant linking them, or keeping the bare address when
//            nobody matches (or, when the switch is on, making the contact first); a matched or made contact is also added to the Communication's own `contacts` link (many to many, with
//            "Communications" on the Contact), so a contact's page lists every email and meeting without reading Participants
//
// It reads and writes records and calls no outside service: logging never sends. The item is from outside, so the run is tainted, which only matters for steps that send, and there are none.

import { WATCHER_NAME_RE } from "../../kernel/flows/triggers.js";

/**
 * @param {{ watcher: string, label?: string, createUnknown?: boolean, skipInternal?: string }} o
 *   `createUnknown`: make a contact for an address nobody has (off to start).
 *   `skipInternal`: a domain; a person whose address ends with it is not filed as a participant (mail to colleagues).
 * @returns {any} a Flow in its stored form (kernel/flows/schema.js)
 */
export function logCommunicationsFlow(o) {
  if (!WATCHER_NAME_RE.test(o.watcher)) throw new Error("name the watcher the connector's poll made");
  const slug = o.watcher.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  // the Communication also links straight to each Contact on it (many to many, "Communications" on the Contact), beside the Participant that keeps how they were on it
  const link = (/** @type {string} */ id, /** @type {string} */ contact) => ({ id, kind: "update", type: "communication", record: { expr: "steps.comm.record" }, set: { contacts: { add: [{ urn: { expr: contact } }] } } });
  const noContact = { id: "p_bare", kind: "upsert", type: "participant", match: { communication: { urn: { expr: "steps.comm.record.urn" } }, address: { expr: "person.address" }, how: { expr: "person.how" } }, set: {} };
  const unknown = [
    { id: "p_new", kind: "create", type: "contact", set: { name: { expr: "person.address" }, email: { expr: "person.address" } } },
    { id: "p_made", kind: "upsert", type: "participant", match: { communication: { urn: { expr: "steps.comm.record.urn" } }, address: { expr: "person.address" }, how: { expr: "person.how" } }, set: { contact: { urn: { expr: "steps.p_new.record.urn" } } } }, link("l_made", "steps.p_new.record.urn"),
  ];
  const perPerson = [
    { id: "by_email", kind: "pick", type: "contact", where: "record.email == person.address" },
    { id: "by_point", kind: "pick", type: "contact_point", where: "record.address == person.address" },
    { id: "match", kind: "decide", if: "steps.by_email.found",
      then: [{ id: "p_main", kind: "upsert", type: "participant", match: { communication: { urn: { expr: "steps.comm.record.urn" } }, address: { expr: "person.address" }, how: { expr: "person.how" } }, set: { contact: { urn: { expr: "steps.by_email.record.urn" } } } }, link("l_main", "steps.by_email.record.urn")],
      else: [{ id: "point", kind: "decide", if: "steps.by_point.found",
        then: [{ id: "p_point", kind: "upsert", type: "participant", match: { communication: { urn: { expr: "steps.comm.record.urn" } }, address: { expr: "person.address" }, how: { expr: "person.how" } }, set: { contact: { urn: { expr: "steps.by_point.record.data.contact.urn" } } } }, link("l_point", "steps.by_point.record.data.contact.urn")],
        else: o.createUnknown ? unknown : [noContact] }] },
  ];
  const people = o.skipInternal
    ? [{ id: "ext", kind: "decide", if: `not endsWith(person.address, ${JSON.stringify("@" + o.skipInternal.replace(/^@/, ""))})`, then: perPerson }]
    : perPerson;
  return {
    format: 1, name: `log_comms_${slug}`.slice(0, 63), label: o.label ?? "Log communications",
    description: "Files each new message or meeting the watcher finds as a Communication on the contacts it names, matched by address. Reads and writes records only; it never sends.",
    authorship: "kit",
    trigger: { on: "watcher", watcher: o.watcher },
    steps: [
      { id: "comm", kind: "upsert", type: "communication", match: { source_key: { expr: "trigger.item.source_key" } },
        set: { kind: { expr: "trigger.item.comm_kind" }, at: { expr: "trigger.item.occurred" }, direction: { expr: "trigger.item.direction" }, subject: { expr: "trigger.item.subject" }, excerpt: { expr: "trigger.item.excerpt" },
          thread: { expr: "trigger.item.thread" }, original_url: { expr: "trigger.item.original_url" }, mailbox: { expr: "trigger.item.mailbox" } } },
      { id: "each", kind: "repeat", over: "trigger.item.people", as: "person", max: 200, steps: people },
    ],
  };
}
