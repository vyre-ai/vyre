import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../../kernel/gateway/index.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createEventLog } from "../../kernel/core/events.js";
import { createChainBuilder } from "../../kernel/core/chain.js";
import { CORE_TYPES } from "../core-types.js";
import { logCommunication, findContact, addContactPoint, timelineOf, normalizeEmail, normalizePhone } from "./log.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: p => p === OWNER || p === "per_bob" });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const grant = { id: "gr_0001", space: SPACE, subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: SPACE } }, actions: ["records.*", "records.define", "events.read"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: { kind: "person", id: OWNER, space: SPACE }, source: "test", status: "active", created_at: 0 };

async function rig() {
  const log = createEventLog({ space: SPACE, clock });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, hasPresenceSession: () => true,
    grants: { forSubject: a => (a.kind === "person" && a.id === OWNER ? [grant] : []), get: id => (id === grant.id ? grant : undefined) }, members: { has: a => a.id === OWNER } });
  await gw.records.define(owner(), { add_types: [...CORE_TYPES] });
  return { kernel: gw };
}

test("normalize: addresses and numbers are stored one way", () => {
  assert.equal(normalizeEmail("  Jane.Doe@Harlow.Test "), "jane.doe@harlow.test");
  assert.equal(normalizeEmail("<a@b.test>"), "a@b.test");
  assert.equal(normalizePhone("+1 (555) 010-0100"), "+15550100100");
  assert.equal(normalizePhone("0044 20 7946 0000"), "+442079460000");
  assert.equal(normalizePhone("555 0100"), "5550100");
});

test("logging: one communication per source item, who was on it as written, contacts found by main email or phone, unknown people only in the text", async () => {
  const { kernel } = await rig(), R = kernel.records;
  const jane = await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test", phone: "+15550100" });
  const item = { kind: "email", direction: "inbound", at: "2026-10-01T09:00:00.000Z", subject: "Hello", excerpt: "Hi there", source_key: "gmail:abc", mailbox: "alex@harlow.test",
    people: [{ address: "Jane@Harlow.Test", how: "from" }, { address: "alex@harlow.test", how: "to" }, { address: "+1 555 0100", how: "cc" }] };
  const first = await logCommunication(kernel, owner(), item);
  assert.equal(first.created, true);
  assert.deepEqual([first.communication.data.from, first.communication.data.to, first.communication.data.cc], ["jane@harlow.test", "alex@harlow.test", "+15550100"], "who was on it, as written, one way");
  assert.deepEqual(first.communication.data.contacts.map((/** @type {any} */ c) => c.urn), [jane.urn], "Jane once, by her email and her phone; the mailbox matches no contact");
  assert.deepEqual(first.participants.map(p => [p.address, p.contact === jane.urn]), [["jane@harlow.test", true], ["alex@harlow.test", false], ["+15550100", true]], "a handle is matched by its main email or phone, written one way; a stranger keeps the address");
});

test("logging twice makes one communication and fills in what was missing; createUnknown makes the contact once", async () => {
  const { kernel } = await rig(), R = kernel.records;
  const jane = await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const base = { kind: "meeting", at: "2026-10-02T10:00:00.000Z", source_key: "gcal:m1", people: [{ address: "jane@harlow.test", how: "attendee" }] };
  const a = await logCommunication(kernel, owner(), base);
  const b = await logCommunication(kernel, owner(), { ...base, people: [...base.people, { address: "new@person.test", how: "attendee", name: "New Person" }], createUnknown: true });
  assert.equal(b.created, false);
  assert.equal(b.communication.id, a.communication.id);
  assert.equal((await R.query(owner(), "communication", { page: { limit: 10 } })).rows.length, 1);
  assert.equal((await R.get(owner(), "communication", a.communication.id)).data.contacts.length, 2, "Jane was linked once, and the new contact was added");
  const made = await findContact(kernel, owner(), "new@person.test");
  assert.ok(made, "a contact was made for the unknown person");
  assert.equal((await R.get(owner(), "contact", made.id)).data.name, "New Person");
  await logCommunication(kernel, owner(), { ...base, people: [{ address: "new@person.test", how: "attendee" }], createUnknown: true });
  assert.equal((await R.query(owner(), "contact", { page: { limit: 10 } })).rows.length, 2, "not a second contact");
  // the timeline of a contact: newest first
  await logCommunication(kernel, owner(), { kind: "email", at: "2026-10-03T09:00:00.000Z", source_key: "gmail:z", subject: "Later", people: [{ address: "jane@harlow.test", how: "to" }] });
  const tl = await timelineOf(kernel, owner(), jane.urn);
  assert.deepEqual(tl.map(x => x.communication.data.source_key), ["gmail:z", "gcal:m1"]);
});

