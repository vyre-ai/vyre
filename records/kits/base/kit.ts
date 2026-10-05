// The base Kit: the objects any business starts from. One Contact per person; what a person is to the business (a Lead, a Client, a Subscriber) is a role type
// linked to that Contact, so a person who was a Lead and became a Client is still one record with two roles. Appointments and Projects link to the same Contact.
// The Project is the core Project (one project type for the whole Space); this Kit adds an owner, a due date and stages on top of it.
//
// Nothing here is for one trade: a Kit for a trade adds its own fields and its own stages (stage sets that change by a field) on top of these.
// Nothing here is a person's data.
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
    source: defineField.choice(["Website", "Referral", "Ad", "Event", "Phone", "Other"], { label: "Source" }),
    summary: defineField.rich_text({ label: "What they need" }),
    lost_reason: defineField.text({ label: "Why we lost them", visible_if: 'stage == "Lost"', required_if: 'stage == "Lost"' }),
    stage: defineStage(["New", "Contacted", "Meeting booked", "Qualified", "Converted", "Lost"]),
  },
});

export const Appointment = defineType({
  name: "appointment",
  label: "Appointment",
  icon: "IconCalendarEvent",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    contact: defineField.link({ to: "contact", label: "Contact", required: true }),
    kind: defineField.choice(["Meeting", "Follow-up", "Call", "Other"], { label: "Kind" }),
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
    owner: defineField.actor({ label: "Owner" }),
    due: defineField.date({ label: "Due" }),
    stage: defineStage(["New", "Active", "Review", "Done"]),
  },
});

export const LeadsBoard = defineView({ name: "leads_board", type: "board", of: "lead", label: "Leads by stage", groupBy: "stage", columns: ["contact", "source"] });
export const AppointmentsCalendar = defineView({ name: "appointments_calendar", type: "calendar", of: "appointment", label: "Appointments", dateField: "starts", filter: 'stage != "Cancelled"' });
export const ClientsList = defineView({ name: "clients_list", type: "list", of: "client", label: "Clients", columns: ["contact", "stage", "since"], sort: { field: "since", dir: "desc" } });
export const ProjectsBoard = defineView({ name: "projects_board", type: "board", of: "project", label: "Projects by stage", groupBy: "stage", columns: ["name", "client", "owner", "due"] });

export default defineKit({
  id: "base",
  version: 1,
  label: "Base",
  description: "The objects any business starts from: Contact, Lead, Appointment, Client, Subscriber and Project. One Contact per person, with Lead, Client and Subscriber as roles linked to it, and a Project with stages.",
  includes: [Contact, Lead, Appointment, Client, Subscriber, Project, LeadsBoard, AppointmentsCalendar, ClientsList, ProjectsBoard],
});
