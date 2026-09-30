// @ts-check
// site.*: the store for what Vyre for Chrome learns. Fictional data only (a made-up GoHighLevel-like app).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import memory from "./index.js";

const ORIGIN = "https://app.ghl.example";
const AGENCY = "https://agency.example";
const NOW = Date.parse("2026-10-01T09:00:00Z");
const HOUR = 3_600_000;
const KEY = "sk-ant-" + "a1b2c3d4e5".repeat(4);
const AGENTS = [{ name: "juno", kind: "agent", projects: [] }];

async function world(t, settings = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  const tools = new Map(), emitted = [], clock = { now: NOW }, set = { ...settings };
  const ctx = {
    name: "memory", config: { me: { domains: [] } }, paths: {}, store: { db, migrate: () => {} }, log: () => {}, now: () => clock.now,
    events: { on: () => () => {}, emit: (type, payload) => emitted.push({ type, payload }), since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "settings.get" ? (set.__fail ? { error: { code: "failed", message: "hub down" } } : { data: { value: set[input.key] } }) : tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: AGENTS, projects: [] }),
    tool: (name, def) => tools.set(name, def),
    iqRunner: null, memoryRunner: null,
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  const call = async (name, input, caller = "deck", meta = {}) => {
    try { return { data: await tools.get(name).run(input, { ...meta, caller }) }; } catch (e) { return { error: /** @type {Error} */ (e).message, code: /** @type {any} */ (e).code || "failed" }; }
  };
  return { call, emitted, clock, set, db };
}
const patch = extra => ({
  names: ["GoHighLevel"], family: "ghl",
  ready: [{ kind: "landmark", arg: "nav" }],
  controls: [{ id: "c1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "create-workflow" } }],
  api: [{ id: "e_1", method: "GET", origin: "https://api.ghl.example", pathTemplate: "/workflows/{id}", query: {}, authKind: "bearer", statuses: [200], count: 2 }],
  ...extra,
});

test("site.put then site.get: the card comes back, and since_rev says not modified", async t => {
  const w = await world(t);
  const put = await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  assert.equal(put.data.accepted, true, JSON.stringify(put));
  assert.equal(put.data.rev, 1);
  const got = await w.call("memory.site.get", { origin: ORIGIN });
  assert.equal(got.data.origin.key, ORIGIN);
  assert.equal(got.data.origin.controls[0].id, "c1");
  assert.equal(got.data.origin.api[0].bodyShape, undefined, "the card has no bodies");
  assert.equal(got.data.rev, 1);
  assert.deepEqual((await w.call("memory.site.get", { origin: ORIGIN, since_rev: 1 })).data, { not_modified: true, rev: 1 });
  assert.equal((await w.call("memory.site.get", { origin: "https://unknown.example" })).data.origin, null);
  const parts = (await w.call("memory.site.get", { origin: ORIGIN, parts: ["api"] })).data;
  assert.equal(parts.origin.api[0].pathTemplate, "/workflows/{id}");
  assert.ok(w.emitted.some(e => e.type === "memory.site-learned" && e.payload.key === ORIGIN && e.payload.counts.controls === 1));
});

test("who may use it: the person's surfaces and first-party modules; never an agent or an added module", async t => {
  const w = await world(t);
  for (const who of ["deck", "cli", "capsule", "local", "tailnet:alex@example.com"]) assert.equal((await w.call("memory.site.get", { origin: ORIGIN }, who)).error, undefined, who);
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() }, "module:hands-chrome", { firstParty: true })).data.accepted, true);
  for (const [who, meta] of [["mcp:agent:juno", {}], ["mcp", {}], ["module:bakery", {}], ["module:bakery", { firstParty: false }], ["tailnet:agent:juno", {}], ["harness:agent:juno", {}]]) {
    assert.equal((await w.call("memory.site.get", { origin: ORIGIN }, who, meta)).code, "denied", who);
    assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() }, who, meta)).code, "denied", who);
  }
  for (const tool of ["memory.site.list", "memory.site.forget", "memory.site.restore"]) assert.equal((await w.call(tool, { key: ORIGIN }, "module:hands-chrome", { firstParty: true })).code, "denied", `${tool} is the person's alone`);
});

