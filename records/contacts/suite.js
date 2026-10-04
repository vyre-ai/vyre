// records/contacts/suite.js: the conformance cases for the contacts block. They run on every store (the SQLite store and the Twenty store over its fake) against the real
// in-memory kernel, `createKernel`, with the real gateway: a case passes only if it passes through authorize, the log and the store's own checks.
// A feature that works on one store only is not done.
import { createKernel } from "../../kernel/index.js";
import { CORE_TYPES } from "../core-types.js";
import { createContacts, extendType, mergeKitTypes } from "./index.js";
import { toKernelKit } from "../kit-adapter.js";
import { mintUuid } from "../../kernel/core/ids.js";

export const SPACE = "harlow";
const OWNER = "alex";

const ROLE_PROSPECT = { name: "prospect", label: "Prospect", role: { subject: ["contact"] }, fields: [
  { name: "title", kind: "text", label: "Title" },
  { name: "contact", kind: "link", label: "Contact", to: "contact", required: true },
  { name: "stage", kind: "stage", label: "Stage", options: ["New", "Screening", "Lost"] },
], stages: [{ name: "New" }, { name: "Screening" }, { name: "Lost" }] };
const ROLE_CLIENT = { name: "client", label: "Client", role: { subject: ["contact", "organization"] }, fields: [
  { name: "title", kind: "text", label: "Title" },
  { name: "who", kind: "link", label: "Who", to: ["contact", "organization"], required: true },
  { name: "stage", kind: "stage", label: "Stage", options: ["Active", "Past"] },
], stages: [{ name: "Active" }, { name: "Past" }] };
const ROLE_AMBASSADOR = { name: "ambassador", label: "Ambassador", role: { subject: ["contact"] }, fields: [
  { name: "title", kind: "text", label: "Title" },
  { name: "contact", kind: "link", label: "Contact", to: "contact", required: true },
] };

/** @param {any} store a fresh empty store */
export async function rig(store) {
  const clock = (() => { let t = 1_800_000_000_000; return () => (t += 1000); })();
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), store, clock });
  const o = k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });
  const r = k.gateway.records;
  await r.define(o, { add_types: [...CORE_TYPES] });
  const contacts = createContacts({ space: SPACE, records: r, types: () => store.types() });
  const person = async (name, ...addresses) => {
    const c = await r.create(o, "contact", { full_name: name });
    for (const a of addresses) await contacts.addPoint(o, { owner: c, value: a });
    return c;
  };
  return { k, o, r, contacts, store, person };
}

/**
 * @param {() => Promise<any>} make a fresh empty store
 * @param {{ test: (name: string, fn: () => Promise<void>) => void, assert: any }} t node:test and node:assert/strict
 * @param {string} [label]
 */