test("who may see a communication follows the attributes it was logged with: a grant on that project sees it, one without does not", async () => {
  const log = createEventLog({ space: SPACE, clock });
  const bob = { kind: "person", id: "per_bob", space: SPACE };
  const g = (id, subject, actions, extra = {}) => ({ id, space: SPACE, subject: { kind: "actor", actor: subject }, actions, action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*`, ...extra }, conditions: {}, issuer: { kind: "person", id: OWNER, space: SPACE }, source: "test", status: "active", created_at: 0 });
  const grants = [grant, g("gr_bob1", bob, ["records.read"], { where: [{ attr: "project", op: "eq", value: "shared" }] })];
  const kernel = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, hasPresenceSession: () => true,
    grants: { forSubject: a => grants.filter(x => x.subject.actor.kind === a.kind && x.subject.actor.id === a.id), get: id => grants.find(x => x.id === id) }, members: { has: a => a.id === OWNER || a.id === "per_bob" } });
  await kernel.records.define(owner(), { add_types: [...CORE_TYPES] });
  await logCommunication(kernel, owner(), { kind: "email", at: "2026-10-01T09:00:00.000Z", source_key: "gmail:shared", mailbox: "info@harlow.test", attrs: { project: "shared" }, people: [{ address: "a@x.test", how: "from" }] });
  await logCommunication(kernel, owner(), { kind: "email", at: "2026-10-01T10:00:00.000Z", source_key: "gmail:private", mailbox: "alex@harlow.test", attrs: { project: "alex" }, people: [{ address: "a@x.test", how: "from" }] });
  const bobChain = chains.fromFacts({ kind: "device", device_key_id: "d-bob", person: "per_bob", path: "direct" });
  assert.deepEqual((await kernel.records.query(bobChain, "communication", { page: { limit: 10 } })).rows.map(r => r.data.source_key), ["gmail:shared"]);
});

test("contact points: a further address is found, unique across main addresses and points, and a message to it logs on that contact", async () => {
  const { kernel } = await rig(), R = kernel.records;
  const jane = await R.create(owner(), "contact", { name: "Jane Doe", email: "jane@harlow.test" });
  const bob = await R.create(owner(), "contact", { name: "Bob Roe", email: "bob@harlow.test" });
  const a = await addContactPoint(kernel, owner(), jane.urn, " Jane.D@Old.Test ", "old work");
  assert.equal(a.created, true);
  assert.equal((await addContactPoint(kernel, owner(), jane.urn, "jane.d@old.test")).created, false, "a repeat for the same contact is the same point");
  assert.equal((await addContactPoint(kernel, owner(), bob.urn, "jane.d@old.test")).taken_by, jane.urn, "another contact's point is refused");
  assert.equal((await addContactPoint(kernel, owner(), bob.urn, "jane@harlow.test")).taken_by, jane.urn, "another contact's main address is refused");
  assert.equal((await addContactPoint(kernel, owner(), jane.urn, "+1 555 0199")).created, true, "a phone number too");
  assert.equal((await findContact(kernel, owner(), "JANE.D@old.test")).urn, jane.urn);
  assert.equal((await findContact(kernel, owner(), "+15550199")).urn, jane.urn);
  await assert.rejects(() => R.create(owner(), "contact_point", { contact: { urn: bob.urn }, kind: "email", address: "jane.d@old.test" }), { code: "unique_violation" }, "the store enforces it too");
  const r = await logCommunication(kernel, owner(), { kind: "email", at: "2026-10-04T09:00:00.000Z", source_key: "gmail:pt", people: [{ address: "Jane.D@Old.Test", how: "from" }] });
  assert.equal(r.participants[0].contact, jane.urn);
});