test("site.put: a patch with a secret, a seed or an email is refused whole, nothing is stored, and the text is never echoed", async t => {
  const w = await world(t);
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, true);
  const before = (await w.call("memory.site.get", { origin: ORIGIN })).data;
  for (const [what, note] of [["key", `call it with ${KEY}`], ["email", "ask robin@harlow.example"], ["seed", "vyre-pc:AbCdEfGhIjKlMnOpQrStUv"]]) {
    const r = await w.call("memory.site.put", { origin: ORIGIN, patch: patch({ notes: [{ name: "n", text: note }] }) });
    assert.equal(r.data.accepted, false, what);
    assert.ok(r.data.refused.length >= 1);
    assert.ok(!JSON.stringify(r).includes("robin@") && !JSON.stringify(r).includes("a1b2c3d4") && !JSON.stringify(r).includes("AbCdEfGh"), what);
  }
  assert.deepEqual((await w.call("memory.site.get", { origin: ORIGIN })).data, before, "nothing changed");
  const events = /** @type {any[]} */ (w.db.prepare("SELECT kind, item FROM memory_site_events WHERE kind = 'refused'").all());
  assert.equal(events.length, 3);
  assert.ok(events.every(e => !/a1b2c3d4|robin@/.test(String(e.item))));
  assert.equal(String(/** @type {any} */ (w.db.prepare("SELECT record FROM memory_site").get()).record).includes("a1b2c3d4"), false);
});

test("families: a family is written only by an origin that named it, and a read returns both cards", async t => {
  const w = await world(t);
  assert.equal((await w.call("memory.site.put", { origin: AGENCY, target: "family", family: "ghl", patch: patch() })).code, "denied", "the origin has not named the family");
  assert.equal((await w.call("memory.site.put", { origin: AGENCY, patch: { family: "ghl", login: { wall: [{ kind: "password-field" }] } } })).data.accepted, true);
  assert.equal((await w.call("memory.site.put", { origin: AGENCY, target: "family", patch: patch() })).data.accepted, true);
  assert.equal((await w.call("memory.site.put", { origin: AGENCY, target: "family", family: "other", patch: patch() })).code, "denied");
  const got = (await w.call("memory.site.get", { origin: AGENCY })).data;
  assert.equal(got.origin.family, "ghl");
  assert.equal(got.family.key, "family:ghl");
  assert.equal(got.family.api.length, 1);
  assert.equal(got.origin.api.length, 0);
  const again = (await w.call("memory.site.get", { origin: AGENCY, since_rev: got.rev, family_rev: got.family_rev })).data;
  assert.equal(again.not_modified, true);
  const fresh = (await w.call("memory.site.get", { origin: AGENCY, since_rev: got.rev, family_rev: 0 })).data;
  assert.ok(fresh.family, "a moved family rev is sent");
});

test("site.report: a success raises trust, misses cut it and quarantine it, an unknown item answers null", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const rep = outcome => w.call("memory.site.report", { origin: ORIGIN, part: "controls", id: "c1", outcome });
  assert.equal((await rep("ok")).data.conf, 0.6);
  assert.equal((await rep("miss")).data.conf, 0.36);
  w.clock.now += 3 * 24 * HOUR;
  await rep("miss");
  const last = await rep("miss");
  assert.equal(last.data.quarantined, true);
  assert.equal((await w.call("memory.site.report", { origin: ORIGIN, part: "controls", id: "nope", outcome: "ok" })).data.conf, null);
  assert.equal((await w.call("memory.site.list", {})).data.sites[0].used_to_work, 1);
  assert.equal((await w.call("memory.site.report", { origin: ORIGIN, part: "flows", id: "x", outcome: "sideways" })).error === undefined, true, "the registry validates enums; the tool ignores what it does not know");
});

