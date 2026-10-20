// The Vault's sample world: made-up items of the Juniper Studio Space, each a name and fields named like an .env, in Mine and in Shared's folders, with where each is used, who can
// use it and what happened to it. Every value is invented. A real source (vault.* and vault.me.*) replaces this.
import type { VItem } from "./redesign.js";

export type Event = { id: string; item: string; who: string; what: string; when: string };

const TEAM = { id: "team", name: "Team" }, BILLING = { id: "billing", name: "Billing" };
const f = (name: string, plain = false) => ({ name, plain });

export const SAMPLE_ITEMS: VItem[] = [
  { id: "GHL-Sales", sp: "mine", group: "Any API key", name: "GHL Sales", detail: "GHL_API_KEY, GHL_LOCATION_ID", secret: "", daysLeft: null, lastUsedDays: 0,
    fields: [f("GHL_API_KEY"), f("GHL_LOCATION_ID", true)], values: { GHL_API_KEY: "pit-7f2a-91c4-sample-4b1e", GHL_LOCATION_ID: "loc_Juniper01" },
    usedBy: [{ kind: "flow", name: "Lead follow-up" }, { kind: "agent", name: "Kit" }], shared: [{ who: "kit", level: "use" }] },
  { id: "Airline-account", sp: "mine", kind: "login", group: "Logins", name: "Airline account", detail: "alex@example.com", sites: ["https://airline.example"], secret: "", daysLeft: null, lastUsedDays: 12,
    fields: [f("username", true), f("password"), f("totp")], values: { username: "alex@example.com", password: "Fly-93k-Zorro-p", totp: "JBSWY3DPEHPK3PXP" }, usedBy: [], shared: [] },
  { id: "Office-wifi", sp: "mine", kind: "note", group: "Secure notes", name: "Office wifi", detail: "Note", secret: "", daysLeft: null, lastUsedDays: 40,
    fields: [f("text")], values: { text: "juniper-guest-2026" }, usedBy: [], shared: [] },
  { id: "Twilio", sp: "shared", folder: TEAM, provider: "twilio", group: "Phone and texts", name: "Twilio", detail: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER", secret: "", daysLeft: null, lastUsedDays: 1,
    fields: [f("TWILIO_ACCOUNT_SID", true), f("TWILIO_AUTH_TOKEN"), f("TWILIO_FROM_NUMBER", true)],
    values: { TWILIO_ACCOUNT_SID: "AC00000000sample0000000000000000", TWILIO_AUTH_TOKEN: "made-up-auth-token-00000000000000", TWILIO_FROM_NUMBER: "+14155550140" },
    usedBy: [{ kind: "flow", name: "Missed-call text back" }, { kind: "agent", name: "Juno" }], shared: [{ who: "juno", level: "use" }, { who: "chris", level: "edit" }] },
  { id: "Resend", sp: "shared", folder: TEAM, group: "Email and sending", name: "Resend", detail: "RESEND_API_KEY, RESEND_FROM", secret: "", daysLeft: 9, lastUsedDays: 0,
    fields: [f("RESEND_API_KEY"), f("RESEND_FROM", true)], values: { RESEND_API_KEY: "made-up-resend-key-0000000000", RESEND_FROM: "Juniper Studio <hello@juniper.example>" },
    usedBy: [{ kind: "flow", name: "Welcome email" }, { kind: "flow", name: "Weekly digest" }], shared: [{ who: "kit", level: "use" }] },
  { id: "Stripe", sp: "shared", folder: BILLING, group: "Any API key", sharedWithMe: true, name: "Stripe", detail: "STRIPE_SECRET_KEY, STRIPE_ACCOUNT_ID", secret: "", daysLeft: null, lastUsedDays: 0,
    fields: [f("STRIPE_SECRET_KEY"), f("STRIPE_ACCOUNT_ID", true)], values: { STRIPE_SECRET_KEY: "made-up-stripe-key-000000000000", STRIPE_ACCOUNT_ID: "acct_Northwind01" },
    usedBy: [{ kind: "agent", name: "Kit" }, { kind: "project", name: "Billing review" }], shared: [{ who: "kit", level: "use" }] },
  { id: "Old-analytics", sp: "shared", folder: BILLING, group: "Any API key", name: "Old analytics", detail: "ANALYTICS_KEY", secret: "", daysLeft: -3, lastUsedDays: 140,
    fields: [f("ANALYTICS_KEY")], values: { ANALYTICS_KEY: "an-0042-old-key-0x" }, usedBy: [], shared: [] },
];

export const SAMPLE_EVENTS: Event[] = [
  { id: "e1", item: "GHL-Sales", who: "kit", what: "Used it in Lead follow-up", when: "Today 9:12" },
  { id: "e2", item: "GHL-Sales", who: "alex", what: "Revealed GHL_API_KEY", when: "Yesterday 16:40" },
  { id: "e3", item: "Twilio", who: "juno", what: "Used it to send a text", when: "Yesterday 11:02" },
  { id: "e4", item: "Stripe", who: "kit", what: "Used it for a payment lookup", when: "Today 8:05" },
  { id: "e5", item: "Resend", who: "Welcome email", what: "Used it to send 14 emails", when: "Today 7:30" },
];

export const SAMPLE_PEOPLE = ["kit", "juno", "chris", "iris"];

/** The sample world's unfilled need, so the Vault's "This needs a key" ask is drawn too (the shape of vault.need). */
export const SAMPLE_NEEDS = [
  { module: "comms", id: "sending", provider: "sending-service", purpose: "Send your Flows' email through your own sending service", state: "missing", how: "field" },
];
