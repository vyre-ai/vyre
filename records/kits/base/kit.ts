// The base Kit: the record types any business starts from. One Contact per person; what a person is to the business is a role type linked to that Contact, so a person who was a
// Lead and became a Client is still one record with two roles. Lead and Client are the Space's own roles (role-lead and role-client, records/core-types.js), so this Kit adds only
// Subscriber; a Space made before 0.6.4 had a second Lead and Client from here, which core/daemon/flows-host.js takes away when they hold no records. Appointments and Projects link to the same Contact.
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

export const Appointment = defineType({
  name: "appointment",
  label: "Appointment",
  icon: "IconCalendarEvent",
  fields: {
    title: defineField.text({ label: "Title", required: true }),
    contact: defineField.link({ to: "contact", label: "Contact", required: true, inverse: { name: "appointments", label: "Appointments" } }),
    kind: defineField.choice(["Meeting", "Follow-up", "Call", "Other"], { label: "Kind" }),
    starts: defineField.datetime({ label: "Starts", required: true }),
    ends: defineField.datetime({ label: "Ends" }),
    where: defineField.text({ label: "Where or link" }),
    outcome: defineField.text({ label: "Outcome", visible_if: 'stage == "Completed" or stage == "No show"' }),
    stage: defineStage(["Scheduled", "Completed", "No show", "Cancelled"], { label: "Status" }),
  },
});

export const Subscriber = defineType({
  name: "subscriber",
  label: "Subscriber",
  icon: "IconMailOpened",
  role: { link: "contact", ended: ["Unsubscribed"] },
  fields: {
    contact: defineField.link({ to: "contact", label: "Contact", required: true, inverse: { name: "subscriptions", label: "Subscriptions" } }),
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
    client: defineField.link({ to: "contact", label: "Client", required: true, inverse: { name: "projects", label: "Projects" } }),
    owner: defineField.actor({ label: "Owner" }),
    due: defineField.date({ label: "Due" }),
    stage: defineStage(["New", "Active", "Review", "Done"]),
  },
});

export const AppointmentsCalendar = defineView({ name: "appointments_calendar", type: "calendar", of: "appointment", label: "Appointments", dateField: "starts", filter: 'stage != "Cancelled"' });
export const ProjectsBoard = defineView({ name: "projects_board", type: "board", of: "project", label: "Projects by stage", groupBy: "stage", columns: ["name", "client", "owner", "due"] });

export default defineKit({
  id: "base",
  version: 1,
  label: "Base",
  description: "The record types any business starts from: Contact, Appointment, Subscriber and Project. One Contact per person, with Subscriber as a role linked to it beside the Space's own roles (Lead, Client and the rest), and a Project with stages.",
  includes: [Contact, Appointment, Subscriber, Project, AppointmentsCalendar, ProjectsBoard],
});