test("site.list, site.forget and site.restore: one item, a whole site, then the 24-hour undo", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  await w.call("memory.site.put", { origin: AGENCY, patch: { family: "ghl", names: ["GHL"] } });
  const list = (await w.call("memory.site.list", {})).data.sites;
  assert.deepEqual(list.map(s => s.key).sort(), [AGENCY, ORIGIN]);
  assert.deepEqual(list.find(s => s.key === ORIGIN).counts, { controls: 1, api: 1, flows: 0, notes: 0, frames: 0 });
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN, part: "api", id: "e_1" })).data.forgotten, 1);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin.api.length, 0);
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN })).data.forgotten, 1);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin, null);
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN })).data.restored, 1);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin.controls.length, 1);
  await w.call("memory.site.forget", { key: ORIGIN });
  w.clock.now += 25 * HOUR;
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN })).data.restored, 0, "after 24 hours it is gone");
  assert.equal((await w.call("memory.site.forget", { all: true })).data.forgotten, 1);
  assert.equal((await w.call("memory.site.list", {})).data.sites.length, 0);
});

test("a removal needs the current base_rev", async t => {
  const w = await world(t);
  const r1 = (await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data;
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: { remove: [{ part: "api", id: "e_1" }] }, base_rev: 0 })).code, "conflict");
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: { remove: [{ part: "api", id: "e_1" }] }, base_rev: r1.rev })).data.accepted, true);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin.api.length, 0);
});

test("the learn setting: on is the default; off means nothing is learned or reported", async t => {
  const w = await world(t, { "memory.site.learn": false });
  assert.deepEqual((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data, { accepted: false, learning: false });
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin, null);
  w.set["memory.site.learn"] = true;
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, true);
  delete w.set["memory.site.learn"];
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, true, "no value set means on");
});

test("site.sync: a replica's records are folded in by the same allowlist and newest verified, and newer records come back", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const replica = { key: ORIGIN, names: ["GoHighLevel"], controls: [{ id: "c1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "create-workflow-v2" }, verified: "2026-10-02T00:00:00Z", seen: 7 },
    { id: "c2", page: "/workflows", role: "tab", selector: { strategy: "identifier", identifier: "triggers" } }], rev: 5 };
  const evil = { key: AGENCY, flows: [{ name: "f-x", src: "learned", steps: [{ id: "s1", op: "page.fill", args: { value: "Robin Ellis" } }] }] };
  const r = (await w.call("memory.site.sync", { have: {}, push: [replica, evil] })).data;
  assert.equal(r.accepted, 1);
  assert.equal(r.refused.length, 1);
  assert.ok(!JSON.stringify(r).includes("Robin"));
  const got = (await w.call("memory.site.get", { origin: ORIGIN, parts: ["controls"] })).data.origin.controls;
  assert.equal(got.find(c => c.id === "c1").selector.identifier, "create-workflow-v2", "the newer verified wins");
  assert.ok(got.some(c => c.id === "c2"), "nothing is lost");
  assert.equal(r.pull.length, 1, "the record the replica does not have yet");
  const again = (await w.call("memory.site.sync", { have: { [ORIGIN]: 99 }, push: [] })).data;
  assert.equal(again.pull.length, 0);
  w.set["memory.site.sync"] = false;
  assert.equal((await w.call("memory.site.sync", { push: [replica] })).data.sync, false);
});

test("a person's data in a label never reaches a stored record", async t => {
  const w = await world(t);
  const obs = { controls: [
    { id: "c1", page: "/contacts", role: "link", container: "row", siblings: 20, nameVisits: ["v1", "v2"], name: "Robin Ellis", selector: { strategy: "structure", role: "link", container: "row", nth: 2 } },
    { id: "c2", page: "/contacts", role: "button", container: "toolbar", siblings: 1, nameVisits: ["v1", "v2"], name: "Add contact", selector: { strategy: "identifier", identifier: "add-contact" } },
  ] };
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: obs })).data.accepted, true);
  const stored = String(/** @type {any} */ (w.db.prepare("SELECT record FROM memory_site").get()).record);
  assert.ok(!stored.includes("Robin"));
  assert.ok(stored.includes("Add contact"));
});

const DAY = 24 * HOUR;

test("notes are the person's own: a person's surface stores one, Chrome's bridge cannot", async t => {
  const w = await world(t);
  const note = { notes: [{ name: "builder", text: "The builder is a nested frame; wait for its landmark." }] };
  await w.call("memory.site.put", { origin: ORIGIN, patch: note }, "module:hands-chrome", { firstParty: true });
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN, parts: ["notes"] })).data.origin.notes.length, 0, "the bridge's note is dropped");
  await w.call("memory.site.put", { origin: ORIGIN, patch: note }, "deck");
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN, parts: ["notes"] })).data.origin.notes[0].src, "taught");
});

