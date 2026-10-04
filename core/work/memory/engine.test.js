// @ts-check
// The memory engine on the REAL kernel (test/kernel-rig.js: createKernel, the real grants store, tasks and gateway): the three outcomes of 7.9, the intersection rule,
// sealed values never in a row or a citation, per-source authorization, Space isolation, label inheritance, erasure and the sweep limit. Only the model provider is
// a stand-in (SHIM(model)); the `note` record type is defined by the rig because records' core types do not have it yet (SHIM(note type)).
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import { createRig } from "../../../test/kernel-rig.js";
import { createMemoryEngine, MIN_SWEEP_MS } from "./index.js";
import { externalLabels, memberLabels } from "../../../lib/labels.js";

const SEALED = { sealed: "us-ssn", ref: "seal_1", present: true, valid_format: true, set_at: 1 };
const MATTER = { name: "matter", label: "Matter", fields: ["name", "practice_area", "size", "plan", "note", "notes"].map(n => ({ name: n, kind: "text", label: n })).concat([{ name: "ssn", kind: "sealed", label: "SSN", seal: { level: "ai", class: "us-ssn" } }]) };
// SHIM(note type): records' CORE_TYPES has no note, and the engine writes one.
const NOTE = { name: "note", label: "Note", fields: [{ name: "record", kind: "link", label: "About" }, { name: "text", kind: "text", label: "Text" }, { name: "sources", kind: "multi_choice", label: "Sources" }, { name: "trust", kind: "text", label: "Trust" }, { name: "from", kind: "text", label: "From" }] };
const MEMORY = { name: "memory", needs: { kernel: { actions: ["records.read", "records.create", "events.read", "tasks.request"] } } };

/** A Space with alex (the owner), bob (a member cut down to read), the memory service, and an engine over a temp db. */
async function world(t, opts = {}) {
  const rig = await createRig({ people: { per_bob: "member" }, agents: ["juno"], defs: [MATTER, NOTE, ...(opts.defs || [])], ...(opts.rig || {}) });
  await rig.restrict("per_bob", { actions: ["records.read"] });
  const mem = rig.k.kernelFor(MEMORY);
  const serviceChain = mem.serviceChain();
  await mem.records.query(serviceChain, "note", { page: { limit: 1 } }).catch(() => {}); // wait for the service to be installed
  const alex = rig.actor("person", "per_alex"), bob = rig.actor("person", "per_bob");
  const db = open(path.join(tempHome(t), "engine.db"));
  let now = 1_000_000;
  const engine = createMemoryEngine({
    kernel: rig.kernel, db, space: rig.space, serviceChain, chainFor: p => rig.withService(rig.person(p.id), "memory"),
    personChain: p => rig.person(p.id), clock: () => now, fieldDef: (type, field) => (field === "plan" ? { kind: "choice", required: true } : field === "ssn" ? { kind: "sealed" } : null),
    ownerOf: () => alex, ...opts.engine,
  });
  const as = (/** @type {any} */ a) => rig.person(a.id);
  return { rig, alex, bob, engine, as, advance: (/** @type {number} */ ms) => { now += ms; }, db, space: rig.space, mem };
}
const matter = (w, data = {}) => w.rig.create("matter", { name: "Jane Doe", practice_area: "", size: "", ...data });
const src = (w, rec, over = {}) => ({ urn: `vyre://${w.space}/call/c1`, text: "Jane runs a bakery with 12 staff.", labels: memberLabels(w.space), person: w.alex, records: [rec.urn], citations: [`line:s1#4`], from: "Tuesday's call", ...over });
const fact = (w, rec, field, value, person = w.alex, extra = {}) => ({ record: rec.urn, field, note: field === null, value, citations: ["line:s1#4"], labels: memberLabels(w.space), person, from: "Tuesday's call", ...extra });
const notes = async (w) => (await w.rig.kernel.records.query(w.rig.ownerChain, "note", { page: { limit: 50 } })).rows;
const openTasks = async (w) => (await w.rig.kernel.tasks.list(w.rig.ownerChain, {}));

