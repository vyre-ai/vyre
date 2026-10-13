// @ts-check
// The made-up CRM beside the estate sample: Organizations, Leads, Deals (a sales pipeline) and Appointments, with the views a Kit or a person would keep (a leads board, a pipeline kanban, an appointments
// calendar). The app's sample world turns it on (`createMockStore({ crm: true })`) so the records views have something to click; the tests that count the plain sample world leave it off.
import { money, ref } from "./mock-values.js";

const LEAD_STAGES = ["New", "Contacted", "Qualified", "Won", "Lost"];
const DEAL_STAGES = ["Prospect", "Discovery", "Proposal", "Negotiation", "Won"];

/** @type {any[]} */
export const crmTypes = [
  { name: "organization", label: "Organization", icon: "users", fields: [
    { name: "name", label: "Name", kind: "text", required: true }, { name: "domain", label: "Domain", kind: "text" }, { name: "phone", label: "Phone", kind: "text" },
  ], views: [{ name: "organizations_list", type: "list", label: "All organizations", columns: ["name", "domain", "phone"], sort: { field: "name", dir: "asc" } }] },
  { name: "lead", label: "Lead", icon: "star", fields: [
    { name: "name", label: "Name", kind: "text", required: true }, { name: "contact", label: "Contact", kind: "link", to: "contact" },
    { name: "stage", label: "Stage", kind: "stage", options: LEAD_STAGES }, { name: "source", label: "Source", kind: "choice", options: ["Website", "Referral", "Event", "Ad"] },
    { name: "value", label: "Value", kind: "money" }, { name: "next", label: "Next step on", kind: "date" },
  ], stages: LEAD_STAGES.map(name => ({ name })), views: [{ name: "leads_board", type: "board", label: "Leads by stage", groupBy: "stage", columns: ["contact", "source", "value"] }] },
  { name: "deal", label: "Deal", icon: "chart", fields: [
    { name: "title", label: "Title", kind: "text", required: true }, { name: "organization", label: "Organization", kind: "link", to: "organization" },
    { name: "stage", label: "Stage", kind: "stage", options: DEAL_STAGES }, { name: "value", label: "Value", kind: "money" }, { name: "close", label: "Expected close", kind: "date" },
  ], stages: DEAL_STAGES.map(name => ({ name })), views: [{ name: "sales_pipeline", type: "board", label: "Sales pipeline", groupBy: "stage", columns: ["organization", "value", "close"] }] },
  { name: "appointment", label: "Appointment", icon: "planner", fields: [
    { name: "title", label: "Title", kind: "text", required: true }, { name: "with", label: "With", kind: "link", to: "contact" },
    { name: "starts", label: "Starts", kind: "datetime" }, { name: "place", label: "Place", kind: "text" },
    { name: "stage", label: "Status", kind: "stage", options: ["Booked", "Done", "Cancelled"] },
  ], stages: ["Booked", "Done", "Cancelled"].map(name => ({ name })), views: [{ name: "appointments_calendar", type: "calendar", label: "Appointments", dateField: "starts", columns: ["title", "with"], filter: 'stage != "Cancelled"' }] },
];

/** Which space each sample CRM type is listed under. @param {string} space */
export const crmTypeSpace = space => /** @type {Record<string, string>} */ ({ organization: space, lead: space, deal: space, appointment: space });

/** Write the CRM's records. `put(type, space, data, alias)` is the store's own; `urn(alias)` a seeded record's urn; `at(dayOffset, hour)` an ISO time relative to today. @param {any} put @param {string} space @param {(a: string) => string} urn @param {(d: number, h: number) => string} at */
export function seedCrm(put, space, urn, at) {
  const day = (/** @type {number} */ d) => at(d, 0).slice(0, 10);
  [["o1", "Northwind Bakery", "northwind.example.com", "+1 415 555 0101"], ["o2", "Ortiz Notary", "ortiznotary.example.com", "+1 415 555 0123"], ["o3", "Larkin Realty", "larkin.example.com", "+1 415 555 0166"], ["o4", "Reyes Design", "reyes.example.com", "+1 415 555 0190"]]
    .forEach(([a, name, domain, phone]) => put("organization", space, { name, domain, phone }, a));
  /** @type {[string, string, string, string, number, number][]} */
  const leads = [["l1", "Doe family trust", "c1", "Referral", 4800, 2], ["l2", "Roe succession", "c2", "Website", 6500, 5], ["l3", "Shah will update", "c4", "Ad", 1200, 1], ["l4", "Marcus Doe, trust", "c3", "Referral", 3900, 9], ["l5", "Ortiz POA", "c5", "Event", 800, 3], ["l6", "Reyes retainer", "c6", "Website", 2400, 12]];
  const stagesOf = ["Qualified", "Contacted", "New", "Won", "Contacted", "New"];
  leads.forEach(([a, name, c, source, value, next], i) => put("lead", space, { name, contact: ref(urn(c)), stage: stagesOf[i], source, value: money(value), next: day(next) }, a));
  /** @type {[string, string, string, string, number, number][]} */
  const deals = [["d1", "Bookkeeping retainer", "o1", "Proposal", 14000, 14], ["d2", "Notary partnership", "o2", "Discovery", 3000, 30], ["d3", "Closing packages", "o3", "Negotiation", 22000, 7], ["d4", "Site rebuild", "o4", "Won", 9500, -4], ["d5", "Annual review", "o1", "Prospect", 5000, 45], ["d6", "Referral program", "o3", "Prospect", 8000, 60]];
  deals.forEach(([a, title, o, stage, value, close]) => put("deal", space, { title, organization: ref(urn(o)), stage, value: money(value), close: day(close) }, a));
  /** @type {[string, string, string, number, number, string, string][]} */
  const appts = [["a1", "Review the Doe draft", "c1", 1, 10, "Office", "Booked"], ["a2", "Signing, Marcus Doe", "c3", 3, 14, "Ortiz Notary", "Booked"], ["a3", "Intake call, Shah", "c4", 0, 15, "Phone", "Booked"], ["a4", "Roe succession kickoff", "c2", 6, 11, "Office", "Booked"], ["a5", "Funding check-in", "c5", 8, 9, "Phone", "Booked"], ["a6", "Reyes retainer call", "c6", 10, 16, "Video", "Booked"], ["a7", "Old intake", "c4", -3, 13, "Phone", "Done"], ["a8", "Missed callback", "c2", 2, 12, "Phone", "Cancelled"]];
  appts.forEach(([a, title, c, d, h, place, stage]) => put("appointment", space, { title, with: ref(urn(c)), starts: at(d, h), place, stage }, a));
}
