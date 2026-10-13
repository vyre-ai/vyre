// Sample data for the Records setup designs: a firm that adds an Assets type with six fields and a link to Clients. Generic names only.
import type { Draft, FieldRow, MapType, RoleRef, Starter, TypeRef } from "@vyre/ui";
import { newDraft } from "@vyre/ui";

export const ROLES: RoleRef[] = [["attorney", "Attorneys"], ["paralegal", "Paralegals"], ["intake", "Intake staff"]];

export const TYPES: TypeRef[] = [
  { name: "contact", label: "Client", plural: "Clients" },
  { name: "project", label: "Project", plural: "Projects" },
  { name: "asset", label: "Asset", plural: "Assets" },
  { name: "beneficiary", label: "Beneficiary", plural: "Beneficiaries" },
];
export const ASSET: TypeRef = TYPES[2];

export const MODEL: MapType[] = [
  { name: "contact", label: "Client", plural: "Clients", fields: 11, records: 38, links: [] },
  { name: "project", label: "Project", plural: "Projects", fields: 9, records: 24, kit: "Estate planning", links: [{ to: "contact", label: "Client", many: false }] },
  { name: "asset", label: "Asset", plural: "Assets", fields: 6, records: 0, links: [{ to: "contact", label: "Client", many: false }] },
  { name: "beneficiary", label: "Beneficiary", plural: "Beneficiaries", fields: 5, records: 0, links: [{ to: "asset", label: "Asset", many: true }, { to: "contact", label: "Client", many: false }] },
];

export const STARTERS: Starter[] = [
  { id: "blank", label: "Blank", blurb: "One field, Title. Add the rest yourself.", fields: ["Title"] },
  { id: "assets", label: "Assets", blurb: "What a client owns: homes, accounts, policies.", from: "Estate planning", fields: ["Name", "Kind", "Client", "Estimated value", "Account number", "Held in"] },
  { id: "beneficiaries", label: "Beneficiaries", blurb: "Who receives what, with a share.", from: "Estate planning", fields: ["Name", "Relationship", "Share", "Client", "Contact"] },
  { id: "deal", label: "Deal", blurb: "A sale with a value and a close date.", fields: ["Title", "Contact", "Value", "Close date", "Stage"] },
];

const base = (p: Partial<Draft> & { label: string; kind: string }): FieldRow => ({ ...newDraft(p.kind), ...p, name: p.label.toLowerCase().replace(/[^a-z0-9]+/g, "_") });
export const ASSET_FIELDS: FieldRow[] = [
  base({ label: "Name", kind: "text", required: true }),
  base({ label: "Kind", kind: "choice", required: true, options: ["Real estate", "Bank account", "Retirement account", "Life insurance", "Vehicle", "Other"] }),
  base({ label: "Client", kind: "link", required: true, to: "contact", many: false, inverse: "Assets" }),
  base({ label: "Estimated value", kind: "money", hidden_from: ["intake"] }),
  base({ label: "Account number", kind: "text", sealed: true }),
  base({ label: "Held in", kind: "choice", options: ["Individual", "Joint", "Trust"] }),
];
export const DRAFTS = {
  blank: newDraft("text"),
  kind: { ...newDraft("choice"), name: "kind", label: "Kind", required: true, description: "What sort of asset this is", options: ["Real estate", "Bank account", "Retirement account", "Life insurance"] },
  client: { ...newDraft("link"), name: "client", label: "Client", required: true, to: "contact", many: false, inverse: "Assets" },
  value: { ...newDraft("money"), name: "estimated_value", label: "Estimated value", hidden_from: ["intake"], required_if: 'kind != "Other"' },
  broken: { ...newDraft("choice"), label: "Held in", options: ["Joint", "joint"], required: true, hidden: true },
} satisfies Record<string, Draft>;
