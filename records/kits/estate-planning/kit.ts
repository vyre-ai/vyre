// Estate planning matter. A firm that drafts wills and trusts keeps one Contact per person and
// one Matter per engagement. A matter moves through six stages; each stage is made of tasks that
// an assistant or a person does, and the matter advances when the required tasks are done.
//
// The sample people and firm in this file are made up. A Kit carries definitions, never data.
import { defineKit, defineType, defineField, defineStage, defineTask, defineRule, defineRole, defineTemplate, defineView, defineFlow, step, expr } from "@vyre/sdk";

export const Contact = defineType({
  name: "contact",
  label: "Contact",
  icon: "IconUser",
  // The core Contact (name, email, phone, address, organization, notes) is in every Space; these are the estate practice's own fields on it.
  fields: {
    date_of_birth: defineField.date({ label: "Date of birth" }),
    ssn: defineField.sealed({ class: "us-ssn", label: "Social Security number", description: "Never shown to a model. A model sees only that a valid one is on file." }),
    stripe_customer: defineField.text({ label: "Stripe customer" }),
  },
});

export const Matter = defineType({
  name: "matter",
  label: "Matter",
  icon: "IconBriefcase",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    client: defineField.link({ to: "contact", label: "Client" }),
    plan: defineField.choice(["Will", "Trust", "Both"], { label: "Plan" }),
    fee: defineField.money({ label: "Fee" }),
    engagement_signed: defineField.boolean({ label: "Engagement letter signed" }),
    practice_area: defineField.text({ label: "Practice area" }),
    household_size: defineField.number({ label: "Household size" }),
    decision_maker: defineField.text({ label: "Decision maker" }),
    stripe_payment: defineField.text({ label: "Stripe payment" }),
    stage: defineStage([
      {
        name: "Intake",
        tasks: [
          defineTask({
            title: "Research the client",
            doer: "teammate:research",
            how: "assistant",
            output: { kind: "fields", target: ["practice_area", "household_size", "decision_maker"] },
            dueOffset: "1d",
          }),
          defineTask({
            title: "Welcome email",
            doer: "teammate:intake",
            checker: "role:attorney",
            how: "tailor",
            template: "welcome",
            output: { kind: "sent", target: "email" },
            dependsOn: ["Research the client"],
            dueOffset: "1d",
          }),
        ],
      },
      {
        name: "Engagement",
        tasks: [
          defineTask({ title: "Engagement letter signed", doer: "role:attorney", output: { kind: "decision" }, dueOffset: "3d" }),
        ],
      },
      {
        name: "Drafting",
        tasks: [
          defineTask({ title: "Draft the documents", doer: "role:attorney", output: { kind: "file" }, dueOffset: "1w" }),
          defineTask({ title: "Client review call", doer: "role:attorney", output: { kind: "note" }, dependsOn: ["Draft the documents"], dueOffset: "2w" }),
        ],
      },
      {
        name: "Signing",
        tasks: [defineTask({ title: "Signing ceremony", doer: "role:attorney", output: { kind: "decision" }, dueOffset: "3w" })],
      },
      {
        name: "Funding",
        tasks: [defineTask({ title: "Fund the trust and retitle assets", doer: "role:attorney", output: { kind: "note" }, dueOffset: "5w", required: false })],
      },
      "Closed",
    ], { label: "Stage" }),
  },
  rules: [defineRule({ name: "signed_before_drafting", require: "stage < 'Drafting' or engagement_signed == true" })],
});

export const Welcome = defineTemplate({
  name: "welcome",
  kind: "email",
  subject: "Welcome to Harlow Legal",
  body: "Dear {{client.name}},\n\nThank you for choosing Harlow Legal for your estate plan. Your matter reference is {{matter.id}}.\n\nWe will start with a short call to learn about your household. Please have your Social Security number ready; we will ask for it on a secure form and never by email. Your number will be filled in here by our system: {{sealed:client.ssn}}.\n\nWarm regards,\nThe Harlow Legal team",
});

export const Research = defineRole({
  name: "research",
  kind: "teammate",
  label: "Research teammate",
  description: "Looks up public information about a new client and fills the matter's research fields.",
  instructions: "For a new matter, find public background on the client and their household. Fill practice_area, household_size and decision_maker only from sources you can name, and leave a note that cites each one. Never ask for or guess a Social Security number.",
  grants: [{ read: "matter" }, { read: "contact.name" }, { read: "contact.email" }, { write: "matter.practice_area" }, { write: "matter.household_size" }, { write: "matter.decision_maker" }, { create: "note" }],
});

export const Intake = defineRole({
  name: "intake",
  kind: "teammate",
  label: "Intake teammate",
  description: "Greets new clients, drafts the welcome email and keeps the contact record complete.",
  instructions: "Tailor the welcome template to what the research note says about the household, keep it short and warm, and send nothing until the attorney approves the draft.",
  grants: [{ read: "matter" }, { read: "contact" }, { write: "contact.phone" }, { write: "contact.address" }, { write: "matter.plan" }, { create: "note" }],
});

export const Attorney = defineRole({
  name: "attorney",
  kind: "role",
  label: "Attorney",
  description: "Reviews and approves work, signs off stages and handles the legal steps.",
  grants: [{ read: "matter" }, { write: "matter" }, { create: "matter" }, { read: "contact" }, { write: "contact" }, { create: "contact" }],
});

export const MattersBoard = defineView({ name: "matters_board", type: "board", of: "matter", label: "Matters by stage", groupBy: "stage", columns: ["title", "client", "plan", "fee"] });

export const OnPayment = defineFlow({
  name: "on_payment",
  label: "On payment",
  description: "A Stripe payment starts a matter: find or create the contact, find or create the matter, then it begins at Intake.",
  trigger: { on: "event", event: "payment.received" },
  steps: [
    step.upsert("client", { type: "contact", match: { stripe_customer: expr("trigger.customer") }, set: { name: expr("trigger.display"), email: expr("trigger.email") } }),
    step.upsert("matter", { type: "matter", match: { stripe_payment: expr("trigger.payment") }, set: { title: expr("\"Estate plan for \" + trigger.display"), client: { urn: expr("steps.client.record.urn") }, fee: expr("trigger.amount"), stage: "Intake" } }),
  ],
});

export default defineKit({
  id: "estate-planning",
  version: 1,
  label: "Estate planning matter",
  description: "Contacts with a sealed Social Security number, matters that move through six stages made of tasks, a welcome email, research and intake teammates, and a flow that starts a matter when a payment arrives.",
  includes: [Contact, Matter, Welcome, Research, Intake, Attorney, MattersBoard, OnPayment],
});
