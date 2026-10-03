// @ts-check
// deck/ui/sample-rows: the made-up world's records (Alex Rivera, Harlow Legal, Jane Doe, the Doe estate plan), for the lab and for the fallback store the field
// screens use when the real store is not wired. The records are the kernel's GatewayRecords: a sealed field holds a SealedRefValue, and the plaintext those references
// stand for sits in `vault` (a lab-and-fallback stand-in for the sealing process; nothing but a Reveal reads it).
import { SPACE, WHO, digest, minted, seeded, urnOf } from "./mock-ids.js";
import { actorValue, addr, file, money, ref } from "./mock-values.js";

/** @typedef {import("./contracts.js").GatewayRecord} GatewayRecord */
/** @typedef {import("./contracts.js").Who} Who */
/** @typedef {import("./contracts.js").EventEnvelope} EventEnvelope */

export const SPACES = [
  { id: SPACE.mine, name: "Mine", kind: /** @type {"mine"} */ ("mine") },
  { id: SPACE.harlow, name: "Harlow Legal", kind: /** @type {"team"} */ ("team") },
];

/** @type {Who[]} */
export const actors = [
  { id: WHO.alex, family: "person", name: "Alex Rivera", role: "Owner" },
  { id: WHO.chris, family: "person", name: "Chris Park", role: "Attorney" },
  { id: WHO.juno, family: "assistant", name: "juno", role: "Assistant" },
  { id: WHO.kit, family: "assistant", name: "kit", role: "Assistant" },
  { id: WHO.research, family: "teammate", name: "Research", role: "Research", doing: "Research wrote 3 fields and a note with 3 sources" },
  { id: WHO.drafting, family: "teammate", name: "Drafting", role: "Drafting", doing: "Drafting is drafting the engagement letter" },
];

const T0 = Date.UTC(2026, 9, 3, 9, 12);
const DAY = 86400_000;

/** The sealing process's stand-in: ref -> plaintext. Only a Reveal reads it. @type {Map<string, string>} */
export const vault = new Map();
/** @param {string} cls @param {string} plain @param {boolean} [hint] a SealedRefValue, the way a record holds a sealed value */
function sealed(cls, plain, hint = false) {
  const r = `seal_${seeded(`sample:${cls}:${plain.length}:${vault.size}`).slice(0, 18)}`;
  vault.set(r, plain);
  return { sealed: cls, ref: r, present: true, valid_format: true, set_at: T0 - 30 * DAY, ...(hint ? { hint: plain.slice(-4) } : {}) };
}

/** Where each sample record lives: type and space. */
const WHERE = /** @type {Record<string, [string, "mine"|"harlow"]>} */ ({
  jane: ["contact", "harlow"], john: ["contact", "harlow"], marcus: ["contact", "harlow"], priya: ["contact", "harlow"], lena: ["contact", "harlow"], wen: ["contact", "harlow"],
  sam: ["contact", "mine"], chen: ["contact", "mine"],
  m1: ["matter", "harlow"], m2: ["matter", "harlow"], m3: ["matter", "harlow"], m4: ["matter", "harlow"], m5: ["matter", "harlow"], m6: ["matter", "harlow"],
  p1: ["project", "mine"], p2: ["project", "mine"], p3: ["project", "harlow"], t1: ["trip", "mine"], t2: ["trip", "mine"],
  tp1: ["template", "harlow"], tp2: ["template", "harlow"], tp3: ["template", "harlow"],
});
/** The urn of a sample record by its short name. @param {string} alias */
export const urnFor = alias => { const w = WHERE[alias]; if (!w) throw new Error(`No sample record ${alias}`); return urnOf(SPACE[w[1]], w[0], seeded(alias)); };
const who = (/** @type {string} */ id, /** @type {"mine"|"harlow"} */ space) => actorValue({ kind: id === WHO.alex || id === WHO.chris ? "person" : "agent", id, space: SPACE[space] });

/** @param {string} alias @param {Record<string, any>} data @param {number} [age] days since last change @returns {GatewayRecord} */
function rec(alias, data, age = 3) {
  const [type, space] = WHERE[alias];
  return { type, id: seeded(alias), urn: urnFor(alias), version: 1, data, created_at: T0 - 30 * DAY, updated_at: T0 - age * DAY,
    labels: { trust: "member", red: type === "contact" ? "pii" : "internal", source_spaces: [SPACE[space]] } };
}

