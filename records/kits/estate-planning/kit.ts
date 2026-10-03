// Estate planning matter. A firm that drafts wills and trusts keeps one Contact per person and
// one Matter per engagement. A matter moves through six stages; each stage is made of tasks that
// an assistant or a person does, and the matter advances when the required tasks are done.
//
// The sample people and firm in this file are made up. A Kit carries definitions, never data.
import { defineKit, defineType, defineField, defineStage, defineTask, defineRule, defineRole, defineTemplate, defineView, defineFlow } from "@vyre/sdk";

export const Contact = defineType({
  name: "contact",
  label: "Contact",
  plural: "Contacts",
  icon: "IconUser",
  title: "full_name",
  fields: {
    full_name: defineField.text({ label: "Full name", required: true }),
    email: defineField.text({ label: "Email" }),
    phone: defineField.text({ label: "Phone" }),
    date_of_birth: defineField.date({ label: "Date of birth" }),
    address: defineField.address({ label: "Address" }),
    ssn: defineField.sealed({ class: "us-ssn", label: "Social Security number", description: "Never shown to a model. A model sees only that a valid one is on file." }),
    stripe_customer: defineField.text({ label: "Stripe customer", unique: true }),
  },
});

export const Matter = defineType({
  name: "matter",
  label: "Matter",
  plural: "Matters",
  icon: "IconBriefcase",
  title: "title",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    client: defineField.link({ to: "contact", label: "Client" }),
    plan: defineField.choice(["Will", "Trust", "Both"], { label: "Plan" }),
    fee: defineField.money({ label: "Fee", currency: "USD" }),
    engagement_signed: defineField.boolean({ label: "Engagement letter signed", default: false }),
    practice_area: defineField.text({ label: "Practice area" }),
    household_size: defineField.number({ label: "Household size", integer: true, min: 1 }),
    decision_maker: defineField.text({ label: "Decision maker" }),
    stripe_payment: defineField.text({ label: "Stripe payment", unique: true }),
    stage: defineStage([
      {
        name: "Intake",
        tasks: [
          defineTask({
            title: "Research the client",
            doer: "teammate:research",
            how: "assistant",
            output: { fields: ["practice_area", "household_size", "decision_maker"], note: true },
            dueOffset: "1d",
          }),
          defineTask({
            title: "Welcome email",
            doer: "teammate:intake",
            checker: "role:attorney",
            how: "tailor",
            template: "welcome",
            output: { sent: "email" },
            dependsOn: ["Research the client"],
            dueOffset: "1d",
          }),
        ],
      },
      {
        name: "Engagement",
        tasks: [
          defineTask({ title: "Engagement letter signed", doer: "role:attorney", output: { decision: true }, dueOffset: "3d" }),
        ],
      },
      {
        name: "Drafting",
        enter: "engagement_signed == true",
        tasks: [
          defineTask({ title: "Draft the documents", doer: "role:attorney", output: { file: true }, dueOffset: "1w" }),
          defineTask({ title: "Client review call", doer: "role:attorney", output: { note: true }, dependsOn: ["Draft the documents"], dueOffset: "2w" }),
        ],
      },
      {
        name: "Signing",
        tasks: [defineTask({ title: "Signing ceremony", doer: "role:attorney", output: { decision: true }, dueOffset: "3w" })],
      },
      {
        name: "Funding",
        tasks: [defineTask({ title: "Fund the trust and retitle assets", doer: "role:attorney", output: { note: true }, dueOffset: "5w", required: false })],
      },
      "Closed",
    ], { label: "Stage" }),
  },
  rules: [defineRule({ name: "signed_before_drafting", require: "stage < 'Drafting' or engagement_signed == true", message: "The engagement letter must be signed before drafting starts." })],
});

export const Welcome = defineTemplate({
  name: "welcome",
  kind: "email",
  subject: "Welcome to Harlow Legal",
  body: "Dear {{client.full_name}},\n\nThank you for choosing Harlow Legal for your estate plan. Your matter reference is {{matter.id}}.\n\nWe will start with a short call to learn about your household. Please have your Social Security number ready; we will ask for it on a secure form and never by email. Your number will be filled in here by our system: {{sealed:client.ssn}}.\n\nWarm regards,\nThe Harlow Legal team",
});

export const Research = defineRole({
  name: "research",
  kind: "teammate",
  label: "Research teammate",
  description: "Looks up public information about a new client and fills the matter's research fields.",
  instructions: "For a new matter, find public background on the client and their household. Fill practice_area, household_size and decision_maker only from sources you can name, and leave a note that cites each one. Never ask for or guess a Social Security number.",
  grants: [{ read: "matter" }, { read: "contact.full_name" }, { read: "contact.email" }, { write: "matter.practice_area" }, { write: "matter.household_size" }, { write: "matter.decision_maker" }, { create: "note" }],
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
  name: "On payment",
  description: "A Stripe payment starts a matter: find or create the contact, find or create the matter, then it begins at Intake.",
  on: { event: "payment.received" },
  steps: [
    { find: "contact", by: { stripe_customer: "{{event.customer}}" }, createIfMissing: true, set: { full_name: "{{event.name}}", email: "{{event.email}}", stripe_customer: "{{event.customer}}" }, as: "client" },
    { find: "matter", by: { stripe_payment: "{{event.payment}}" }, createIfMissing: true, set: { title: "Estate plan for {{client.full_name}}", client: "{{client.id}}", stripe_payment: "{{event.payment}}", fee: "{{event.amount}}", stage: "Intake" }, as: "matter" },
  ],
});

export default defineKit({
  id: "estate-planning",
  version: 1,
  label: "Estate planning matter",
  description: "Contacts with a sealed Social Security number, matters that move through six stages made of tasks, a welcome email, research and intake teammates, and a flow that starts a matter when a payment arrives.",
  includes: [Contact, Matter, Welcome, Research, Intake, Attorney, MattersBoard, OnPayment],
});