export function contactsSuite(make, { test, assert }, label = "store") {
  const T = (/** @type {string} */ name, /** @type {(x: any) => Promise<void>} */ fn) => test(`contacts (${label}): ${name}`, async () => { await fn(await rig(await make())); });
  const code = (/** @type {string} */ c) => (/** @type {any} */ e) => { assert.equal(e && e.code, c, `expected ${c}, got ${e && e.code}: ${e && e.message}`); return true; };
  const urn = (/** @type {any} */ rec) => rec.urn;

  T("a datetime is one exact UTC instant on every store, and anything else is refused the same way", async ({ r, o }) => {
    const bad = ["2026-10-01T10:00:00Z", "2026-10-01T10:00:00+02:00", "2026-10-01", "2026-10-01T10:00", "yesterday", "2026-13-40T10:00:00.000Z"];
    const messages = new Set();
    for (const v of bad) await assert.rejects(() => r.create(o, "communication", { kind: "email", direction: "inbound", occurred_at: v }), (e) => { messages.add(e.message); return e.code === "invalid" || e.code === "bad_input"; }, v);
    assert.equal(messages.size <= 2, true, "one wording for the instant rule (an unparseable date may differ)");
    assert.ok(await r.create(o, "communication", { kind: "email", direction: "inbound", occurred_at: "2026-10-01T10:00:00.000Z" }));
  });

  // ---- core types --------------------------------------------------------------------------------
  T("the core people types exist, and a unique field is reported as indexed", async ({ store }) => {
    const names = (await store.types()).map((t) => t.name);
    for (const n of ["contact", "organization", "contact-point", "communication", "communication-party"]) assert.ok(names.includes(n), `${n} is a core type`);
    const d = await store.describe("contact-point");
    assert.equal(d.fields.find((f) => f.name === "value").indexed, true);
    assert.equal(d.fields.find((f) => f.name === "kind").indexed ?? false, false);
  });

  T("a contact-point holds the normal form: stores refuse any other spelling, and a link to the wrong kind of record", async ({ store, r, o, person }) => {
    const c = await person("Jane Doe");
    const link = { urn: urn(c) };
    await assert.rejects(() => r.create(o, "contact-point", { kind: "email", value: "Jane@Example.com", owner: link }), code("invalid"));
    await assert.rejects(() => r.create(o, "contact-point", { kind: "phone", value: "(555) 123-4567", owner: link }), code("invalid"));
    await assert.rejects(() => r.create(o, "contact-point", { kind: "email", value: "jane@example.com" }), code("invalid"), "the owner is required");
    const comm = await r.create(o, "communication", { kind: "email", direction: "inbound", occurred_at: "2026-10-01T10:00:00.000Z" });
    await assert.rejects(() => r.create(o, "contact-point", { kind: "email", value: "jane@example.com", owner: { urn: urn(comm) } }), code("invalid"), "a link may only point at the types it names");
    await assert.rejects(() => store.create("contact-point", mintUuid(), { kind: "email", value: "JANE@example.com", owner: link }), code("invalid"), "the store itself refuses it, not only the gateway");
    assert.ok(await r.create(o, "contact-point", { kind: "email", value: "jane@example.com", owner: link }));
  });

  T("one address is one record in the Space: same owner is a no-op, another owner is refused, a race makes one, a removed point frees the address", async ({ r, o, contacts, person }) => {
    const a = await person("Jane Doe"), b = await person("Joan Roe");
    const first = await contacts.addPoint(o, { owner: a, value: "  Jane Doe <Jane@Example.COM> ", label: "work", primary: true });
    assert.equal(first.created, true);
    assert.equal(first.point.data.value, "jane@example.com");
    assert.equal(first.point.data.kind, "email");
    const again = await contacts.addPoint(o, { owner: a, value: "JANE@example.com" });
    assert.deepEqual([again.created, again.point.id], [false, first.point.id]);
    await assert.rejects(() => contacts.addPoint(o, { owner: b, value: "jane@example.com" }), code("unique_violation"));
    // the same person's phone in three spellings is one point
    const p1 = await contacts.addPoint(o, { owner: a, value: "(555) 123-4567" });
    assert.equal(p1.point.data.value, "+15551234567");
    assert.equal((await contacts.addPoint(o, { owner: a, value: "+1 555 123 4567" })).created, false);
    assert.equal((await contacts.addPoint(o, { owner: a, value: "1-555-123-4567" })).created, false);
    // a race for one new address
    const settled = await Promise.allSettled([contacts.addPoint(o, { owner: a, value: "race@example.com" }), contacts.addPoint(o, { owner: b, value: "race@example.com" })]);
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, "exactly one writer wins");
    assert.equal(settled.filter((s) => s.status === "rejected")[0].reason.code, "unique_violation");
    // removing the point frees the address; restoring it then conflicts
    await r.remove(o, "contact-point", first.point.id, first.point.version);
    const taken = await contacts.addPoint(o, { owner: b, value: "jane@example.com" });
    assert.equal(taken.created, true);
    await assert.rejects(() => r.restore(o, "contact-point", first.point.id), code("unique_violation"));
    await assert.rejects(() => contacts.addPoint(o, { owner: a, value: "not an address" }), code("invalid"));
  });

  // ---- matching ----------------------------------------------------------------------------------
  T("matching: each participant address is one lookup on the unique contact-point value", async ({ o, r, contacts, person }) => {
    const jane = await person("Jane Doe", "jane@example.com", "+15551234567");
    const joan = await person("Joan Roe", "joan@example.com");
    const firm = await r.create(o, "organization", { name: "Northwind Bakery" });
    await contacts.addPoint(o, { owner: firm, value: "info@northwind.example" });
    const got = await contacts.matchParticipants(o, ["Jane Doe <JANE@example.com>", "joan@example.com", "jane@example.com", "(555) 123-4567", "info@northwind.example", "stranger@nowhere.example", "not an address", { address: "Joan@Example.com" }]);
    assert.deepEqual(got.contacts.sort(), [urn(jane), urn(joan)].sort(), "each contact once, in whatever spelling");
    assert.equal(got.matches.length, 4, "four distinct addresses matched: jane, joan, jane's phone, the firm");
    assert.deepEqual(got.matches.find((m) => m.value === "info@northwind.example").owner, urn(firm), "an organization's address is reported, and is not a contact");
    assert.deepEqual(got.unmatched, ["stranger@nowhere.example"]);
    assert.deepEqual(got.invalid, ["not an address"]);
    assert.deepEqual((await contacts.matchParticipants(o, [])).contacts, []);
  });

  // ---- roles -------------------------------------------------------------------------------------
  T("a role type must point at its subject through one required link", async ({ r, o, contacts }) => {
    const { checkRoleType } = await import("./roles.js");
    const bad = (def) => assert.throws(() => checkRoleType(def), code("invalid"));
    bad({ name: "x", role: { subject: [] }, fields: [] });
    bad({ name: "x", role: { subject: ["contact"] }, fields: [{ name: "t", kind: "text", label: "T" }] });
    bad({ name: "x", role: { subject: ["contact"] }, fields: [{ name: "c", kind: "link", to: "contact", label: "C" }] }); // not required
    bad({ name: "x", role: { subject: ["contact"] }, fields: [{ name: "c", kind: "link", to: "organization", label: "C", required: true }] }); // points elsewhere
    bad({ name: "x", role: { subject: ["contact"] }, fields: [{ name: "a", kind: "link", to: "contact", label: "A", required: true }, { name: "b", kind: "link", to: "contact", label: "B", required: true }] }); // which one?
    checkRoleType({ name: "x", role: { subject: ["contact"], field: "b" }, fields: [{ name: "a", kind: "link", to: "contact", label: "A", required: true }, { name: "b", kind: "link", to: "contact", label: "B", required: true }] });
    await assert.rejects(() => contacts.holders(o, "contact"), code("unknown_type"));
  });

  T("the roles of a contact and the contacts holding a role at a stage", async ({ r, o, contacts, person, store }) => {
    await r.define(o, { add_types: [ROLE_PROSPECT, ROLE_CLIENT, ROLE_AMBASSADOR] });
    const [jane, joan, sam] = [await person("Jane Doe"), await person("Joan Roe"), await person("Sam Poe")];
    const firm = await r.create(o, "organization", { name: "Northwind Bakery" });
    const pro = await r.create(o, "prospect", { title: "Jane, will", contact: { urn: urn(jane) }, stage: "New" });
    await r.update(o, "prospect", pro.id, { stage: "Screening" }, pro.version);
    const cl1 = await r.create(o, "client", { title: "Jane, trust", who: { urn: urn(jane) }, stage: "Active" });
    await r.create(o, "client", { title: "Joan, will", who: { urn: urn(joan) }, stage: "Past" });
    await r.create(o, "client", { title: "Northwind", who: { urn: urn(firm) }, stage: "Active" });
    await r.create(o, "ambassador", { title: "Sam", contact: { urn: urn(sam) } });
    await r.create(o, "prospect", { title: "Sam, will", contact: { urn: urn(sam) }, stage: "New" });

    const janes = await contacts.rolesOf(o, jane);
    assert.deepEqual(janes.map((x) => [x.role, x.stage]).sort(), [["client", "Active"], ["prospect", "Screening"]]);
    assert.ok(janes.every((x) => x.urn && x.record.data), "each row carries the role record");
    assert.deepEqual((await contacts.rolesOf(o, joan)).map((x) => x.role), ["client"]);
    assert.deepEqual((await contacts.rolesOf(o, firm)).map((x) => x.role), ["client"], "an organization holds roles too, and only the types that may point at it are asked");
    assert.deepEqual((await contacts.rolesOf(o, urn(sam))).map((x) => x.role).sort(), ["ambassador", "prospect"]);
    assert.deepEqual(await contacts.rolesOf(o, await person("Nobody")), []);

    const active = await contacts.holders(o, "client", { stage: "Active" });
    assert.deepEqual(active.rows.map((x) => x.subject.record.data.full_name ?? x.subject.record.data.name).sort(), ["Jane Doe", "Northwind Bakery"]);
    assert.deepEqual((await contacts.holders(o, "client", { stage: "Past" })).rows.map((x) => x.subject.record.data.full_name), ["Joan Roe"]);
    assert.deepEqual((await contacts.holders(o, "prospect", { stage: "New" })).rows.map((x) => x.subject.record.data.full_name), ["Sam Poe"]);
    assert.equal((await contacts.holders(o, "ambassador")).rows.length, 1);
    await assert.rejects(() => contacts.holders(o, "ambassador", { stage: "Active" }), code("invalid"), "a role with no stages has no stage to ask for");
    // a role ended is still a role the contact held
    await r.update(o, "client", cl1.id, { stage: "Past" }, cl1.version);
    assert.deepEqual((await contacts.rolesOf(o, jane)).find((x) => x.role === "client").stage, "Past");
    assert.equal((await contacts.holders(o, "client", { stage: "Active" })).rows.length, 1);
    // a role points at the types it names and no others
    const comm = await r.create(o, "communication", { kind: "call", direction: "none", occurred_at: "2026-10-01T10:00:00.000Z" });
    await assert.rejects(() => r.create(o, "prospect", { contact: { urn: urn(comm) } }), code("invalid"));
    await assert.rejects(() => r.create(o, "prospect", { title: "no one" }), code("invalid"));
    void store;
  });

  // ---- the link index ----------------------------------------------------------------------------
  T("a lookup by a link or a unique value answers exactly the live records, through every update, removal and restore", async ({ r, o, contacts, person }) => {
    await r.define(o, { add_types: [ROLE_AMBASSADOR] });
    const [a, b] = [await person("Ann"), await person("Bo")];
    const mk = (who, t) => r.create(o, "ambassador", { title: t, contact: { urn: urn(who) } });
    const x = await mk(a, "x"), y = await mk(a, "y"), z = await mk(b, "z");
    const held = async (who) => (await contacts.rolesOf(o, who)).map((q) => q.record.data.title).sort();
    assert.deepEqual(await held(a), ["x", "y"]);
    const moved = await r.update(o, "ambassador", y.id, { contact: { urn: urn(b) } }, y.version);
    assert.deepEqual([await held(a), await held(b)], [["x"], ["y", "z"]], "moving a link moves the lookup");
    const gone = await r.remove(o, "ambassador", x.id, x.version);
    assert.deepEqual(await held(a), [], "a removed record is not found");
    await r.restore(o, "ambassador", x.id);
    assert.deepEqual(await held(a), ["x"], "a restored record is found again");
    void moved; void gone; void z;
  });

  // ---- a Kit that names a core type extends it ---------------------------------------------------
  T("a Kit type with a core type's name adds its fields, keeps the core ones, and cannot retype or drop one; its sealed field stays sealed", async ({ r, o, store }) => {
    const estate = JSON.parse((await import("node:fs")).readFileSync(new URL("../kits/estate-planning/kit.json", import.meta.url), "utf8"));
    const kitContact = toKernelKit(estate).includes.types.find((t) => t.name === "contact");
    const held = new Map((await store.types()).map((t) => [t.name, t]));
    const before = await r.create(o, "contact", { full_name: "Before Kit" });
    const { add, change } = mergeKitTypes([kitContact], held);
    assert.deepEqual([add.length, change.length], [0, 1], "the contact is the core type, extended");
    const res = await r.define(o, { change_types: change });
    assert.equal(res.applied, true);
    const merged = (await store.types()).find((t) => t.name === "contact");
    const names = merged.fields.map((f) => f.name);
    for (const n of ["full_name", "job_title", "organization", "notes", "date_of_birth", "ssn", "stripe_customer"]) assert.ok(names.includes(n), `${n} is on the extended contact`);
    assert.equal(names.indexOf("full_name"), 0, "core fields keep their place");
    assert.equal(merged.fields.find((f) => f.name === "ssn").kind, "sealed");
    assert.deepEqual((await r.get(o, "contact", before.id)).data, { full_name: "Before Kit" }, "existing contacts are untouched");
    assert.equal((await r.define(o, { change_types: mergeKitTypes([kitContact], new Map((await store.types()).map((t) => [t.name, t]))).change })).applied, false, "applying it again changes nothing");
    await assert.rejects(() => r.create(o, "contact", { full_name: "Mallory", ssn: "123-45-6789" }), (e) => ["sealed_value_refused", "invalid"].includes(e.code), "a plain value for a sealed field is refused");
    assert.ok(await r.create(o, "contact", { full_name: "Real", ssn: { sealed: "us-ssn", ref: "sv_1", present: true, valid_format: true, set_at: 1 } }));
    // what a Kit may not do
    const core = CORE_TYPES.find((t) => t.name === "contact");
    assert.throws(() => extendType(core, { name: "contact", fields: [{ name: "full_name", kind: "number", label: "Full name" }] }), code("invalid"));
    assert.throws(() => extendType(core, { name: "contact", fields: [{ name: "organization", kind: "link", to: "contact", label: "Org" }] }), code("invalid"));
    assert.throws(() => extendType(CORE_TYPES.find((t) => t.name === "contact-point"), { name: "contact-point", fields: [{ name: "value", kind: "number", label: "V" }] }), code("invalid"));
    assert.deepEqual(extendType(core, { name: "contact", fields: [] }).fields, core.fields, "a Kit cannot remove a core field by leaving it out");
  });

  // ---- communications, many to many --------------------------------------------------------------
  T("a communication belongs to every contact on it and a contact has many communications, newest first, one page at a time", async ({ r, o, contacts, person }) => {
    const [jane, joan, sam] = [await person("Jane Doe", "jane@example.com"), await person("Joan Roe", "joan@example.com"), await person("Sam Poe")];
    const mk = (n, kind, day, extra = {}) => r.create(o, "communication", { subject: `m${n}`, kind, direction: "inbound", occurred_at: `2026-09-0${day}T10:00:00.000Z`, source: "gmail", source_id: `g${n}`, source_key: `gmail:g${n}`, ...extra });
    const m1 = await mk(1, "email", 1), m2 = await mk(2, "meeting", 2), m3 = await mk(3, "email", 3), m4 = await mk(4, "call", 4), m5 = await mk(5, "email", 5);
    for (const m of [m1, m2, m3, m4, m5]) await contacts.attachContact(o, m, jane, { address: "jane@example.com", participation: "from" });
    await contacts.attachContact(o, m3, joan, { participation: "cc" });
    await contacts.attachContact(o, m5, joan, { participation: "to" });
    const dup = await contacts.attachContact(o, m3, joan, { participation: "cc" });
    assert.equal(dup.created, false, "attaching the same pair again is a no-op");
    const racing = await Promise.all([contacts.attachContact(o, m1, sam), contacts.attachContact(o, m1, sam)]);
    assert.equal(racing.filter((x) => x.created).length, 1, "two writers attaching one pair make one row");

    const subjects = (rows) => rows.map((x) => x.communication.data.subject);
    const all = await contacts.communicationsOf(o, jane, { limit: 50 });
    assert.deepEqual(subjects(all.rows), ["m5", "m4", "m3", "m2", "m1"], "newest first");
    assert.equal(all.rows[0].participation, "from");
    const p1 = await contacts.communicationsOf(o, jane, { limit: 2 });
    assert.deepEqual(subjects(p1.rows), ["m5", "m4"]);
    assert.ok(p1.next_cursor);
    const p2 = await contacts.communicationsOf(o, jane, { limit: 2, cursor: p1.next_cursor });
    assert.deepEqual(subjects(p2.rows), ["m3", "m2"]);
    const p3 = await contacts.communicationsOf(o, jane, { limit: 2, cursor: p2.next_cursor });
    assert.deepEqual(subjects(p3.rows), ["m1"]);
    assert.equal(p3.next_cursor, undefined);
    assert.deepEqual(subjects((await contacts.communicationsOf(o, jane, { kind: "email" })).rows), ["m5", "m3", "m1"]);
    assert.deepEqual(subjects((await contacts.communicationsOf(o, joan)).rows), ["m5", "m3"]);
    assert.deepEqual((await contacts.contactsOf(o, m3)).map((x) => [x.contact.data.full_name, x.participation]).sort(), [["Jane Doe", "from"], ["Joan Roe", "cc"]]);
    assert.deepEqual((await contacts.contactsOf(o, m2)).map((x) => x.contact.data.full_name), ["Jane Doe"]);
    assert.deepEqual((await contacts.communicationsOf(o, await person("Quiet"))).rows, []);
    // a connector's re-delivery finds the communication it already logged, and the source key cannot be taken twice
    assert.equal((await contacts.findBySource(o, "gmail", "g3")).id, m3.id);
    assert.equal(await contacts.findBySource(o, "gmail", "nope"), null);
    await assert.rejects(() => mk(9, "email", 6, { source_id: "g3", source_key: "gmail:g3" }), code("unique_violation"));
    await assert.rejects(() => r.create(o, "communication-party", { key: "x", communication: { urn: urn(m1) }, contact: { urn: urn(m2) } }), code("invalid"), "a party links a communication to a contact, nothing else");
  });

  // ---- the whole thing: a message arrives --------------------------------------------------------
  T("a message arrives: its participants are matched by address and the communication lands on each contact's timeline", async ({ r, o, contacts, person }) => {
    const jane = await person("Jane Doe", "jane@example.com"), joan = await person("Joan Roe", "joan@example.com");
    const msg = { id: "g100", from: "Jane Doe <Jane@Example.com>", to: ["joan@example.com", "stranger@nowhere.example"], at: "2026-10-02T09:30:00.000Z", subject: "Trust documents", body: "Please find attached the draft trust." };
    const m = await contacts.matchParticipants(o, [msg.from, ...msg.to]);
    assert.deepEqual(m.contacts.sort(), [urn(jane), urn(joan)].sort());
    const comm = (await contacts.findBySource(o, "gmail", msg.id)) ?? await r.create(o, "communication", { subject: msg.subject, kind: "email", direction: "inbound", occurred_at: msg.at, excerpt: msg.body.slice(0, 200), source: "gmail", source_id: msg.id, source_key: `gmail:${msg.id}` });
    for (const x of m.matches) if (x.owner.split("/")[3] === "contact") await contacts.attachContact(o, comm, x.owner, { address: x.address, participation: x.value === "jane@example.com" ? "from" : "to" });
    assert.deepEqual((await contacts.communicationsOf(o, jane)).rows.map((x) => x.communication.data.subject), ["Trust documents"]);
    assert.deepEqual((await contacts.communicationsOf(o, joan)).rows.map((x) => x.participation), ["to"]);
    // the same message delivered again changes nothing
    const again = await contacts.findBySource(o, "gmail", msg.id);
    for (const x of m.matches) await contacts.attachContact(o, again, x.owner);
    assert.equal((await contacts.communicationsOf(o, jane)).rows.length, 1);
  });
}