/** @type {GatewayRecord[]} */
export const rows = [
  rec("jane", { name: "Jane Doe", role: "Client", email: ["jane.doe@example.com"], phone: ["+1 415 555 0142"], rating: 5, address: addr("18 Larkin St", "San Francisco", "CA", "94109"), dob: "1961-04-12", ssn: sealed("us-ssn", "412-55-6789"), acct: sealed("bank-account", "0061 2288 4410"), notes: "Widowed, two adult children. Wants the **trust funded** before the house sale in November.", matter: ref(urnFor("m1")) }, 0),
  rec("john", { name: "John Roe", role: "Client", email: ["j.roe@example.com"], phone: ["+1 415 555 0177"], rating: 4, address: addr("402 Pine St", "Oakland", "CA", "94612"), dob: "1958-09-30", ssn: sealed("us-ssn", "530-21-1144"), acct: sealed("bank-account", "0071 4420 9931"), notes: "Owns a bakery. Needs a succession plan before he steps back in spring.", matter: ref(urnFor("m2")) }, 2),
  rec("marcus", { name: "Marcus Doe", role: "Client", email: ["marcus.doe@example.com"], phone: ["+1 415 555 0119"], rating: 3, address: addr("77 Alder Way", "Berkeley", "CA", "94704"), dob: "1988-02-03", ssn: sealed("us-ssn", "611-72-0098"), acct: sealed("bank-account", "0082 1190 3347"), notes: "Jane Doe's son. Successor trustee.", matter: ref(urnFor("m4")) }, 5),
  rec("priya", { name: "Priya Shah", role: "Client", email: ["priya.shah@example.com"], phone: ["+1 510 555 0164"], rating: 4, address: addr("9 Elm Ct", "Alameda", "CA", "94501"), dob: "1979-11-21", ssn: sealed("us-ssn", "544-90-3321"), acct: sealed("bank-account", "0093 5567 2210"), notes: "Updating a will after a move.", matter: ref(urnFor("m3")) }, 1),
  rec("lena", { name: "Lena Ortiz", role: "Vendor", email: ["lena@ortiznotary.example.com"], phone: ["+1 415 555 0123"], rating: 5, address: addr("2 Market St", "San Francisco", "CA"), notes: "Mobile notary. Signs same day.", matter: ref(urnFor("m5")) }, 9),
  rec("wen", { name: "Wen Lee", role: "Referrer", email: ["wen.lee@example.com"], phone: ["+1 415 555 0188"], rating: 4, address: addr("31 Oak Ave", "Daly City", "CA"), dob: "1970-06-08", ssn: sealed("us-ssn", "478-12-5509"), notes: "Refers clients from the community center.", matter: ref(urnFor("m6")) }, 12),
  rec("sam", { name: "Sam Okafor", role: "Friend", email: ["sam@example.com"], phone: ["+1 415 555 0101"], rating: 5, dob: "1984-07-14", notes: "Saturday hike. Bring the trail map." }, 4),
  rec("chen", { name: "Dr. Chen", role: "Vendor", email: ["office@chendental.example.com"], phone: ["+1 415 555 0166"], rating: 4, address: addr("55 Valencia St", "San Francisco", "CA"), notes: "Cleaning every six months. Next in November." }, 20),

  rec("m1", { title: "Doe estate plan", client: ref(urnFor("jane")), plan: "Both", situation: "Widowed, two adult children", assets: "House at 18 Larkin St, sale in November", pressure: "Fund the trust before the sale", fee: money(4800), stage: "Engagement", owner: who(WHO.alex, "harlow"), opened: "2026-09-08", closing: "2026-10-28", docs: file("Intake questionnaire.pdf") }, 0),
  rec("m2", { title: "Roe succession plan", client: ref(urnFor("john")), plan: "Trust", situation: "Owner of a bakery", assets: "Bakery building and equipment", pressure: "Steps back in spring", fee: money(6500), stage: "Engagement", owner: who(WHO.kit, "harlow"), opened: "2026-09-22", closing: "2026-11-14", docs: file("Engagement letter (draft).docx") }, 1),
  rec("m3", { title: "Shah will update", client: ref(urnFor("priya")), plan: "Will", situation: "Moved states", assets: "Condo in Alameda", pressure: "None", fee: money(1200), stage: "Intake", owner: who(WHO.kit, "harlow"), opened: "2026-10-01", closing: "2026-10-20" }, 2),
  rec("m4", { title: "Doe trust, Marcus", client: ref(urnFor("marcus")), plan: "Trust", situation: "Successor trustee", assets: "Family trust", pressure: "Signing next week", fee: money(3900), stage: "Signing", owner: who(WHO.chris, "harlow"), opened: "2026-08-14", closing: "2026-10-09", docs: file("Trust agreement v4.pdf") }, 3),
  rec("m5", { title: "Ortiz power of attorney", client: ref(urnFor("lena")), plan: "Will", situation: "Single, no children", assets: "None in play", pressure: "None", fee: money(800), stage: "Funding", owner: who(WHO.alex, "harlow"), opened: "2026-07-30", closing: "2026-10-05", docs: file("POA signed.pdf") }, 6),
  rec("m6", { title: "Lee trust amendment", client: ref(urnFor("wen")), plan: "Trust", situation: "Amending beneficiaries", assets: "Rental property", pressure: "None", fee: money(2100), stage: "Closed", owner: who(WHO.chris, "harlow"), opened: "2026-08-02", closing: "2026-09-18", docs: file("Amendment signed.pdf") }, 15),

  rec("p1", { title: "Vyre site", stage: "Build", owner: who(WHO.alex, "mine"), priority: "High", budget: money(8000), due: "2026-10-31", notes: "Landing page and the setup guide." }, 1),
  rec("p2", { title: "Garden shed", stage: "Plan", owner: who(WHO.alex, "mine"), priority: "Low", budget: money(1500), due: "2026-11-20" }, 8),
  rec("p3", { title: "Intake form refresh", stage: "Review", owner: who(WHO.kit, "harlow"), priority: "Normal", budget: money(2400), due: "2026-10-14", brief: file("Intake form notes.pdf") }, 2),

  rec("t1", { title: "Lisbon in spring", stage: "Booked", where: addr("", "Lisbon", "", "", "Portugal"), leaves: "2026-10-18", returns: "2026-10-26", budget: money(3200), with: who(WHO.alex, "mine"), booking: sealed("free", "KQ7R4M", true), notes: "Window seat, **vegetarian** meals." }, 4),
  rec("t2", { title: "Cabin weekend", stage: "Dreaming", where: addr("", "Lake Tahoe", "CA"), leaves: "2026-11-07", returns: "2026-11-09", budget: money(700), with: who(WHO.chris, "mine") }, 10),

  rec("tp1", { name: "Welcome email", kind: "Email", body: "Thank you for choosing **Harlow Legal**. Here is what happens next.", owner: who(WHO.kit, "harlow"), uses: 41, updated: "2026-09-30" }, 3),
  rec("tp2", { name: "Engagement letter", kind: "Letter", body: "This letter confirms the terms of our work together.", owner: who(WHO.chris, "harlow"), uses: 18, updated: "2026-09-12" }, 20),
  rec("tp3", { name: "Intake questionnaire", kind: "Form", body: "Name, family situation, assets, time pressure.", owner: who(WHO.juno, "harlow"), uses: 57, updated: "2026-08-21" }, 40),
];

