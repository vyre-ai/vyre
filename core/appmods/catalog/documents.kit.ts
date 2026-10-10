// The Kit the Documents app ships: a Document record for every document sent for signature, linked to the signer's Contact and (when known) the project, and a ready Flow that files the signed one.
// Compile with: node records/language/cli.js compile core/appmods/catalog/documents.kit.ts > core/appmods/catalog/documents.kit.json
import { defineKit, defineType, defineField, defineFlow, step, expr } from "@vyre/sdk";

export const Document = defineType({
  name: "document",
  label: "Document",
  icon: "IconFileText",
  fields: {
    name: defineField.text({ label: "Name", required: true }),
    status: defineField.choice(["Waiting", "Signed", "Declined"], { label: "Status" }),
    template: defineField.text({ label: "Template" }),
    signer_email: defineField.text({ label: "Signer's e-mail" }),
    signed_at: defineField.datetime({ label: "Signed" }),
    file: defineField.text({ label: "Signed copy in the Drive" }),
    submission: defineField.text({ label: "Submission" }),
    contact: defineField.link({ to: "contact", label: "Signer", inverse: { name: "documents", label: "Documents" } }),
    project: defineField.link({ to: "project", label: "Project", inverse: { name: "documents", label: "Documents" } }),
  },
});

// The core Contact, with the one field this Kit adds to it: when they last signed a document.
export const Contact = defineType({ name: "contact", label: "Contact", fields: { last_signed_at: defineField.datetime({ label: "Last signed a document" }) } });

export const WhenSigned = defineFlow({
  name: "document_signed",
  label: "File a signed document",
  description: "When a document is signed, find the signer's Contact by their e-mail, file a Document record linked to them (the signed copy is already in the Drive), and put it on their timeline.",
  trigger: { on: "event", event: "documents.signed" },
  steps: [
    step.pick("who", { type: "contact", where: "record.email == trigger.payload.email" }),
    step.decide("link", {
      if: "steps.who.found",
      then: [
        step.upsert("doc", { type: "document", match: { submission: expr("text(trigger.payload.submission)") }, set: { name: expr("trigger.payload.template"), status: "Signed", template: expr("trigger.payload.template"), signer_email: expr("trigger.payload.email"), file: expr("trigger.payload.files[0].path"), submission: expr("text(trigger.payload.submission)"), contact: { urn: expr("steps.who.record.urn") } } }),
        step.update("touch", { type: "contact", record: { urn: expr("steps.who.record.urn") }, set: { last_signed_at: expr("trigger.payload.at") } }),
      ],
      else: [
        step.upsert("doc_unlinked", { type: "document", match: { submission: expr("text(trigger.payload.submission)") }, set: { name: expr("trigger.payload.template"), status: "Signed", template: expr("trigger.payload.template"), signer_email: expr("trigger.payload.email"), file: expr("trigger.payload.files[0].path"), submission: expr("text(trigger.payload.submission)") } }),
      ],
    }),
  ],
});

// A signer who declines is a fact the firm needs on the signer's timeline at once, not after the wait for the signature runs out.
export const WhenDeclined = defineFlow({
  name: "document_declined",
  label: "File a declined document",
  description: "When a signer declines, file the Document as Declined, linked to the signer's Contact by their e-mail, so the refusal shows on their timeline.",
  trigger: { on: "event", event: "documents.declined" },
  steps: [
    step.pick("who", { type: "contact", where: "record.email == trigger.payload.email" }),
    step.decide("link", {
      if: "steps.who.found",
      then: [
        step.upsert("doc", { type: "document", match: { submission: expr("text(trigger.payload.submission)") }, set: { name: expr("trigger.payload.template"), status: "Declined", template: expr("trigger.payload.template"), signer_email: expr("trigger.payload.email"), submission: expr("text(trigger.payload.submission)"), contact: { urn: expr("steps.who.record.urn") } } }),
      ],
      else: [
        step.upsert("doc_unlinked", { type: "document", match: { submission: expr("text(trigger.payload.submission)") }, set: { name: expr("trigger.payload.template"), status: "Declined", template: expr("trigger.payload.template"), signer_email: expr("trigger.payload.email"), submission: expr("text(trigger.payload.submission)") } }),
      ],
    }),
  ],
});

export default defineKit({
  id: "documents",
  version: 2,
  label: "Documents",
  description: "A Document record for each document sent for signature, linked to the signer's Contact and the project, and Flows that file the signed copy when it arrives and a refusal when a signer declines.",
  includes: [Contact, Document, WhenSigned, WhenDeclined],
});
