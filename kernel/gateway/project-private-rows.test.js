// Per-record privacy for custom record types. A row of a custom type that links to a project (a link field to the core Project, or to a Kit's own type that holds work, such as a matter) is
// readable only by that project's team (its owner and its team-member rows), an owner or an admin, as projects, tasks and files already are. Every way a row can be read is asked: get, list (and its
// cursor), search, a total, a computed total on the project, the records that link to a record, a reference, and the events about it. Real kernel, real members.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createKernel } from "../index.js";
import { canonical, sha256 } from "../core/canonical.js";
import { PROJECT, TEAM_MEMBER } from "../../records/core-types.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", ADMIN = "per_admin", BOB = "per_bob", DAN = "per_dan", EVE = "per_eve";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_payload") };
const MATTER = { name: "matter", label: "Matter", kind: "project", fields: [{ name: "title", kind: "text", label: "Title" },
  { name: "assets_total", kind: "number", label: "Assets total", computed: { over: { type: "asset", via: "matter", fn: "sum", field: "value" } } }] };
const ASSET = { name: "asset", label: "Asset", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "value", kind: "number", label: "Value" },
  { name: "matter", kind: "link", to: "matter", label: "Matter" }, { name: "project", kind: "link", to: "project", label: "Project" }] };
const NOTE = { name: "note", label: "Note", fields: [{ name: "text", kind: "text", label: "Text" }] };

async function rig() {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[ADMIN, "admin"], [BOB, "member"], [DAN, "member"], [EVE, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  await k.gateway.records.define(owner, { add_types: [PROJECT, TEAM_MEMBER, MATTER, ASSET, NOTE].map(t => ({ ...t, fields: t.fields.filter(f => f.name !== "client" && f.name !== "contact") })) });
  const R = k.gateway.records;
  const person = id => ({ actor: { kind: "person", id, space: SPACE } });
  const rivera = await R.create(owner, "project", { name: "Rivera", slug: "rivera", owner: person(BOB) });
  const other = await R.create(owner, "project", { name: "Other", slug: "other", owner: person(DAN) });
  // a matter is a record that holds work: its seats are team-member rows that point at it, and BOB made it
  const bob = id => k.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: id, path: "direct", session: "s" });
  const matter = await R.create(bob(BOB), "matter", { title: "Estate of Rivera" });
  await R.create(owner, "team-member", { name: "bob", actor: person(BOB), kind: "person", project: { urn: matter.urn } });
  const asset = (name, value, links) => R.create(owner, "asset", { name, value, ...links });
  const onMatter = await asset("House", 300, { matter: { urn: matter.urn } });
  const onProject = await asset("Boat", 50, { project: { urn: rivera.urn } });
  const onOther = await asset("Car", 20, { project: { urn: other.urn } });
  const loose = await asset("Coin", 1, {});
  return { k, owner, R, bob, rivera, other, matter, onMatter, onProject, onOther, loose, asset, person, dev: bob };
}
const code = p => p.then(() => null, e => e && e.code);

test("a member off the project cannot open, list, search, total or follow a link to its custom rows, and the count does not leak them", async () => {
  const { k, owner, R, dev, rivera, matter, onMatter, onProject, loose } = await rig();
  const ids = rows => rows.map(r => r.data.name).sort();
  // the team and staff
  assert.equal((await R.get(dev(BOB), "asset", onProject.id)).data.name, "Boat", "the project's owner opens it");
  assert.equal((await R.get(dev(BOB), "asset", onMatter.id)).data.name, "House", "the matter's seat opens a row linked to the matter");
  assert.deepEqual(ids((await R.query(owner, "asset", { page: { limit: 50 } })).rows), ["Boat", "Car", "Coin", "House"], "the owner reads all");
  assert.deepEqual(ids((await R.query(dev(ADMIN), "asset", { page: { limit: 50 } })).rows), ["Boat", "Car", "Coin", "House"], "an admin reads all");
  // a member who is not on the project
  assert.equal(await R.get(dev(EVE), "asset", onProject.id), null, "open: not found, not refused");
  assert.equal(await R.get(dev(EVE), "asset", onMatter.id), null);
  assert.equal((await R.get(dev(EVE), "asset", loose.id)).data.name, "Coin", "a row linked to nothing reads as ever");
  assert.deepEqual(ids((await R.query(dev(EVE), "asset", { page: { limit: 50 } })).rows), ["Coin"], "list");
  assert.deepEqual(ids((await R.query(dev(DAN), "asset", { page: { limit: 50 } })).rows), ["Car", "Coin"], "DAN owns Other: his row and the loose one");
  const found = await R.search(dev(EVE), { text: "House", types: ["asset"], page: { limit: 20 } });
  assert.equal(found.rows.length, 0, "search");
  assert.equal(await R.reference(dev(EVE), "asset", onProject.id), null, "a reference");
  const linked = await R.linked(dev(EVE), rivera.urn, { limit: 50 });
  assert.ok(!linked.rows.some(x => x.type === "asset"), "records that link here");
  const count = await R.aggregate(dev(EVE), "asset", { measures: [{ fn: "count" }, { fn: "sum", field: "value" }] });
  assert.deepEqual(count.map(r => r.values), [{ count: 1, "sum:value": 1 }], "a total counts only what she may read");
  assert.equal((await R.aggregate(owner, "asset", { measures: [{ fn: "count" }] }))[0].values.count, 4, "the owner's total is every row");
  // events about a hidden row are hidden too
  const seen = (await k.gateway.events.read(dev(EVE), {})).filter(e => String(e.subject).includes(`/asset/${onProject.id}`) || String(e.subject).includes(`/asset/${onMatter.id}`));
  assert.equal(seen.length, 0, "events");
  // a total on the matter, which she may read, counts only the rows she may read
  assert.equal((await R.get(owner, "matter", matter.id)).data.assets_total, 300, "the owner's total");
  assert.equal((await R.get(dev(BOB), "matter", matter.id)).data.assets_total, 300, "the seat's total");
  assert.equal((await R.get(dev(EVE), "matter", matter.id)).data.assets_total, 0, "a member off the matter gets no part of it");
});