test("a forgotten site stays forgotten: a replica's older copy is dropped, newer learning is kept, and the replica is told", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const copy = (await w.call("memory.site.get", { origin: ORIGIN, parts: ["controls", "api", "ready"] })).data.origin;
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN })).data.forgotten, 1);
  w.clock.now += HOUR;
  const old = { key: ORIGIN, ...copy, controls: copy.controls.map(c => ({ ...c, verified: new Date(NOW - HOUR).toISOString() })), api: [], ready: [] };
  const r1 = (await w.call("memory.site.sync", { have: {}, push: [old] })).data;
  assert.deepEqual([r1.accepted, r1.skipped], [0, 1], "nothing newer than the forget");
  assert.ok(r1.forgotten.some(f => f.key === ORIGIN), "the replica is told to forget it");
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin, null);
  const fresh = { ...old, controls: old.controls.map(c => ({ ...c, verified: new Date(w.clock.now).toISOString() })) };
  assert.equal((await w.call("memory.site.sync", { have: {}, push: [fresh] })).data.accepted, 1, "what was verified after the forget is new learning");
});

test("forgotten records leave the disk after 24 hours without a restart", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  await w.call("memory.site.forget", { key: ORIGIN });
  assert.equal(/** @type {any} */ (w.db.prepare("SELECT COUNT(*) n FROM memory_site_forgotten").get()).n, 1);
  w.clock.now += 25 * HOUR;
  await w.call("memory.site.list", {});
  assert.equal(/** @type {any} */ (w.db.prepare("SELECT COUNT(*) n FROM memory_site_forgotten").get()).n, 0);
});

test("sync cannot raise trust or invent a family: new items start at 0.5, shipped is not claimable, a family needs an origin", async t => {
  const w = await world(t);
  const replica = { key: ORIGIN, family: "ghl", controls: [{ id: "c1", page: "/w", role: "button", conf: 1, selector: { strategy: "identifier", identifier: "go" } }],
    flows: [{ name: "f-x", src: "shipped", conf: 1, expects: [{ kind: "selector", arg: "toast" }], steps: [] }] };
  const orphan = { key: "family:mine", controls: [{ id: "c9", page: "/w", role: "button", selector: { strategy: "identifier", identifier: "nine" } }] };
  const r = (await w.call("memory.site.sync", { push: [replica, orphan] })).data;
  assert.equal(r.accepted, 1);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].key, "family:mine");
  const got = (await w.call("memory.site.get", { origin: ORIGIN, parts: ["controls", "flows"] })).data.origin;
  assert.equal(got.controls[0].conf, 0.5);
  assert.equal(got.flows[0].src, "learned");
  assert.ok(got.flows[0].conf <= 0.5);
  assert.equal((await w.call("memory.site.sync", { push: [{ key: "family:ghl", controls: [{ id: "c2", page: "/w", role: "tab", selector: { strategy: "identifier", identifier: "two" } }] }] })).data.accepted, 1, "a family an origin named is fine");
});

test("settings fail closed: an error from the hub keeps the last value, or off; no hub at all means the default", async t => {
  const w = await world(t);
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, true);
  // The hub starts failing: the last known value (on) holds.
  w.set.__fail = true;
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, true);
  // A person's OFF is remembered through a failure.
  delete w.set.__fail; w.set["memory.site.learn"] = false;
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, false);
  w.set.__fail = true;
  assert.equal((await w.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, false, "the off holds while the hub fails");
  // A hub that never answered: off, since nothing is known.
  const fresh = await world(t);
  fresh.set.__fail = true;
  assert.equal((await fresh.call("memory.site.put", { origin: ORIGIN, patch: patch() })).data.accepted, false);
});

test("a phone paired through the relay (device:<id>) is a person's surface", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  assert.equal((await w.call("memory.site.list", {}, "device:phone-1")).data.sites.length, 1);
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN }, "device:phone-1")).data.forgotten, 1);
});
