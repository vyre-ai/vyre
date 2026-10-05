// The base Kit: the objects every firm starts from. One Contact per person; what a person is to the firm (a Lead, a Client, a Subscriber) is a role type
// linked to that Contact, so a person who was a Lead and became a Client is still one record with two roles. Appointments and Projects link to the same Contact.
// The Project is the core Project (one project type for the whole Space); this Kit adds practice area, the per-area stages and the fields that apply to one area.
// Practice area is a choice field. A Project follows its own stages by practice area (a personal injury case and an estate plan are not the same journey),
// and a field that only applies to one area shows, and is required, only there.
//
// Nothing here is a person's data. Add a practice area by adding an option; add a whole process by adding a stage set.
import { defineKit, defineType, defineField, defineStage, defineView } from "@vyre/sdk";

export const Contact = defineType({
  name: "contact",
  label: "Contact",
  icon: "IconUser",
  // The core Contact (name, email, phone, address, organization, notes) is in every Space; this is the one field the base Kit adds to it.
  fields: {
    source: defineField.choice(["Website", "Referral", "Ad", "Event", "Phone", "Other"], { label: "How they found us" }),
  },
});

export const Lead = defineType({
  name: "lead",
  label: "Lead",
  icon: "IconUserPlus",
  role: { link: "contact", ended: ["Converted", "Lost"] },
  fields: {
    contact: defineField.link({ to: "contact", label: "Contact", required: true }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    source: defineField.choice(["Website", "Referral", "Ad", "Event", "Phone", "Other"], { label: "Source" }),
    summary: defineField.rich_text({ label: "What they need" }),
    lost_reason: defineField.text({ label: "Why we lost them", visible_if: 'stage == "Lost"', required_if: 'stage == "Lost"' }),
    stage: defineStage(["New", "Contacted", "Consult booked", "Qualified", "Converted", "Lost"]),
  },
});

export const Appointment = defineType({
  name: "appointment",
  label: "Appointment",
  icon: "IconCalendarEvent",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    contact: defineField.link({ to: "contact", label: "Contact", required: true }),
    kind: defineField.choice(["Consultation", "Follow-up", "Signing", "Other"], { label: "Kind" }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    starts: defineField.datetime({ label: "Starts", required: true }),
    ends: defineField.datetime({ label: "Ends" }),
    where: defineField.text({ label: "Where or link" }),
    outcome: defineField.text({ label: "Outcome", visible_if: 'stage == "Completed" or stage == "No show"' }),
    stage: defineStage(["Scheduled", "Completed", "No show", "Cancelled"], { label: "Status" }),
  },
});

export const Client = defineType({
  name: "client",
  label: "Client",
  icon: "IconUserCheck",
  role: { link: "contact", ended: ["Closed"] },
  fields: {
    contact: defineField.link({ to: "contact", label: "Contact", required: true }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    since: defineField.date({ label: "Client since" }),
    stage: defineStage(["Onboarding", "Active", "Closed"]),
  },
});

export const Subscriber = defineType({
  name: "subscriber",
  label: "Subscriber",
  icon: "IconMailOpened",
  role: { link: "contact", ended: ["Unsubscribed"] },
  fields: {
    contact: defineField.link({ to: "contact", label: "Contact", required: true }),
    list: defineField.choice(["Newsletter", "Updates", "Events"], { label: "List" }),
    source: defineField.text({ label: "Where they signed up" }),
    stage: defineStage(["Subscribed", "Unsubscribed"]),
  },
});

export const Project = defineType({
  name: "project",
  label: "Project",
  icon: "IconBriefcase",
  kind: "project",
  fields: {
    // `name` and `client` are the core Project's own (records/core-types.js, DESIGN-project-hub.md); they are written here so the Kit reads whole, and the core ones win.
    name: defineField.text({ label: "Name", required: true }),
    client: defineField.link({ to: "contact", label: "Client", required: true }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    owner: defineField.actor({ label: "Owner" }),
    due: defineField.date({ label: "Due" }),
    accident_date: defineField.date({ label: "Accident date", visible_if: 'practice_area == "Personal Injury"', required_if: 'practice_area == "Personal Injury"' }),
    trust_name: defineField.text({ label: "Trust or plan name", visible_if: 'practice_area == "Estate Planning"' }),
    hearing_date: defineField.date({ label: "Next hearing", visible_if: 'practice_area == "Family Law" or practice_area == "Criminal Defense"' }),
    stage: defineStage(["Intake", "Active", "Review", "Done"], {
      sets: [
        { name: "personal_injury", when: 'practice_area == "Personal Injury"', stages: ["Intake", "Treating", "Demand", { name: "Negotiation", enter_if: "not empty(accident_date)" }, "Settled", "Closed"] },
        { name: "estate_planning", when: 'practice_area == "Estate Planning"', stages: ["Intake", "Drafting", "Review", { name: "Signing", enter_if: "not empty(trust_name)" }, "Funding", "Closed"] },
      ],
    }),
  },
});

export const LeadsBoard = defineView({ name: "leads_board", type: "board", of: "lead", label: "Leads by stage", groupBy: "stage", columns: ["contact", "practice_area", "source"] });
export const AppointmentsCalendar = defineView({ name: "appointments_calendar", type: "calendar", of: "appointment", label: "Appointments", dateField: "starts", filter: 'stage != "Cancelled"' });
export const ClientsList = defineView({ name: "clients_list", type: "list", of: "client", label: "Clients", columns: ["contact", "practice_area", "stage", "since"], sort: { field: "since", dir: "desc" } });
export const ProjectsBoard = defineView({ name: "projects_board", type: "board", of: "project", label: "Projects by stage", groupBy: "stage", columns: ["name", "client", "practice_area", "owner", "due"] });

export default defineKit({
  id: "base",
  version: 1,
  label: "Base",
  description: "The objects every firm starts from: Contact, Lead, Appointment, Client, Subscriber and Project. One Contact per person, with Lead, Client and Subscriber as roles linked to it, practice area as a choice, and projects that follow their own stages by practice area.",
  includes: [Contact, Lead, Appointment, Client, Subscriber, Project, LeadsBoard, AppointmentsCalendar, ClientsList, ProjectsBoard],
});