test("a page never says more rows follow when the rest are rows the reader may not see", async () => {
  const { R, dev, rivera, owner, asset } = await rig();
  for (let i = 0; i < 6; i++) await asset(`Hidden ${i}`, 1, { project: { urn: rivera.urn } });
  const first = await R.query(dev(EVE), "asset", { page: { limit: 1 } });
  const names = []; let page = first;
  for (let i = 0; i < 20; i++) { names.push(...page.rows.map(r => r.data.name)); if (!page.next_cursor) break; page = await R.query(dev(EVE), "asset", { page: { limit: 1, cursor: page.next_cursor } }); }
  assert.deepEqual(names, ["Coin"], "she pages through the one row she may read and nothing else");
  assert.equal(page.next_cursor, undefined, "the last page has no cursor");
  assert.equal((await R.query(owner, "asset", { page: { limit: 50 } })).rows.length, 10);
});

test("a seat on the project opens its rows, and taking the seat away closes them", async () => {
  const { R, owner, dev, rivera, matter, onProject, onMatter, person } = await rig();
  assert.equal(await R.get(dev(EVE), "asset", onProject.id), null);
  const seat = await R.create(owner, "team-member", { name: "eve", actor: person(EVE), kind: "person", project: { urn: rivera.urn } });
  assert.equal((await R.get(dev(EVE), "asset", onProject.id)).data.name, "Boat", "on the project's team");
  assert.equal(await R.get(dev(EVE), "asset", onMatter.id), null, "not on the matter's");
  await R.create(owner, "team-member", { name: "eve", actor: person(EVE), kind: "person", project: { urn: matter.urn } });
  assert.equal((await R.get(dev(EVE), "asset", onMatter.id)).data.name, "House");
  await R.remove(owner, "team-member", seat.id, seat.version);
  assert.equal(await R.get(dev(EVE), "asset", onProject.id), null, "the seat is gone");
});

test("a member cannot change or remove a row she may not read, and files a row only under a project she is on", async () => {
  const { R, dev, onProject, onMatter, rivera, matter } = await rig();
  assert.equal(await code(R.update(dev(EVE), "asset", onProject.id, { value: 1 }, onProject.version)), "not_found", "update of a row she cannot read");
  assert.equal(await code(R.remove(dev(EVE), "asset", onProject.id, onProject.version)), "not_found", "remove");
  assert.equal(await code(R.create(dev(EVE), "asset", { name: "Planted", project: { urn: rivera.urn } })), "not_allowed", "a row under a project she is not on");
  assert.equal(await code(R.create(dev(EVE), "asset", { name: "Planted", matter: { urn: matter.urn } })), "not_allowed", "or a matter she is not on");
  assert.equal(await code(R.create(dev(EVE), "asset", { name: "Mine" })), null, "a row linked to nothing is hers to make");
  assert.equal(await code(R.create(dev(BOB), "asset", { name: "Pier", project: { urn: rivera.urn } })), null, "the project's owner files under it");
  assert.equal(await code(R.update(dev(BOB), "asset", onMatter.id, { value: 301 }, onMatter.version)), null, "the matter's seat changes its row");
});
