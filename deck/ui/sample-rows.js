// @ts-check
// deck/ui/sample-rows: the made-up world's records (Alex Rivera, Harlow Legal, Jane Doe, the Doe estate plan), for the lab and for the fallback store the field
// screens use until the real store is wired. Sealed values here are raw, as a person's own store would hold them; an assistant's view never reads them.

/** @typedef {import("./contracts.js").RecordRow} RecordRow */
/** @typedef {import("./contracts.js").Actor} Actor */

export const SPACES = [
  { id: "mine", name: "Mine", kind: /** @type {"mine"} */ ("mine") },
  { id: "harlow", name: "Harlow Legal", kind: /** @type {"team"} */ ("team") },
];

/** @type {Actor[]} */
export const actors = [
  { id: "alex", kind: "person", name: "Alex Rivera", role: "Owner" },
  { id: "chris", kind: "person", name: "Chris Park", role: "Attorney" },
  { id: "juno", kind: "assistant", name: "juno", role: "Assistant" },
  { id: "kit", kind: "assistant", name: "kit", role: "Assistant" },
  { id: "research", kind: "teammate", name: "Research", role: "Research", doing: "Research wrote 3 fields and a note with 3 sources" },
  { id: "drafting", kind: "teammate", name: "Drafting", role: "Drafting", doing: "Drafting is drafting the engagement letter" },
];

const T0 = Date.UTC(2026, 9, 3, 9, 12);
/** @param {string} id @param {string} type @param {string} space @param {Record<string, any>} values @param {number} [age] days since last change @returns {RecordRow} */
const rec = (id, type, space, values, age = 3) => ({ id, type, space, values, createdAt: T0 - 30 * 86400_000, updatedAt: T0 - age * 86400_000 });

