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
  // Identifiers arrive with the two-visit evidence a real learner sends.
  const visits = x => (x && Array.isArray(x.controls) ? { ...x, controls: x.controls.map(c => (c && c.selector && c.selector.identifier && !("identifierVisits" in c) ? { ...c, identifierVisits: ["v1", "v2"] } : c)) } : x);
  const call = async (name, rawInput, caller = "deck", meta = {}) => {
    const input = rawInput && typeof rawInput === "object" ? { ...rawInput, ...(rawInput.patch ? { patch: visits(rawInput.patch) } : {}), ...(Array.isArray(rawInput.push) ? { push: rawInput.push.map(visits) } : {}) } : rawInput;
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
  w.clock.now += HOUR;
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

const Q = "what do you know about GoHighLevel?";

test("memory.ask: a question about a known site is answered in code, with its sources, for the person only", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch({ flows: [{ name: "create-workflow", src: "shipped", runs: 4, fails: 1, expects: [{ kind: "selector", arg: "toast" }] }] }) });
  const a = await w.call("memory.ask", { question: Q }, "deck");
  assert.ok(!a.error, a.error);
  assert.equal(a.data.via, "site");
  assert.equal(a.data.abstained, false);
  assert.match(a.data.answer, /^From what Vyre for Chrome learned: GoHighLevel \(app\.ghl\.example\)\./);
  assert.match(a.data.answer, /1 control known on 1 page/);
  assert.match(a.data.answer, /1 endpoint of its own API/);
  assert.match(a.data.answer, /create-workflow \(learned, 4 runs, 1 failed\)/);
  assert.deepEqual(a.data.sources.map(s => [s.site, s.session, s.role]), [[ORIGIN, `site:${ORIGIN}`, "site"]]);
  assert.equal(typeof a.data.answer_id, "string");
  // The name, the family id and the host all find it; a question that merely names it does not.
  for (const q of ["what do you know about ghl", "what have you learned about app.ghl.example", "tell me about GoHighLevel"]) assert.equal((await w.call("memory.ask", { question: q }, "deck")).data.via, "site", q);
  assert.equal((await w.call("memory.ask", { question: "open GoHighLevel and make a workflow" }, "deck")).data.via, "site", "it names the site and nothing else answers, so the summary does");
  assert.notEqual((await w.call("memory.ask", { question: "what do you know about Northwind Bakery" }, "deck")).data.via, "site");
  // An agent in a project never gets it, whatever it asks.
  const agent = await w.call("memory.ask", { question: Q }, "mcp:agent:juno", { agent: "juno", granted: [] });
  assert.notEqual(agent.data && agent.data.via, "site");
  assert.ok(!JSON.stringify(agent).includes("Vyre for Chrome learned"));
});

test("memory.ask: a family answers for all its origins, and what used to work is said", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: AGENCY, patch: { family: "ghl", names: ["GoHighLevel"] } });
  await w.call("memory.site.put", { origin: AGENCY, target: "family", patch: patch() });
  const a = (await w.call("memory.ask", { question: "what do you know about agency.example" }, "deck")).data;
  assert.equal(a.via, "site");
  assert.match(a.answer, /GoHighLevel \(agency\.example\)/);
  assert.match(a.answer, /1 endpoint/, "the family's API is the agency host's too");
  // Three misses over two days set a control aside.
  const miss = () => w.call("memory.site.report", { origin: ORIGIN, part: "controls", id: "c1", outcome: "miss" });
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  await miss(); w.clock.now += 3 * 24 * HOUR; await miss(); w.clock.now += HOUR; await miss();
  assert.match((await w.call("memory.ask", { question: Q }, "deck")).data.answer, /used to work and were set aside/);
});