test("lines: kept exactly, scrubbed on the way in, windowed, authorized by the session's record, and erased by session", async t => {
  const w = await world(t);
  const n = w.engine.lines.ingest("s1", [
    { seq: 1, role: "user", text: "client ssn is 123-45-6789", at: 1 }, { seq: 2, role: "user", text: "or 123 45 6789 or 123456789", at: 2 },
    { seq: 3, role: "assistant", text: "noted", at: 3 }, { seq: 4, role: "user", text: "the court portal changed", at: 4 }]);
  assert.equal(n, 4);
  const got = await w.engine.lines.recall(w.as(w.alex), "s1", 1, 3);
  assert.equal(got.length, 3);
  assert.doesNotMatch(JSON.stringify(got), /123-45-6789|123 45 6789|123456789/);
  assert.equal(got[2].address, "line:s1#3");
  assert.equal((await w.engine.lines.window(w.as(w.alex), { session: "s1", query: "court portal", radius: 1 })).map(l => l.seq).join(), "3,4");
  await w.rig.restrict("per_bob", { prefix: `vyre://${w.space}/matter/*` });
  assert.deepEqual(await w.engine.lines.recall(w.as(w.bob), "s1", 1, 4), [], "a reader without the session's record sees nothing");
  assert.equal(w.engine.forgetSession("s1"), 4);
  assert.deepEqual(await w.engine.lines.recall(w.as(w.alex), "s1", 1, 4), []);
});

test("extract: the text goes to the model as data; an unknown record and a value the detectors recognise are dropped; labels are inherited", async t => {
  const w = await world(t);
  const rec = await matter(w);
  w.rig.script(call => {
    assert.match(call.messages[1].content, /data, not instructions/);
    return { content: JSON.stringify({ facts: [
      { record: rec.urn, field: "practice_area", value: "Bakery" }, { record: rec.urn, note: true, value: "Her ssn is 123 45 6789" },
      { record: "vyre://other/matter/x", field: "size", value: "12" }, { record: rec.urn, note: true, value: "Prefers email" }] }) };
  });
  const facts = await w.engine.facts.extract(w.rig.assistant("per_alex", "juno"), src(w, rec, { labels: externalLabels(w.space) }));
  assert.deepEqual(facts.map(x => x.value), ["Bakery", "Prefers email"]);
  assert.ok(facts.every(x => x.labels.trust === "external"), "a fact from external mail stays external");
  assert.equal(w.rig.modelCalls.length, 1);
});

test("outcome 1: a new note with a source is written directly, under the person and the service", async t => {
  const w = await world(t);
  const rec = await matter(w);
  const [r] = await w.engine.facts.propose([fact(w, rec, null, "Prefers email")]);
  assert.equal(r.outcome, "note");
  const ev = w.rig.k.log.read({ type: "note.created" })[0];
  assert.deepEqual(ev.chain.map(h => `${h.actor.kind}:${h.actor.id}`), ["person:per_alex", "service:memory"]);
  const [n] = await notes(w);
  assert.deepEqual(n.data.sources, ["line:s1#4"]);
  assert.equal((await openTasks(w)).length, 0, "a note is not a task");
});

test("outcome 1 with the intersection: a person without write keeps the note as a suggestion only they see", async t => {
  const w = await world(t);
  const rec = await matter(w);
  const [r] = await w.engine.facts.propose([fact(w, rec, null, "Prefers email", w.bob)]);
  assert.equal(r.outcome, "private_suggestion");
  assert.equal((await w.engine.facts.suggestions(w.as(w.bob))).length, 1);
  assert.equal((await w.engine.facts.suggestions(w.as(w.alex))).length, 0, "nobody else sees it");
  assert.equal((await notes(w)).length, 0);
});