/** @type {RecordRow[]} */
export const rows = [
  rec("jane", "contact", "harlow", { name: "Jane Doe", role: "Client", email: "jane.doe@example.com", phone: "+1 415 555 0142", rating: 5, address: "18 Larkin St, San Francisco, CA 94109", dob: "1961-04-12", ssn: "412-55-6789", acct: "0061 2288 4410", notes: "Widowed, two adult children. Wants the **trust funded** before the house sale in November.", matter: "m1" }, 0),
  rec("john", "contact", "harlow", { name: "John Roe", role: "Client", email: "j.roe@example.com", phone: "+1 415 555 0177", rating: 4, address: "402 Pine St, Oakland, CA 94612", dob: "1958-09-30", ssn: "530-21-1144", acct: "0071 4420 9931", notes: "Owns a bakery. Needs a succession plan before he steps back in spring.", matter: "m2" }, 2),
  rec("marcus", "contact", "harlow", { name: "Marcus Doe", role: "Client", email: "marcus.doe@example.com", phone: "+1 415 555 0119", rating: 3, address: "77 Alder Way, Berkeley, CA 94704", dob: "1988-02-03", ssn: "611-72-0098", acct: "0082 1190 3347", notes: "Jane Doe's son. Successor trustee.", matter: "m4" }, 5),
  rec("priya", "contact", "harlow", { name: "Priya Shah", role: "Client", email: "priya.shah@example.com", phone: "+1 510 555 0164", rating: 4, address: "9 Elm Ct, Alameda, CA 94501", dob: "1979-11-21", ssn: "544-90-3321", acct: "0093 5567 2210", notes: "Updating a will after a move.", matter: "m3" }, 1),
  rec("lena", "contact", "harlow", { name: "Lena Ortiz", role: "Vendor", email: "lena@ortiznotary.example.com", phone: "+1 415 555 0123", rating: 5, address: "2 Market St, San Francisco, CA", notes: "Mobile notary. Signs same day.", matter: "m5" }, 9),
  rec("wen", "contact", "harlow", { name: "Wen Lee", role: "Referrer", email: "wen.lee@example.com", phone: "+1 415 555 0188", rating: 4, address: "31 Oak Ave, Daly City, CA", dob: "1970-06-08", ssn: "478-12-5509", notes: "Refers clients from the community center.", matter: "m6" }, 12),
  rec("sam", "contact", "mine", { name: "Sam Okafor", role: "Friend", email: "sam@example.com", phone: "+1 415 555 0101", rating: 5, dob: "1984-07-14", notes: "Saturday hike. Bring the trail map." }, 4),
  rec("chen", "contact", "mine", { name: "Dr. Chen", role: "Vendor", email: "office@chendental.example.com", phone: "+1 415 555 0166", rating: 4, address: "55 Valencia St, San Francisco, CA", notes: "Cleaning every six months. Next in November." }, 20),

  rec("m1", "matter", "harlow", { title: "Doe estate plan", client: "jane", plan: "Both", situation: "Widowed, two adult children", assets: "House at 18 Larkin St, sale in November", pressure: "Fund the trust before the sale", fee: 4800, stage: "Engagement", owner: "alex", opened: "2026-09-08", closing: "2026-10-28", docs: "Intake questionnaire.pdf" }, 0),
  rec("m2", "matter", "harlow", { title: "Roe succession plan", client: "john", plan: "Trust", situation: "Owner of a bakery", assets: "Bakery building and equipment", pressure: "Steps back in spring", fee: 6500, stage: "Engagement", owner: "kit", opened: "2026-09-22", closing: "2026-11-14", docs: "Engagement letter (draft).docx" }, 1),
  rec("m3", "matter", "harlow", { title: "Shah will update", client: "priya", plan: "Will", situation: "Moved states", assets: "Condo in Alameda", pressure: "None", fee: 1200, stage: "Intake", owner: "kit", opened: "2026-10-01", closing: "2026-10-20" }, 2),
  rec("m4", "matter", "harlow", { title: "Doe trust, Marcus", client: "marcus", plan: "Trust", situation: "Successor trustee", assets: "Family trust", pressure: "Signing next week", fee: 3900, stage: "Signing", owner: "chris", opened: "2026-08-14", closing: "2026-10-09", docs: "Trust agreement v4.pdf" }, 3),
  rec("m5", "matter", "harlow", { title: "Ortiz power of attorney", client: "lena", plan: "Will", situation: "Single, no children", assets: "None in play", pressure: "None", fee: 800, stage: "Funding", owner: "alex", opened: "2026-07-30", closing: "2026-10-05", docs: "POA signed.pdf" }, 6),
  rec("m6", "matter", "harlow", { title: "Lee trust amendment", client: "wen", plan: "Trust", situation: "Amending beneficiaries", assets: "Rental property", pressure: "None", fee: 2100, stage: "Closed", owner: "chris", opened: "2026-08-02", closing: "2026-09-18", docs: "Amendment signed.pdf" }, 15),

  rec("p1", "project", "mine", { title: "Vyre site", stage: "Build", owner: "alex", priority: "High", budget: 8000, due: "2026-10-31", notes: "Landing page and the setup guide." }, 1),
  rec("p2", "project", "mine", { title: "Garden shed", stage: "Plan", owner: "alex", priority: "Low", budget: 1500, due: "2026-11-20" }, 8),
  rec("p3", "project", "harlow", { title: "Intake form refresh", stage: "Review", owner: "kit", priority: "Normal", budget: 2400, due: "2026-10-14", brief: "Intake form notes.pdf" }, 2),

  rec("t1", "trip", "mine", { title: "Lisbon in spring", stage: "Booked", where: "Lisbon, Portugal", leaves: "2026-10-18", returns: "2026-10-26", budget: 3200, with: "alex", booking: "KQ7R4M", notes: "Window seat, **vegetarian** meals." }, 4),
  rec("t2", "trip", "mine", { title: "Cabin weekend", stage: "Dreaming", where: "Lake Tahoe, CA", leaves: "2026-11-07", returns: "2026-11-09", budget: 700, with: "chris" }, 10),

  rec("tp1", "template", "harlow", { name: "Welcome email", kind: "Email", body: "Thank you for choosing **Harlow Legal**. Here is what happens next.", owner: "kit", uses: 41, updated: "2026-09-30" }, 3),
  rec("tp2", "template", "harlow", { name: "Engagement letter", kind: "Letter", body: "This letter confirms the terms of our work together.", owner: "chris", uses: 18, updated: "2026-09-12" }, 20),
  rec("tp3", "template", "harlow", { name: "Intake questionnaire", kind: "Form", body: "Name, family situation, assets, time pressure.", owner: "juno", uses: 57, updated: "2026-08-21" }, 40),
];

/** id -> { title, type }, for link fields. @param {import("./contracts.js").TypeDef[]} types */
export function linkIndex(types, list = rows) {
  /** @type {Record<string, { title: string, type: string }>} */
  const out = {};
  for (const r of list) { const t = types.find(x => x.id === r.type); if (t) out[r.id] = { title: String(r.values[t.titleKey] ?? r.id), type: r.type }; }
  return out;
}

const T = (/** @type {number} */ d) => T0 - d * 3600_000;
/** @type {Record<string, import("./contracts.js").VyreEvent[]>} */
export const events = {
  m1: [
    { id: "e1", record: "m1", actor: "alex", what: "Stage changed from Intake to Engagement", at: T(3), why: "Jane Doe signed the intake form" },
    { id: "e2", record: "m1", actor: "kit", what: "Drafted the engagement letter", at: T(30) },
    { id: "e3", record: "m1", actor: "chris", what: "Approved the Welcome email", at: T(54), why: "Reviewed before it left the space" },
    { id: "e4", record: "m1", actor: "alex", what: "Opened by Flow On payment", at: T(24 * 25) },
  ],
  jane: [
    { id: "e5", record: "jane", actor: "alex", what: "Moved the matter to Engagement", at: T(3) },
    { id: "e6", record: "jane", actor: "kit", what: "Added a note with 3 sources", at: T(31) },
    { id: "e7", record: "jane", actor: "chris", what: "Revealed the SSN with Face ID", at: T(80), why: "Prepared the trust funding forms" },
  ],
};