test("Wrong? and Forget: wrong never gives that answer again; forget removes the site, a replica cannot bring it back, and undo restores it", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const a = (await w.call("memory.ask", { question: Q }, "deck")).data;
  const wrong = await w.call("memory.correct", { answer: a.answer_id, action: "wrong" }, "deck");
  assert.ok(!wrong.error, wrong.error);
  const again = (await w.call("memory.ask", { question: Q }, "deck")).data;
  assert.notEqual(again.answer, a.answer);
  assert.equal(again.via, "corrected");
  assert.ok((await w.call("memory.site.get", { origin: ORIGIN })).data.origin, "wrong does not delete what is known");
  await w.call("memory.uncorrect", { fix: wrong.data.fix.id }, "deck");
  const b = (await w.call("memory.ask", { question: Q }, "deck")).data;
  assert.equal(b.via, "site");
  const fx = await w.call("memory.correct", { answer: b.answer_id, action: "forget" }, "deck");
  assert.ok(!fx.error, fx.error);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN })).data.origin, null, "the site is forgotten");
  assert.notEqual((await w.call("memory.ask", { question: Q }, "deck")).data.via, "site");
  const copy = { key: ORIGIN, names: ["GoHighLevel"], controls: [{ id: "c1", page: "/workflows", role: "button", selector: { strategy: "identifier", identifier: "create-workflow" }, verified: new Date(NOW - HOUR).toISOString() }] };
  assert.equal((await w.call("memory.site.sync", { push: [copy] })).data.skipped, 1, "an older replica copy does not bring it back");
  await w.call("memory.uncorrect", { fix: fx.data.fix.id }, "deck");
  assert.equal((await w.call("memory.ask", { question: Q }, "deck")).data.via, "site", "undo brings it back");
});

test("memory.site.detail: the Sites list's rows, each with the id its Forget needs; structure only, person only", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch({ flows: [{ name: "create-workflow", src: "shipped", runs: 2, fails: 0 }] }) });
  const d = (await w.call("memory.site.detail", { key: ORIGIN }, "deck")).data;
  assert.equal(d.found, true);
  assert.deepEqual(d.names, ["GoHighLevel"]);
  assert.equal(d.parts.controls[0].id, "c1");
  assert.equal(d.parts.controls[0].label, "button on /workflows");
  assert.equal(d.parts.api[0].label, "GET /workflows/{id}");
  assert.equal(d.parts.flows[0].runs, 2);
  assert.ok(d.events.some(e => e.kind === "put"));
  assert.ok(!JSON.stringify(d).includes("create-workflow\"}"), "no selector in a row");
  assert.ok(!("selector" in d.parts.controls[0]));
  // Its Forget works on the id it gave.
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN, part: "controls", id: d.parts.controls[0].id }, "deck")).data.forgotten, 1);
  assert.equal((await w.call("memory.site.detail", { key: ORIGIN }, "deck")).data.parts.controls.length, 0);
  assert.equal((await w.call("memory.site.detail", { key: "https://none.example" }, "deck")).data.found, false);
  for (const who of ["mcp:agent:juno", "mcp", "module:hands-chrome"]) assert.equal((await w.call("memory.site.detail", { key: ORIGIN }, who, who.startsWith("module") ? { firstParty: true } : {})).code, "denied", who);
});

test("S2 forgetting a site forgets what was said about it: the answers log and a correction keep no text of it", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const a = (await w.call("memory.ask", { question: Q }, "deck")).data;
  assert.match(/** @type {any} */ (w.db.prepare("SELECT answer FROM memory_iq_answers WHERE id = ?").get(a.answer_id)).answer, /^site answer: https:\/\/app\.ghl\.example$/, "a site answer is logged by its site, not its text");
  await w.call("memory.correct", { answer: a.answer_id, action: "wrong" }, "deck");
  await w.call("memory.site.forget", { key: ORIGIN }, "deck");
  assert.equal(/** @type {any} */ (w.db.prepare("SELECT answer FROM memory_iq_answers WHERE id = ?").get(a.answer_id)).answer, "[forgotten]");
  assert.equal(/** @type {any} */ (w.db.prepare("SELECT old FROM memory_iq_fixes WHERE answer = ?").get(a.answer_id)).old, "[forgotten]");
  assert.ok(!JSON.stringify(w.db.prepare("SELECT * FROM memory_iq_answers").all()).includes("learned: GoHighLevel"));
});

test("T3 a site is matched by a whole name, family or host, never by a fragment such as a host's core word", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: "https://accounts.google.example", patch: { names: ["Google Accounts"], family: "googleacct", controls: [{ id: "c1", page: "/login", role: "button", selector: { strategy: "identifier", identifier: "go" } }] } });
  const via = async q => (await w.call("memory.ask", { question: q }, "deck")).data.via;
  assert.notEqual(await via("what do you know about google"), "site", "a bare core word does not match");
  assert.notEqual(await via("tell me about accounts"), "site");
  assert.equal(await via("what do you know about google accounts"), "site", "the whole name does");
  assert.equal(await via("what do you know about accounts.google.example"), "site", "the whole host does");
  assert.equal(await via("what do you know about googleacct"), "site", "the family id does");
});

