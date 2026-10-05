// The Law firm Kit: what a law firm adds to the base Kit's Project. A Project follows its own stages by practice area (a personal injury case and an estate
// plan are not the same journey), and a field that applies to one area shows, and is required, only there.
//
// Install the base Kit first. This Kit restates the whole Project (a type is defined whole) with the base fields, then adds its own.
import { defineKit, defineType, defineField, defineStage, defineView } from "@vyre/sdk";

export const Project = defineType({
  name: "project",
  label: "Project",
  icon: "IconBriefcase",
  kind: "project",
  fields: {
    // `name` and `client` are the core Project's own; practice_area, owner and due are the base Kit's.
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

// The base Kit's board, kept: a type is replaced whole, so its views go with it.
export const ProjectsBoard = defineView({ name: "projects_board", type: "board", of: "project", label: "Projects by stage", groupBy: "stage", columns: ["name", "client", "practice_area", "owner", "due"] });

export default defineKit({
  id: "law-firm",
  version: 1,
  label: "Law firm",
  description: "For a law firm: a Project follows its own stages by practice area (personal injury and estate planning to start), with the accident date, trust name and hearing date shown and required only where they apply. Install the base Kit first.",
  includes: [Project, ProjectsBoard],
});
