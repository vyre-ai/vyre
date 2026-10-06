// Types per space, sample data (public sample world). `loadTypes()` is the one read; a real source replaces it.
import type { TypeDef } from "./logic.js";

export const CUSTOMIZE_SPACES: [string, string][] = [["mine", "Mine"], ["juniper", "Juniper Studio"]];

export function loadTypes(): TypeDef[] {
  return [
    {
      id: "contact", label: "Contact", plural: "Contacts", spaces: ["mine", "juniper"], work: false, icon: "contacts",
      fields: [
        { key: "name", label: "Name", kind: "text", required: true }, { key: "role", label: "Role", kind: "choice" }, { key: "email", label: "Email", kind: "email" },
        { key: "phone", label: "Phone", kind: "phone" }, { key: "address", label: "Address", kind: "address" }, { key: "dob", label: "Date of birth", kind: "date" },
        { key: "ssn", label: "SSN", kind: "sealed", sealed: true }, { key: "acct", label: "Account number", kind: "sealed", sealed: true },
        { key: "notes", label: "Notes", kind: "richtext" }, { key: "matter", label: "Matter", kind: "link" },
      ],
      stages: [],
    },
    {
      id: "matter", label: "Matter", plural: "Matters", spaces: ["juniper"], work: true, kit: "Estate planning matter",
      fields: [
        { key: "title", label: "Title", kind: "text", required: true }, { key: "client", label: "Client", kind: "link" }, { key: "plan", label: "Plan", kind: "choice" },
        { key: "fee", label: "Fee", kind: "money" }, { key: "stage", label: "Stage", kind: "stage", rule: "Engagement needs a signed letter" }, { key: "owner", label: "Owner", kind: "actor" },
        { key: "opened", label: "Opened", kind: "date" }, { key: "closing", label: "Closing", kind: "date" }, { key: "docs", label: "Main document", kind: "file" },
      ],
      stages: ["Intake", "Engagement", "Drafting", "Signing", "Funding", "Closed"],
      rules: { Engagement: "A signed engagement letter", Signing: "The draft approved by an attorney" },
    },
    {
      id: "trip", label: "Trip", plural: "Trips", spaces: ["mine"], work: true,
      fields: [{ key: "title", label: "Title", kind: "text", required: true }, { key: "where", label: "Where", kind: "address" }, { key: "when", label: "When", kind: "date" }, { key: "stage", label: "Stage", kind: "stage" }, { key: "budget", label: "Budget", kind: "money" }],
      stages: ["Idea", "Booked", "Packed", "Done"],
    },
  ];
}
