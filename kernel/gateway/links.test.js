import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "./index.js";
import { createMemoryStore } from "../store/memory.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { isUuid, timeOf, mintUuid } from "../core/ids.js";
import { CONTACT, LEAD } from "../conformance/suite.js";
import { deriveInverse, inversesOf, withInverses, swapLink, plural, snake } from "./links.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 3), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const agent = () => chains.fromFacts({ kind: "agent_session", agent: "kit", session: "s", thread: "t", vouched: true });
const actor = (kind, id) => ({ kind, id, space: SPACE });
let n = 0;
const G = (over = {}) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space: SPACE, subject: { kind: "actor", actor: actor("person", OWNER) }, actions: ["records.*", "records.define", "events.read"], action_set_version: 9, resource: { prefix: `vyre://${SPACE}/*/*` }, conditions: {}, issuer: actor("person", OWNER), source: "test", status: "active", created_at: 0, ...over });

function rig({ grants = [G()], store = createMemoryStore({ clock }), attrs, members = [], ...cfg } = {}) {
  const log = createEventLog({ space: SPACE, clock });
  const all = new Map(grants.map(g => [g.id, g]));
  const known = new Set([`person:${OWNER}`, ...members]);
  const gw = createGateway({
    space: SPACE, store, log, chains, clock, attrs,
    grants: { forSubject: a => [...all.values()].filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: id => all.get(id) },
    members: { has: a => known.has(`${a.kind}:${a.id}`) },
    hasPresenceSession: () => true, ...cfg,
  });
  return { gw, log, store, r: gw.records };
}

const u = (type, id) => `vyre://${SPACE}/${type}/${id}`;
const MATTER = { name: "matter", label: "Matter", fields: [
  { name: "title", kind: "text", label: "Title" },
  { name: "client", kind: "link", label: "Client", to: "contact" },
  { name: "referrer", kind: "link", label: "Referrer", to: "contact" },
  { name: "parties", kind: "link", label: "Parties", to: "contact", many: true },
  { name: "about", kind: "link", label: "About" },
] };
const typeOf = async (rg, name) => (await rg.store.types()).find(t => t.name === name);

test("links: a link to a type gets the plural of its source type as the named inverse, a second link to the same type adds the field, and a link to any record has none", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, MATTER] });
  const m = await typeOf(rg, "matter");
  const inv = Object.fromEntries(m.fields.filter(f => f.kind === "link").map(f => [f.name, f.inverse]));
  assert.deepEqual(inv.client, { name: "matters", label: "Matters" });
  assert.deepEqual(inv.referrer, { name: "matters_referrer", label: "Matters (Referrer)" });
  assert.deepEqual(inv.parties, { name: "matters_parties", label: "Matters (Parties)" });
  assert.equal(inv.about, undefined, "a link to any record has no inverse");
  const shown = await rg.r.inverses(owner());
  assert.deepEqual(shown.contact.map(i => [i.name, i.from_type, i.from_field, i.many]).sort(), [["matters", "matter", "client", false], ["matters_parties", "matter", "parties", true], ["matters_referrer", "matter", "referrer", false]].sort());
});

test("links: an explicit inverse is kept, and a name taken on the target by a field or another inverse is refused", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, { ...LEAD }] });
  assert.deepEqual((await typeOf(rg, "lead")).fields.find(f => f.name === "contact").inverse, { name: "leads", label: "Leads" });
  const clash = { name: "deal", label: "Deal", fields: [{ name: "contact", kind: "link", label: "Contact", to: "contact", inverse: { name: "leads", label: "Leads" } }] };
  await assert.rejects(() => rg.r.define(owner(), { add_types: [clash] }), { code: "bad_input", message: /already has a field or an inverse called leads/ });
  const onField = { name: "deal", label: "Deal", fields: [{ name: "contact", kind: "link", label: "Contact", to: "contact", inverse: { name: "name", label: "Deals" } }] };
  await assert.rejects(() => rg.r.define(owner(), { add_types: [onField] }), { code: "bad_input" });
  const noTarget = { name: "deal", label: "Deal", fields: [{ name: "x", kind: "link", label: "X", to: "nope" }] };
  await assert.rejects(() => rg.r.define(owner(), { add_types: [noTarget] }), { code: "bad_input", message: /links to nope, which is not a type here/ });
  const badMany = { name: "deal", label: "Deal", fields: [{ name: "x", kind: "link", label: "X", many: true }] };
  await assert.rejects(() => rg.r.define(owner(), { add_types: [badMany] }), { code: "bad_input", message: /cannot be a list/ });
  await assert.rejects(() => rg.r.define(owner(), { add_types: [{ name: "deal", label: "Deal", fields: [{ name: "t", kind: "text", label: "T", many: true }] }] }), { code: "bad_input" });
});