/** urn -> { title, type }, for ref and link fields. @param {import("./contracts.js").TypeDefinition[]} types @param {{ [name: string]: { titleField: string } }} views */
export function linkIndex(types, views, list = rows) {
  /** @type {Record<string, { title: string, type: string }>} */
  const out = {};
  for (const r of list) { const t = types.find(x => x.name === r.type); if (t) out[r.urn] = { title: String(r.data[views[t.name]?.titleField || "title"] ?? r.id), type: r.type }; }
  return out;
}

/** One event, in the kernel's envelope, for the lab's timelines. */
function ev(/** @type {number} */ n, /** @type {string} */ subject, /** @type {string} */ actor, /** @type {string} */ what, /** @type {number} */ at, /** @type {string} */ [why] = "") {
  const space = subject.split("/")[2], kind = actor === WHO.alex || actor === WHO.chris ? "person" : "agent";
  const data = { what, ...(why ? { why } : {}) };
  return /** @type {EventEnvelope} */ ({ v: 1, id: minted(at, n), seq: n, space, type: "record.updated", sv: 1, time: at, received_at: at, actor: `${kind}:${actor}@${space}`,
    chain: [{ actor: { kind, id: actor, space }, entered_by: "surface" }], subject, trust: "member", source_spaces: [space], vis: "space", red: "internal", data, commit: digest(what), prev: "genesis", hash: digest(`${n}${what}`) });
}
const T = (/** @type {number} */ d) => T0 - d * 3600_000;
/** The timeline of a few records, by urn. @type {Record<string, EventEnvelope[]>} */
export const events = {
  [urnFor("m1")]: [
    ev(1, urnFor("m1"), WHO.alex, "Stage changed from Intake to Engagement", T(3), ["Jane Doe signed the intake form"]),
    ev(2, urnFor("m1"), WHO.kit, "Drafted the engagement letter", T(30)),
    ev(3, urnFor("m1"), WHO.chris, "Approved the Welcome email", T(54), ["Reviewed before it left the space"]),
    ev(4, urnFor("m1"), WHO.alex, "Opened by Flow On payment", T(24 * 25)),
  ],
  [urnFor("jane")]: [
    ev(5, urnFor("jane"), WHO.alex, "Moved the matter to Engagement", T(3)),
    ev(6, urnFor("jane"), WHO.kit, "Added a note with 3 sources", T(31)),
    ev(7, urnFor("jane"), WHO.chris, "Revealed the SSN with Face ID", T(80), ["Prepared the trust funding forms"]),
  ],
};