test("outcome 2: an empty field becomes a quiet suggestion, summarised, accepted by a person with write; never a task", async t => {
  const w = await world(t);
  const rec = await matter(w);
  w.engine.lines.ingest("s1", [{ seq: 4, role: "user", text: "the practice area is Bakery and they have 12 staff", at: 4 }]);
  const rs = await w.engine.facts.propose([fact(w, rec, "practice_area", "Bakery"), fact(w, rec, "size", "12 staff"), fact(w, rec, "practice_area", "Bakery")]);
  assert.deepEqual(rs.map(r => r.outcome), ["suggestion", "suggestion", "suggestion"]);
  assert.equal(rs[0].suggestion, rs[2].suggestion, "the same suggestion is kept once");
  // KW-3: the facts were drawn from the owner's own session. Bob may read the record but not that session, so he is shown none of them; the owner is.
  assert.deepEqual(await w.engine.facts.summary(w.as(w.bob), rec.urn), [], "a reader of the record who may not read the cited session sees nothing");
  assert.deepEqual(await w.engine.facts.summary(w.as(w.alex), rec.urn), ["2 new facts from Tuesday's call"]);
  assert.equal((await openTasks(w)).length, 0);
  const list = await w.engine.facts.suggestions(w.as(w.alex), rec.urn);
  await assert.rejects(w.engine.facts.accept(w.as(w.bob), list[0].id), /./, "bob has no write");
  assert.deepEqual(await w.engine.facts.accept(w.as(w.alex), list[0].id), { outcome: "applied" });
  assert.equal((await w.rig.kernel.records.get(w.rig.ownerChain, "matter", rec.id)).data.practice_area, "Bakery");
  w.engine.facts.dismiss(w.as(w.alex), list[1].id);
  assert.equal((await w.engine.facts.suggestions(w.as(w.alex), rec.urn)).length, 0);
});

test("auto-accept needs an admin's policy grant and covers only empty fields and notes, never an existing, sealed or required value", async t => {
  const w = await world(t);
  const rec = await matter(w, { size: "7", ssn: SEALED, plan: "" });
  // Without the policy the service cannot write a field at all: the first fact is only a suggestion.
  const mk = () => createMemoryEngine({ kernel: w.rig.kernel, db: open(path.join(tempHome(t), `a${Math.random()}.db`)), space: w.space, serviceChain: w.mem.serviceChain(), chainFor: p => w.rig.withService(w.rig.person(p.id), "memory"), personChain: p => w.rig.person(p.id),
    autoAccept: true, fieldDef: (ty, fl) => (fl === "plan" ? { required: true } : fl === "ssn" ? { kind: "sealed" } : null), ownerOf: () => w.alex });
  assert.equal((await mk().facts.propose([fact(w, rec, "practice_area", "Bakery")]))[0].outcome, "suggestion", "no policy, no automation");
  // The policy is a real grant from an admin whose source starts with `policy:`; revoking it turns the automation off.
  const policy = await w.rig.grantTo(w.rig.actor("service", "memory"), ["records.update"], `vyre://${w.space}/*/*`, { source: "policy:memory.auto-accept" });
  const auto = mk();
  const rs = await auto.facts.propose([fact(w, rec, "practice_area", "Bakery"), fact(w, rec, "size", "12"), fact(w, rec, "plan", "Trust"), fact(w, rec, "ssn", "x")]);
  assert.deepEqual(rs.map(r => r.outcome), ["applied", "task", "task", "task"]);
  const now = (await w.rig.kernel.records.get(w.rig.ownerChain, "matter", rec.id)).data;
  assert.equal(now.practice_area, "Bakery");
  assert.equal(now.size, "7", "an existing value is never auto-changed");
  const other = await matter(w);
  const revoke = { id: policy.id, reason: "off" };
  await w.rig.k.gateway.grants.revoke(w.rig.ownerChain, policy.id, "off", { presence: w.rig.proof("grants.revoke", revoke, `vyre://${w.space}/grant/${policy.id}`) });
  assert.equal((await auto.facts.propose([fact(w, other, "practice_area", "Cafe")]))[0].outcome, "suggestion", "with the grant revoked nothing is automatic");
});

