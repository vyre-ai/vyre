// The Law firm Kit: what a law firm adds to the base Kit. Practice area is a choice on Lead, Appointment, Client and Project; a Project follows its own stages by
// practice area (a personal injury case and an estate plan are not the same journey); and a field that applies to one area shows, and is required, only there.
//
// Install the base Kit first. A type is defined whole, so this Kit restates Lead, Appointment, Client and Project with the base fields, then adds its own,
// and keeps the base Kit's views of them.
import { defineKit, defineType, defineField, defineStage, defineView } from "@vyre/sdk";

export const Lead = defineType({
  name: "lead",
  label: "Lead",
  icon: "IconUserPlus",
  role: { link: "contact", ended: ["Converted", "Lost"] },
  fields: {
    contact: defineField.link({ to: "contact", label: "Contact", required: true, inverse: { name: "leads", label: "Leads" } }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
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
    contact: defineField.link({ to: "contact", label: "Contact", required: true, inverse: { name: "appointments", label: "Appointments" } }),
    kind: defineField.choice(["Consultation", "Meeting", "Follow-up", "Signing", "Call", "Other"], { label: "Kind" }),
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
    contact: defineField.link({ to: "contact", label: "Contact", required: true, inverse: { name: "clients", label: "Clients" } }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    since: defineField.date({ label: "Client since" }),
    stage: defineStage(["Onboarding", "Active", "Closed"]),
  },
});

export const Project = defineType({
  name: "project",
  label: "Project",
  icon: "IconBriefcase",
  kind: "project",
  fields: {
    // `name` and `client` are the core Project's own; owner and due are the base Kit's.
    name: defineField.text({ label: "Name", required: true }),
    client: defineField.link({ to: "contact", label: "Client", required: true, inverse: { name: "projects", label: "Projects" } }),
    practice_area: defineField.choice(["Personal Injury", "Estate Planning", "Family Law", "Immigration", "Business", "Criminal Defense", "Other"], { label: "Practice area" }),
    owner: defineField.actor({ label: "Owner" }),
    due: defineField.date({ label: "Due" }),
    accident_date: defineField.date({ label: "Accident date", visible_if: 'practice_area == "Personal Injury"', required_if: 'practice_area == "Personal Injury"' }),
    trust_name: defineField.text({ label: "Trust or plan name", visible_if: 'practice_area == "Estate Planning"' }),
    hearing_date: defineField.date({ label: "Next hearing", visible_if: 'practice_area == "Family Law" or practice_area == "Criminal Defense"' }),
    stage: defineStage(["New", "Active", "Review", "Done"], {
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
export const LeadsByArea = defineView({ name: "leads_by_area", type: "board", of: "lead", label: "Leads by practice area", groupBy: "practice_area", columns: ["contact", "source"] });

export default defineKit({
  id: "law-firm",
  version: 1,
  label: "Law firm",
  description: "For a law firm: practice area on leads, appointments, clients and projects, and a Project that follows its own stages by practice area (personal injury and estate planning to start), with the accident date, trust name and hearing date shown and required only where they apply. Install the base Kit first.",
  includes: [Lead, Appointment, Client, Project, LeadsBoard, AppointmentsCalendar, ClientsList, ProjectsBoard, LeadsByArea],
});