test("T4 a question names its site from the index; other records are never parsed", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  // A second site whose stored record is unreadable: if answering parsed every record, this would throw or lose the answer.
  w.db.prepare("INSERT INTO memory_site (key, kind, rev, record, card, updated, names, family) VALUES (?,?,?,?,?,?,?,?)").run("https://broken.example", "origin", 1, "{not json", "{}", NOW, "broken", null);
  assert.equal((await w.call("memory.ask", { question: Q }, "deck")).data.via, "site");
  assert.notEqual((await w.call("memory.ask", { question: "what is the capital of France" }, "deck")).data.via, "site", "a question that names no site parses nothing");
});

test("quarantine: three misses in 30 seconds are one miss and set nothing aside; it takes misses across two days", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const miss = () => w.call("memory.site.report", { origin: ORIGIN, part: "controls", id: "c1", outcome: "miss" });
  const first = (await miss()).data;
  for (let i = 0; i < 5; i++) { w.clock.now += 6000; await miss(); }
  const after = (await miss()).data;
  assert.equal(after.conf, first.conf, "a flood of misses inside one visit is one miss");
  assert.equal(after.quarantined, false);
  const d = (await w.call("memory.site.detail", { key: ORIGIN }, "deck")).data;
  assert.equal(d.used_to_work, 0);
  // Separate visits on the same day still do not: it needs the misses to span two days.
  w.clock.now += 2 * HOUR; await miss(); w.clock.now += 2 * HOUR;
  assert.equal((await miss()).data.quarantined, false);
  w.clock.now += 2 * 24 * HOUR;
  assert.equal((await miss()).data.quarantined, true);
});

test("a forgotten row can be brought back for 24 hours, like a whole site", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  await w.call("memory.site.report", { origin: ORIGIN, part: "controls", id: "c1", outcome: "ok" });
  assert.equal((await w.call("memory.site.forget", { key: ORIGIN, part: "controls", id: "c1" }, "deck")).data.forgotten, 1);
  assert.equal((await w.call("memory.site.get", { origin: ORIGIN, parts: ["controls"] })).data.origin.controls.length, 0);
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN, part: "controls", id: "c1" }, "deck")).data.restored, 1);
  const back = (await w.call("memory.site.get", { origin: ORIGIN, parts: ["controls"] })).data.origin.controls;
  assert.deepEqual([back.length, back[0].conf], [1, 0.6], "it returns with the trust it had");
  // A row can be forgotten again after a restore; after 24 hours it cannot be brought back.
  await w.call("memory.site.forget", { key: ORIGIN, part: "controls", id: "c1" }, "deck");
  w.clock.now += 25 * HOUR;
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN, part: "controls", id: "c1" }, "deck")).data.restored, 0);
  assert.equal(/** @type {any} */ (w.db.prepare("SELECT COUNT(*) n FROM memory_site_forgotten_items").get()).n, 0, "purged");
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN, part: "controls", id: "nope" }, "deck")).data.restored, 0);
  assert.equal((await w.call("memory.site.restore", { key: ORIGIN, part: "controls", id: "c1" }, "mcp:agent:juno")).code, "denied");
});

test("Wrong? on a site answer is remembered by the question and the site, so the same summary with new counts does not come back", async t => {
  const w = await world(t);
  await w.call("memory.site.put", { origin: ORIGIN, patch: patch() });
  const a = (await w.call("memory.ask", { question: Q }, "deck")).data;
  assert.equal(a.via, "site");
  await w.call("memory.correct", { answer: a.answer_id, action: "wrong" }, "deck");
  await w.call("memory.site.put", { origin: ORIGIN, patch: { controls: [{ id: "c2", page: "/contacts", role: "tab", selector: { strategy: "identifier", identifier: "tab-two" } }] } });
  const again = (await w.call("memory.ask", { question: Q }, "deck")).data;
  assert.equal(again.via, "corrected", "the summary changed (two controls now), and it is still refused");
  assert.equal((await w.call("memory.ask", { question: "what do you know about ghl" }, "deck")).data.via, "site", "another question is not affected");
});