test("outcome 3: a changed value, a required field or a sealed field raises one task to the owner, once, and a sealed value is not copied into it", async t => {
  const w = await world(t);
  const rec = await matter(w, { size: "7", ssn: SEALED });
  const rs = await w.engine.facts.propose([fact(w, rec, "size", "12"), fact(w, rec, "plan", "Trust"), fact(w, rec, "ssn", "unknown format"), fact(w, rec, "size", "12")]);
  assert.deepEqual(rs.map(r => r.outcome), ["task", "task", "task", "task"]);
  const tasks = await openTasks(w);
  assert.equal(tasks.length, 3, "the duplicate makes no second task");
  assert.equal(rs[3].duplicate, true);
  assert.ok(tasks.every(x => x.source === "assistant_request" && x.output.kind === "fields" && x.doer.id === "per_alex"));
  const sealedTask = tasks.find(x => x.output.target[0] === "ssn");
  assert.equal(JSON.stringify(sealedTask).includes("unknown format"), false);
  assert.match(sealedTask.note, /withheld|sealed/);
  assert.equal((await w.engine.facts.propose([fact(w, rec, "size", "7")]))[0].outcome, "noop", "the same value changes nothing");
});

test("sealed values never enter the index or a citation, in any spelling", async t => {
  const w = await world(t);
  const rec = await matter(w, { ssn: SEALED, notes: "ssn typed here 123 45 6789 and 123456789 and 123-45-6789" });
  assert.equal(await w.engine.index({ kind: "record", type: "matter", id: rec.id }), 1);
  w.engine.lines.ingest("s1", [{ seq: 1, role: "user", text: "Jane Doe's SSN: 123-45-6789", at: 1 }], { record: rec.urn });
  await w.engine.index({ kind: "lines", session: "s1" });
  const dump = w.engine._dump();
  assert.doesNotMatch(dump, /123[- ]?45[- ]?6789/);
  assert.doesNotMatch(dump, /seal_1/, "not even the reference");
  assert.match(dump, /ssn: sealed, present/);
  w.rig.script(() => ({ content: "Jane Doe is a client [S1]. Her number is 123456789 [S9]." }));
  const a = await w.engine.answer(w.as(w.alex), "who is Jane Doe");
  assert.doesNotMatch(JSON.stringify(a), /123456789/);
  assert.ok(a.citations.every(c => !/123/.test(c)));
  assert.doesNotMatch(a.text, /\[S9\]/, "a citation the engine did not retrieve is dropped");
});

test("search and answer: authorized per source for the caller; citations are only what was retrieved; labels are the weakest of what was cited", async t => {
  const w = await world(t);
  const secret = await w.rig.create("matter", { name: "Northwind Bakery sale", note: "bakery sale terms" });
  const open_ = await w.rig.create("matter", { name: "Harlow Legal intake", note: "bakery intake form" });
  // bob may read the one record only: his role grants cut to that record (the real grants.narrow).
  await w.rig.restrict("per_bob", { prefix: open_.urn });
  await w.engine.index({ kind: "record", type: "matter", id: secret.id });
  await w.engine.index({ kind: "record", type: "matter", id: open_.id });
  const bobHits = await w.engine.search(w.as(w.bob), "bakery");
  assert.deepEqual(bobHits.map(h => h.source), [open_.urn], "bob may read one source only; the other is dropped");
  assert.equal((await w.engine.search(w.as(w.alex), "bakery")).length, 2);
  w.rig.script(() => ({ content: "Intake exists [S1] and a sale [S2] and nothing [S7]." }));
  const a = await w.engine.answer(w.as(w.bob), "bakery");
  assert.deepEqual(a.citations, [open_.urn], "S2 does not exist for bob");
  assert.match(w.rig.modelCalls.at(-1).messages[1].content, /intake form/);
  assert.doesNotMatch(w.rig.modelCalls.at(-1).messages[1].content, /sale terms/, "the model was never shown what bob may not read");
});

