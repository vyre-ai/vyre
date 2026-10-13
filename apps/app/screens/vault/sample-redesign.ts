// The Vault's sample world for the redesigned screen: made-up values, in the ten groups, with where each is used, who has it and what happened to it. A real source (vault.* and vault.me.*) replaces this.
import type { VItem } from "./redesign.js";

export type Event = { id: string; item: string; who: string; what: string; when: string };

export const SAMPLE_ITEMS: VItem[] = [
  { id: "f1", sp: "juniper", group: "Any API key", name: "Juniper signing key", detail: "Firm-wide", secret: "jun-sign-7Hq2-Lm41-Vz", daysLeft: 120, lastUsedDays: 2, usedBy: [{ kind: "flow", name: "Engagement letters" }, { kind: "agent", name: "Kit" }], shared: [{ who: "kit", level: "use" }, { who: "chris", level: "edit" }] },
  { id: "s1", sp: "juniper", group: "Email and sending", name: "Resend (updates.juniper.example)", detail: "Email sending", secret: "re_9Kq2Lz81Tm4pXb7", daysLeft: 9, lastUsedDays: 1, usedBy: [{ kind: "flow", name: "Intake confirmation" }, { kind: "flow", name: "Weekly digest" }, { kind: "connection", name: "Resend" }], shared: [{ who: "kit", level: "use" }] },
  { id: "k1", sp: "juniper", group: "Any API key", sharedWithMe: true, name: "Stripe (read only)", detail: "rk_live_...", secret: "rk_live_51Hx9Qa2d7uPz", daysLeft: null, lastUsedDays: 0, usedBy: [{ kind: "agent", name: "Kit" }, { kind: "project", name: "Billing review" }], shared: [{ who: "kit", level: "use" }] },
  { id: "k2", sp: "juniper", group: "Any API key", name: "Old analytics key", detail: "analytics.example.com", secret: "an-0042-old-key-0x", daysLeft: -3, lastUsedDays: 140, usedBy: [], shared: [] },
  { id: "p1", sp: "juniper", group: "Phone and texts", name: "Firm line (Twilio)", detail: "+1 415 555 0140", secret: "AC83b1-twilio-auth-5f2e", daysLeft: null, lastUsedDays: 4, usedBy: [{ kind: "flow", name: "Missed-call text back" }], shared: [{ who: "juno", level: "use" }] },
  { id: "l1", sp: "juniper", group: "Logins", name: "Gmail", detail: "intake@juniperstudio.example.com", secret: "Mt7!hQ2-sail-9Rb", daysLeft: null, lastUsedDays: 0, usedBy: [{ kind: "connection", name: "Gmail" }, { kind: "agent", name: "Kit" }, { kind: "agent", name: "Juno" }], shared: [{ who: "kit", level: "use" }, { who: "juno", level: "use" }] },
  { id: "l2", sp: "juniper", group: "Logins", name: "Clio", detail: "alex@juniperstudio.example.com", secret: "clio-4Gp-Lm81-Zq", daysLeft: null, lastUsedDays: 1, usedBy: [{ kind: "agent", name: "Kit" }], shared: [{ who: "kit", level: "use" }] },
  { id: "m1", sp: "juniper", group: "Code and hosting", name: "Claude Desktop (Alex)", detail: "Connects Claude Desktop to this Space", secret: "vyre_mcp_Qn83-aT71-Zc09", daysLeft: 60, lastUsedDays: 0, usedBy: [], shared: [] },
  { id: "n1", sp: "juniper", group: "SSH keys", name: "Office NAS", detail: "ssh admin@nas.local", secret: "ssh-ed25519 AAAAC3Nza...", daysLeft: null, lastUsedDays: 30, usedBy: [], shared: [{ who: "chris", level: "edit" }] },
  { id: "a1", sp: "juniper", group: "AI models", name: "Anthropic", detail: "Claude models for the Space", secret: "sk-ant-api03-sample-0000", daysLeft: null, lastUsedDays: 0, usedBy: [{ kind: "agent", name: "Kit" }], shared: [{ who: "kit", level: "use" }] },
  { id: "g1", sp: "juniper", group: "Google and Microsoft", sharedWithMe: true, name: "Google service account", detail: "Acts as intake@juniperstudio.example.com", secret: "{sample service account}", daysLeft: 11, lastUsedDays: 1, usedBy: [{ kind: "connection", name: "Gmail" }], shared: [] },
  { id: "t1", sp: "juniper", group: "Messaging", name: "Telegram bot", detail: "Front desk alerts", secret: "123456789:sample-telegram-bot-token-0000", daysLeft: null, lastUsedDays: 6, usedBy: [], shared: [] },
  { id: "q1", sp: "juniper", group: "Secure notes", name: "Wi-Fi at the office", detail: "Note", secret: "juniper-guest-2026", daysLeft: null, lastUsedDays: 40, usedBy: [], shared: [] },
  { id: "o1", sp: "mine", group: "Logins", name: "Passport portal", detail: "alex.rivera", secret: "Pp-7731-bluff-Tn", daysLeft: null, lastUsedDays: 2, usedBy: [{ kind: "agent", name: "Juno" }], shared: [{ who: "juno", level: "use" }] },
  { id: "o2", sp: "mine", group: "Logins", name: "Airline account", detail: "alex@example.com", secret: "Fly-93k-Zorro-p", daysLeft: null, lastUsedDays: null, usedBy: [], shared: [] },
  { id: "o3", sp: "mine", group: "AI models", name: "Claude sign-in", detail: "My AI sign-in", secret: "sk-ant-oat-0000-sample", daysLeft: 25, lastUsedDays: 0, usedBy: [{ kind: "project", name: "Estate plan for Lee" }], shared: [] },
  { id: "o4", sp: "mine", group: "Code and hosting", name: "GitHub connection", detail: "My MCP connection", secret: "ghp_sample0000000000", daysLeft: 6, lastUsedDays: 3, usedBy: [{ kind: "connection", name: "GitHub" }], shared: [] },
];

export const SAMPLE_EVENTS: Event[] = [
  { id: "e1", item: "l1", who: "kit", what: "Used it to send a reply", when: "Today 9:12" },
  { id: "e2", item: "l1", who: "alex", what: "Revealed the value", when: "Yesterday 16:40" },
  { id: "e3", item: "l1", who: "alex", what: "Changed the password (version 3)", when: "12 Oct" },
  { id: "e4", item: "k1", who: "kit", what: "Used it for a payment lookup", when: "Today 8:05" },
  { id: "e5", item: "s1", who: "Intake confirmation", what: "Used it to send 14 emails", when: "Today 7:30" },
];

export const SAMPLE_PEOPLE = ["kit", "juno", "chris", "iris"];
