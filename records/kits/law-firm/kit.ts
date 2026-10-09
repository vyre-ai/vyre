// The Law firm Kit: what a law firm adds to the base Kit. Practice area is a choice on Lead, Appointment, Client and Project; a Project follows its own stages by
// practice area (a personal injury case and an estate plan are not the same journey); and a field that applies to one area shows, and is required, only there.
//
// Each stage lists the tasks its work is made of (a paralegal's or an attorney's), and names the attorney as its owner: a task not done by its due offset is escalated to the owner. A stage with
// no tasks is moved by a person.
//
// Install the base Kit first. A type is defined whole, so this Kit restates Lead, Appointment, Client and Project with the base fields, then adds its own,
// and keeps the base Kit's views of them.
import { defineKit, defineType, defineField, defineStage, defineTask, defineRole, defineView } from "@vyre/sdk";

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
    stage: defineStage([
      { name: "New", owner: "role:attorney", tasks: [defineTask({ title: "Call the lead back", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "1d" })] },
      { name: "Contacted", owner: "role:attorney", tasks: [defineTask({ title: "Book the consultation", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "2d" })] },
      { name: "Meeting booked", owner: "role:attorney", tasks: [defineTask({ title: "Prepare for the consultation", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "3d" })] },
      { name: "Qualified", owner: "role:attorney", tasks: [defineTask({ title: "Send the engagement letter", doer: "role:attorney", output: { kind: "decision" }, dueOffset: "2d" })] },
      "Converted",
      "Lost",
    ]),
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
    stage: defineStage([
      { name: "Onboarding", owner: "role:attorney", tasks: [defineTask({ title: "Welcome the client and collect documents", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "3d" })] },
      "Active",
      "Closed",
    ]),
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
    stage: defineStage([
      { name: "New", owner: "role:attorney", tasks: [defineTask({ title: "Scope the work and assign it", doer: "role:attorney", output: { kind: "note" }, dueOffset: "2d" })] },
      "Active",
      { name: "Review", owner: "role:attorney", tasks: [defineTask({ title: "Review the work", doer: "role:attorney", output: { kind: "decision" }, dueOffset: "1w" })] },
      "Done",
    ], {
      sets: [
        { name: "personal_injury", when: 'practice_area == "Personal Injury"', stages: [
          { name: "Intake", owner: "role:attorney", tasks: [defineTask({ title: "Collect intake and the signed retainer", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "3d" })] },
          { name: "Treating", owner: "role:attorney", tasks: [defineTask({ title: "Check in on treatment and collect records", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "2w" })] },
          { name: "Demand", owner: "role:attorney", tasks: [defineTask({ title: "Draft the demand letter", doer: "role:attorney", output: { kind: "file" }, dueOffset: "2w" })] },
          { name: "Negotiation", enter_if: "not empty(accident_date)", owner: "role:attorney", tasks: [defineTask({ title: "Negotiate with the adjuster", doer: "role:attorney", output: { kind: "note" }, dueOffset: "4w" })] },
          { name: "Settled", owner: "role:attorney", tasks: [defineTask({ title: "Disburse the settlement funds", doer: "role:attorney", output: { kind: "note" }, dueOffset: "2w" })] },
          "Closed",
        ] },
        { name: "estate_planning", when: 'practice_area == "Estate Planning"', stages: [
          { name: "Intake", owner: "role:attorney", tasks: [defineTask({ title: "Collect family and asset details", doer: "role:paralegal", output: { kind: "note" }, dueOffset: "3d" })] },
          { name: "Drafting", owner: "role:attorney", tasks: [defineTask({ title: "Draft the documents", doer: "role:attorney", output: { kind: "file" }, dueOffset: "1w" })] },
          { name: "Review", owner: "role:attorney", tasks: [defineTask({ title: "Client review call", doer: "role:attorney", output: { kind: "note" }, dueOffset: "2w" })] },
          { name: "Signing", enter_if: "not empty(trust_name)", owner: "role:attorney", tasks: [defineTask({ title: "Signing ceremony", doer: "role:attorney", output: { kind: "decision" }, dueOffset: "3w" })] },
          { name: "Funding", owner: "role:attorney", tasks: [defineTask({ title: "Fund the trust and retitle assets", doer: "role:attorney", output: { kind: "note" }, dueOffset: "5w", required: false })] },
          "Closed",
        ] },
      ],
    }),
  },
});

export const Attorney = defineRole({
  name: "attorney",
  kind: "role",
  label: "Attorney",
  description: "Reviews and approves work, owns the stages and answers for late tasks.",
  grants: [{ read: "lead" }, { write: "lead" }, { read: "appointment" }, { write: "appointment" }, { read: "client" }, { write: "client" }, { read: "project" }, { write: "project" }, { create: "project" }, { read: "contact" }, { write: "contact" }],
});

export const Paralegal = defineRole({
  name: "paralegal",
  kind: "role",
  label: "Paralegal",
  description: "Does the intake and the file work that moves a lead or a project to its next stage.",
  grants: [{ read: "lead" }, { write: "lead" }, { read: "appointment" }, { write: "appointment" }, { read: "client" }, { write: "client" }, { read: "project" }, { write: "project" }, { read: "contact" }, { write: "contact" }],
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
  includes: [Lead, Appointment, Client, Project, Attorney, Paralegal, LeadsBoard, AppointmentsCalendar, ClientsList, ProjectsBoard, LeadsByArea],
});