test("links: a link names a live record of its type; the gateway refuses a missing, removed, other-type or other-space target, and a list never names a record twice", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, MATTER] });
  const c = await rg.r.create(owner(), "contact", { name: "Jane" });
  const d = await rg.r.create(owner(), "contact", { name: "Dan" });
  const ok = await rg.r.create(owner(), "matter", { title: "m", client: { urn: c.urn }, parties: [{ urn: c.urn }, { urn: d.urn }] });
  assert.deepEqual(ok.data.parties.map(x => x.urn), [c.urn, d.urn]);
  await assert.rejects(() => rg.r.create(owner(), "matter", { title: "x", client: { urn: u("contact", mintUuid()) } }), { code: "bad_input", message: /does not exist/ });
  await assert.rejects(() => rg.r.create(owner(), "matter", { title: "x", client: { urn: u("matter", ok.id) } }), { code: "bad_input", message: /links to contact, not matter/ });
  await assert.rejects(() => rg.r.create(owner(), "matter", { title: "x", client: { urn: `vyre://spc_bbbbbbbbbbbb/contact/${c.id}` } }), { code: "bad_input" });
  await assert.rejects(() => rg.r.create(owner(), "matter", { title: "x", parties: [{ urn: c.urn }, { urn: c.urn }] }), { message: /names a record twice/ });
  await assert.rejects(() => rg.r.create(owner(), "matter", { title: "x", parties: { urn: c.urn } }), { message: /must be a list/ });
  await rg.r.remove(owner(), "contact", d.id, 1);
  await assert.rejects(() => rg.r.update(owner(), "matter", ok.id, { parties: [{ urn: d.urn }] }, 1), { code: "bad_input", message: /does not exist/ });
  // a link to any record may name any live record of the Space
  const any = await rg.r.create(owner(), "matter", { title: "a", about: { urn: ok.urn } });
  assert.equal(any.data.about.urn, ok.urn);
  // updating a field that is not a link reads no target
  assert.equal((await rg.r.update(owner(), "matter", ok.id, { title: "renamed" }, 1)).version, 2);
});

test("links: linked() lists the records that link to one through every field, one-to-many and many-to-many, each with its inverse's name", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, MATTER] });
  const c = await rg.r.create(owner(), "contact", { name: "Jane" });
  const d = await rg.r.create(owner(), "contact", { name: "Dan" });
  const m1 = await rg.r.create(owner(), "matter", { title: "m1", client: { urn: c.urn }, parties: [{ urn: c.urn }, { urn: d.urn }] });
  const m2 = await rg.r.create(owner(), "matter", { title: "m2", referrer: { urn: c.urn }, parties: [{ urn: d.urn }] });
  const got = await rg.r.linked(owner(), c.urn);
  const seen = got.rows.map(x => [x.record.id, x.field, x.inverse && x.inverse.name]).sort();
  assert.deepEqual(seen, [[m1.id, "client", "matters"], [m1.id, "parties", "matters_parties"], [m2.id, "referrer", "matters_referrer"]].sort());
  const dan = await rg.r.linked(owner(), d.urn, { field: "parties" });
  assert.deepEqual(dan.rows.map(x => x.record.id).sort(), [m1.id, m2.id].sort());
});