test("a Space is closed: another Space's records and rows never appear", async t => {
  const a = await world(t), b = await world(t, { rig: { space: "spc_bbbbbbbbbbbb" } });
  const ra = await a.rig.create("matter", { name: "Harlow Legal", note: "estate plan" });
  const rb = await b.rig.create("matter", { name: "Northwind Bakery", note: "estate plan" });
  await a.engine.index({ kind: "record", type: "matter", id: ra.id });
  await b.engine.index({ kind: "record", type: "matter", id: rb.id });
  assert.deepEqual((await a.engine.search(a.as(a.alex), "estate")).map(h => h.source), [ra.urn]);
  assert.deepEqual((await b.engine.search(b.as(b.alex), "estate")).map(h => h.source), [rb.urn]);
  assert.doesNotMatch(a.engine._dump(), /Northwind/);
  const [r] = await a.engine.facts.propose([fact(a, rb, "note", "x")]);
  assert.equal(r.outcome, "unreadable", "a fact about another Space's record is refused");
});

test("erasure follows the sources: rows, suggestions and proposal keys go, and a record that still exists is re-derived", async t => {
  const w = await world(t);
  const rec = await matter(w, { note: "bakery" });
  await w.engine.index({ kind: "record", type: "matter", id: rec.id });
  await w.engine.facts.propose([fact(w, rec, "practice_area", "Bakery")]);
  const cur = await w.rig.kernel.records.get(w.rig.ownerChain, "matter", rec.id);
  await w.rig.kernel.records.update(w.rig.ownerChain, "matter", rec.id, { note: "cafe" }, cur.version);
  const gone = await w.engine.forgetSource(rec.urn);
  assert.deepEqual(gone, [rec.urn]);
  assert.equal((await w.engine.facts.suggestions(w.as(w.alex), rec.urn)).length, 0);
  assert.match(w.engine._dump(), /note: cafe/, "re-derived from what the record says now");
  assert.doesNotMatch(w.engine._dump(), /bakery/);
  const again = await w.rig.kernel.records.get(w.rig.ownerChain, "matter", rec.id);
  await w.rig.kernel.records.remove(w.rig.ownerChain, "matter", rec.id, again.version);
  await w.engine.forgetSource(rec.urn);
  assert.equal(w.engine._count(), 0);
});

test("no polling: a sweep runs at most once a minute and never on its own", async t => {
  const w = await world(t);
  const rec = await matter(w, { note: "x" });
  const sources = [{ kind: "record", type: "matter", id: rec.id }];
  assert.equal((await w.engine.sweep(sources)).skipped, false);
  assert.equal((await w.engine.sweep(sources)).skipped, true);
  w.advance(MIN_SWEEP_MS - 1);
  assert.equal((await w.engine.sweep(sources)).skipped, true);
  w.advance(1);
  assert.equal((await w.engine.sweep(sources)).skipped, false);
  assert.ok(MIN_SWEEP_MS >= 60_000);
});

test("the ranker works with an embedder and without one", async t => {
  const embed = async texts => texts.map(x => [/bakery/i.test(x) ? 1 : 0, /estate/i.test(x) ? 1 : 0]);
  const w = await world(t, { engine: { embed } });
  const a = await w.rig.create("matter", { note: "bakery lease" }), b = await w.rig.create("matter", { note: "estate plan" });
  await w.engine.index({ kind: "record", type: "matter", id: a.id }); await w.engine.index({ kind: "record", type: "matter", id: b.id });
  assert.equal((await w.engine.search(w.as(w.alex), "estate"))[0].source, b.urn);
});

test("KW-2: a fact that needs a task, proposed under the read-only viewer chain, is kept as the person's own suggestion and never thrown out of the pass", async t => {
  const w = await world(t);
  const rec = await matter(w, { size: "7" });
  const viewerEngine = createMemoryEngine({ kernel: w.rig.kernel, db: open(path.join(tempHome(t), "kw2.db")), space: w.space, serviceChain: w.mem.serviceChain(),
    chainFor: p => w.rig.k.chains.appendService(w.rig.k.chains.fromFacts({ kind: "viewer", person: p.id, vouched: true }), "memory", true), personChain: p => w.rig.person(p.id), ownerOf: () => w.alex });
  const r = await viewerEngine.facts.propose([fact(w, rec, "size", "99 staff")]);
  assert.equal(r[0].outcome, "private_suggestion");
});