test("links: merging two records moves a list link's entry without a repeat, and unmerge puts it back", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, MATTER] });
  const a = await rg.r.create(owner(), "contact", { name: "Jane" });
  const b = await rg.r.create(owner(), "contact", { name: "J." });
  const both = await rg.r.create(owner(), "matter", { title: "both", parties: [{ urn: a.urn }, { urn: b.urn }] });
  const onlyB = await rg.r.create(owner(), "matter", { title: "onlyB", client: { urn: b.urn }, parties: [{ urn: b.urn }] });
  const res = await rg.r.merge(owner(), "contact", a.id, b.id);
  assert.equal(res.relinked, 3);
  assert.deepEqual((await rg.r.get(owner(), "matter", both.id)).data.parties.map(x => x.urn), [a.urn], "no entry twice");
  assert.deepEqual((await rg.r.get(owner(), "matter", onlyB.id)).data.parties.map(x => x.urn), [a.urn]);
  assert.equal((await rg.r.get(owner(), "matter", onlyB.id)).data.client.urn, a.urn);
  await rg.r.unmerge(owner(), res.merge_id);
  assert.equal((await rg.r.get(owner(), "matter", onlyB.id)).data.client.urn, b.urn);
  assert.deepEqual((await rg.r.get(owner(), "matter", onlyB.id)).data.parties.map(x => x.urn), [b.urn]);
});

test("links: the pure parts: plural, snake, the default inverse in a fixed order, and swapLink", () => {
  assert.deepEqual([plural("Lead"), plural("Company"), plural("Address"), plural("Day")], ["Leads", "Companies", "Addresses", "Days"]);
  assert.equal(snake("Matters (Referrer)"), "matters_referrer");
  const defs = [{ name: "b", label: "B", fields: [{ name: "t", kind: "link", label: "T", to: "t" }] }, { name: "a", label: "A", fields: [{ name: "t", kind: "link", label: "T", to: "t" }] }, { name: "t", label: "T", fields: [] }];
  assert.deepEqual(inversesOf(defs).get("t").map(i => [i.name, i.from_type]), [["as", "a"], ["bs", "b"]], "worked out in type-name order, every time");
  assert.deepEqual(swapLink({ many: true }, [{ urn: "x" }, { urn: "y" }], "x", "y"), [{ urn: "y" }]);
  assert.deepEqual(swapLink({}, { urn: "x" }, "x", "y"), { urn: "y" });
  assert.equal(deriveInverse({ name: "a", label: "A" }, { name: "t", label: "T" }, () => true), null);
  void withInverses;
});

test("links: a list link takes add and remove in an update: worked out against the stored list, each record once, and checked like any list", async () => {
  const rg = rig();
  await rg.r.define(owner(), { add_types: [CONTACT, MATTER] });
  const [a, b, c] = [await rg.r.create(owner(), "contact", { name: "A" }), await rg.r.create(owner(), "contact", { name: "B" }), await rg.r.create(owner(), "contact", { name: "C" })];
  const m = await rg.r.create(owner(), "matter", { title: "m", parties: [{ urn: a.urn }] });
  const added = await rg.r.update(owner(), "matter", m.id, { parties: { add: [{ urn: b.urn }, { urn: a.urn }] } }, 1);
  assert.deepEqual(added.data.parties.map(x => x.urn), [a.urn, b.urn], "one added, the repeat ignored");
  const both = await rg.r.update(owner(), "matter", m.id, { parties: { add: [{ urn: c.urn }], remove: [{ urn: a.urn }] } }, 2);
  assert.deepEqual(both.data.parties.map(x => x.urn), [b.urn, c.urn]);
  assert.deepEqual((await rg.r.get(owner(), "matter", m.id)).data.parties.map(x => x.urn), [b.urn, c.urn], "what the store holds");
  await assert.rejects(() => rg.r.update(owner(), "matter", m.id, { parties: { add: [{ urn: u("contact", mintUuid()) }] } }, 3), { code: "bad_input", message: /does not exist/ });
  await assert.rejects(() => rg.r.update(owner(), "matter", m.id, { client: { add: [{ urn: a.urn }] } }, 3), { code: "bad_input", message: /not a list link/ });
  await assert.rejects(() => rg.r.update(owner(), "matter", m.id, { parties: { add: [{ urn: a.urn }], set: [] } }, 3), { code: "bad_input", message: /only keys/ });
  await assert.rejects(() => rg.r.update(owner(), "matter", m.id, { parties: { add: "x" } }, 3), { code: "bad_input" });
  const emptied = await rg.r.update(owner(), "matter", m.id, { parties: { remove: [{ urn: b.urn }, { urn: c.urn }] } }, 3);
  assert.deepEqual(emptied.data.parties, []);
});
