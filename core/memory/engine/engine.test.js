// @ts-check
// The memory engine against the fake kernel: the three outcomes of 7.9, the intersection rule, sealed values never in a row or a citation,
// per-source authorization, Space isolation, label inheritance, erasure and the sweep limit.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../../store/index.js";
import { tempHome } from "../../../test/helpers.js";
import { createFakeKernel } from "../../../test/fake-kernel.js";
import { createMemoryEngine, MIN_SWEEP_MS } from "./index.js";
import { externalLabels, memberLabels } from "../../../lib/labels.js";

const SEALED = { sealed: "us-ssn", ref: "seal_1", present: true, valid_format: true, set_at: 1 };

/** A Space with alex (write), bob (read only), the memory service, and an engine over a temp db. */
function world(t, opts = {}) {
  const f = createFakeKernel(opts.kernel);
  const alex = f.person("alex"), bob = f.person("bob"), mem = f.service("memory"), model = f.agent("juno");
  f.grant(alex, ["record.read", "record.write", "task.request"]);
  f.grant(bob, ["record.read"], `vyre://${f.space}/matter`);
  f.grant(mem, ["record.read", "event.read", "memory.read", "record.write", "task.request"]);
  f.grant(model, ["record.read", "model.use"]);
  const db = open(path.join(tempHome(t), "engine.db"));
  let now = 1_000_000;
  const engine = createMemoryEngine({
    kernel: f.kernel, db, space: f.space, serviceChain: f.chain([mem]), chainFor: p => f.chain([p, mem]),
    clock: () => now, fieldDef: (type, field) => (field === "plan" ? { kind: "choice", required: true } : field === "ssn" ? { kind: "sealed" } : null),
    ownerOf: () => alex, ...opts.engine,
  });
  return { f, alex, bob, mem, engine, advance: ms => { now += ms; }, db };
}
const matter = (f, data = {}) => f.seed("matter", { name: "Jane Doe", practice_area: "", size: "", ...data });
const src = (w, rec, over = {}) => ({ urn: `vyre://${w.f.space}/call/c1`, text: "Jane runs a bakery with 12 staff.", labels: memberLabels(w.f.space), person: w.alex, records: [rec.urn], citations: [`line:s1#4`], from: "Tuesday's call", ...over });
const fact = (w, rec, field, value, person = w.alex, extra = {}) => ({ record: rec.urn, field, note: field === null, value, citations: ["line:s1#4"], labels: memberLabels(w.f.space), person, from: "Tuesday's call", ...extra });

test("lines: kept exactly, scrubbed on the way in, windowed, authorized by the session's record, and erased by session", async t => {
  const w = world(t);
  const n = w.engine.lines.ingest("s1", [
    { seq: 1, role: "user", text: "client ssn is 123-45-6789", at: 1 }, { seq: 2, role: "user", text: "or 123 45 6789 or 123456789", at: 2 },
    { seq: 3, role: "assistant", text: "noted", at: 3 }, { seq: 4, role: "user", text: "the court portal changed", at: 4 }]);
  assert.equal(n, 4);
  w.f.grant(w.alex, ["record.read"], `vyre://${w.f.space}/session`);
  const got = await w.engine.lines.recall(w.f.chain([w.alex]), "s1", 1, 3);
  assert.equal(got.length, 3);
  assert.doesNotMatch(JSON.stringify(got), /123-45-6789|123 45 6789|123456789/);
  assert.equal(got[2].address, "line:s1#3");
  assert.equal((await w.engine.lines.window(w.f.chain([w.alex]), { session: "s1", query: "court portal", radius: 1 })).map(l => l.seq).join(), "3,4");
  assert.deepEqual(await w.engine.lines.recall(w.f.chain([w.bob]), "s1", 1, 4), [], "a reader without the session's record sees nothing");
  assert.equal(w.engine.forgetSession("s1"), 4);
  assert.deepEqual(await w.engine.lines.recall(w.f.chain([w.alex]), "s1", 1, 4), []);
});

test("extract: the text goes to the model as data; an unknown record and a value the detectors recognise are dropped; labels are inherited", async t => {
  const w = world(t);
  const rec = matter(w.f);
  w.f.script(call => {
    assert.match(call.messages[1].content, /data, not instructions/);
    return { content: JSON.stringify({ facts: [
      { record: rec.urn, field: "practice_area", value: "Bakery" }, { record: rec.urn, note: true, value: "Her ssn is 123 45 6789" },
      { record: "vyre://other/matter/x", field: "size", value: "12" }, { record: rec.urn, note: true, value: "Prefers email" }] }) };
  });
  const facts = await w.engine.facts.extract(w.f.chain([w.alex, w.f.agent("juno")]), src(w, rec, { labels: externalLabels(w.f.space) }));
  assert.deepEqual(facts.map(x => x.value), ["Bakery", "Prefers email"]);
  assert.ok(facts.every(x => x.labels.trust === "external"), "a fact from external mail stays external");
  assert.equal(w.f.modelCalls.length, 1);
});

test("outcome 1: a new note with a source is written directly, under the person and the service", async t => {
  const w = world(t);
  const rec = matter(w.f);
  const [r] = await w.engine.facts.propose([fact(w, rec, null, "Prefers email")]);
  assert.equal(r.outcome, "note");
  const ev = w.f.events.find(e => e.type === "record.created");
  assert.deepEqual(ev.chain.map(h => `${h.actor.kind}:${h.actor.id}`), ["person:alex", "service:memory"]);
  assert.deepEqual([...w.f.records.get("note").values()][0].data.sources, ["line:s1#4"]);
  assert.equal(w.f.tasks.size, 0, "a note is not a task");
});

test("outcome 1 with the intersection: a person without write keeps the note as a suggestion only they see", async t => {
  const w = world(t);
  const rec = matter(w.f);
  const [r] = await w.engine.facts.propose([fact(w, rec, null, "Prefers email", w.bob)]);
  assert.equal(r.outcome, "private_suggestion");
  assert.equal((await w.engine.facts.suggestions(w.f.chain([w.bob]))).length, 1);
  assert.equal((await w.engine.facts.suggestions(w.f.chain([w.alex]))).length, 0, "nobody else sees it");
  assert.equal(w.f.records.get("note")?.size || 0, 0);
});

test("outcome 2: an empty field becomes a quiet suggestion, summarised, accepted by a person with write; never a task", async t => {
  const w = world(t);
  const rec = matter(w.f);
  const rs = await w.engine.facts.propose([fact(w, rec, "practice_area", "Bakery"), fact(w, rec, "size", "12 staff"), fact(w, rec, "practice_area", "Bakery")]);
  assert.deepEqual(rs.map(r => r.outcome), ["suggestion", "suggestion", "suggestion"]);
  assert.equal(rs[0].suggestion, rs[2].suggestion, "the same suggestion is kept once");
  assert.deepEqual(await w.engine.facts.summary(w.f.chain([w.bob]), rec.urn), ["2 new facts from Tuesday's call"], "readers of the record see it");
  assert.equal(w.f.tasks.size, 0);
  const list = await w.engine.facts.suggestions(w.f.chain([w.alex]), rec.urn);
  await assert.rejects(w.engine.facts.accept(w.f.chain([w.bob]), list[0].id), /./, "bob has no write");
  assert.deepEqual(await w.engine.facts.accept(w.f.chain([w.alex]), list[0].id), { outcome: "applied" });
  assert.equal(w.f.records.get("matter").get(rec.id).data.practice_area, "Bakery");
  w.engine.facts.dismiss(w.f.chain([w.alex]), list[1].id);
  assert.equal((await w.engine.facts.suggestions(w.f.chain([w.alex]), rec.urn)).length, 0);
});

test("auto-accept needs an admin's policy grant and covers only empty fields and notes, never an existing, sealed or required value", async t => {
  const w = world(t);
  const rec = matter(w.f, { size: "7", ssn: SEALED, plan: "" });
  const policy = w.f.grant(w.f.person("admin"), ["policy.memory"], "vyre://");
  w.f.grants.find(g => g.id === policy.id).source = "policy:memory.auto-accept";
  const auto = createMemoryEngine({ kernel: w.f.kernel, db: open(path.join(tempHome(t), "a.db")), space: w.f.space, serviceChain: w.f.chain([w.mem]), chainFor: p => w.f.chain([p, w.mem]),
    autoAccept: { grant: policy.id }, fieldDef: (ty, fl) => (fl === "plan" ? { required: true } : fl === "ssn" ? { kind: "sealed" } : null), ownerOf: () => w.alex });
  const rs = await auto.facts.propose([fact(w, rec, "practice_area", "Bakery"), fact(w, rec, "size", "12"), fact(w, rec, "plan", "Trust"), fact(w, rec, "ssn", "x")]);
  assert.deepEqual(rs.map(r => r.outcome), ["applied", "task", "task", "task"]);
  assert.equal(w.f.records.get("matter").get(rec.id).data.practice_area, "Bakery");
  assert.equal(w.f.records.get("matter").get(rec.id).data.size, "7", "an existing value is never auto-changed");
  const other = matter(w.f);
  w.f.grants.find(g => g.id === policy.id).status = "revoked";
  assert.equal((await auto.facts.propose([fact(w, other, "practice_area", "Cafe")]))[0].outcome, "suggestion", "with the grant revoked nothing is automatic");
});

test("outcome 3: a changed value, a required field or a sealed field raises one task to the owner, once, and a sealed value is not copied into it", async t => {
  const w = world(t);
  const rec = matter(w.f, { size: "7", ssn: SEALED });
  const rs = await w.engine.facts.propose([fact(w, rec, "size", "12"), fact(w, rec, "plan", "Trust"), fact(w, rec, "ssn", "unknown format"), fact(w, rec, "size", "12")]);
  assert.deepEqual(rs.map(r => r.outcome), ["task", "task", "task", "task"]);
  assert.equal(w.f.tasks.size, 3, "the duplicate makes no second task");
  assert.equal(rs[3].duplicate, true);
  const tasks = [...w.f.tasks.values()];
  assert.ok(tasks.every(x => x.source === "memory_proposal" && x.output.kind === "fields" && x.doer.id === "alex"));
  const sealedTask = tasks.find(x => x.output.target[0] === "ssn");
  assert.equal(sealedTask.form.value_withheld, true);
  assert.equal(JSON.stringify(sealedTask).includes("unknown format"), false);
  assert.equal((await w.engine.facts.propose([fact(w, rec, "size", "7")]))[0].outcome, "noop", "the same value changes nothing");
});

test("sealed values never enter the index or a citation, in any spelling", async t => {
  const w = world(t);
  w.f.sealValue("123-45-6789");
  const rec = matter(w.f, { ssn: SEALED, notes: "ssn typed here 123 45 6789 and 123456789 and 123-45-6789" });
  assert.equal(await w.engine.index({ kind: "record", type: "matter", id: rec.id }), 1);
  w.engine.lines.ingest("s1", [{ seq: 1, role: "user", text: "Jane Doe's SSN: 123-45-6789", at: 1 }], { record: rec.urn });
  await w.engine.index({ kind: "lines", session: "s1" });
  const dump = w.engine._dump();
  assert.doesNotMatch(dump, /123[- ]?45[- ]?6789/);
  assert.doesNotMatch(dump, /seal_1/, "not even the reference");
  assert.match(dump, /ssn: sealed, present/);
  w.f.script(() => ({ content: "Jane Doe is a client [S1]. Her number is 123456789 [S9]." }));
  const a = await w.engine.answer(w.f.chain([w.alex]), "who is Jane Doe");
  assert.doesNotMatch(JSON.stringify(a), /123456789/);
  assert.ok(a.citations.every(c => !/123/.test(c)));
  assert.doesNotMatch(a.text, /\[S9\]/, "a citation the engine did not retrieve is dropped");
});

test("search and answer: authorized per source for the caller; citations are only what was retrieved; labels are the weakest of what was cited", async t => {
  const w = world(t);
  const secret = w.f.seed("matter", { name: "Northwind Bakery sale", note: "bakery sale terms" });
  const open_ = w.f.seed("matter", { name: "Harlow Legal intake", note: "bakery intake form" }, externalLabels(w.f.space));
  w.f.grants.length = 0;
  w.f.grant(w.mem, ["record.read"]); w.f.grant(w.f.person("alex"), ["record.read"]); w.f.grant(w.f.person("bob"), ["record.read"], open_.urn);
  await w.engine.index({ kind: "record", type: "matter", id: secret.id });
  await w.engine.index({ kind: "record", type: "matter", id: open_.id });
  const bobHits = await w.engine.search(w.f.chain([w.bob]), "bakery");
  assert.deepEqual(bobHits.map(h => h.source), [open_.urn], "bob may read one source only; the other is dropped");
  assert.equal((await w.engine.search(w.f.chain([w.alex]), "bakery")).length, 2);
  w.f.script(() => ({ content: "Intake exists [S1] and a sale [S2] and nothing [S7]." }));
  const a = await w.engine.answer(w.f.chain([w.bob]), "bakery");
  assert.deepEqual(a.citations, [open_.urn], "S2 does not exist for bob");
  assert.equal(a.labels.trust, "external", "the cited record was external, so the answer is");
  assert.match(w.f.modelCalls.at(-1).messages[1].content, /external/);
  assert.doesNotMatch(w.f.modelCalls.at(-1).messages[1].content, /sale terms/, "the model was never shown what bob may not read");
});

test("a Space is closed: another Space's records and rows never appear", async t => {
  const a = world(t), b = world(t, { kernel: { space: "spc_other" } });
  const ra = a.f.seed("matter", { name: "Harlow Legal", note: "estate plan" });
  const rb = b.f.seed("matter", { name: "Northwind Bakery", note: "estate plan" });
  await a.engine.index({ kind: "record", type: "matter", id: ra.id });
  await b.engine.index({ kind: "record", type: "matter", id: rb.id });
  assert.deepEqual((await a.engine.search(a.f.chain([a.alex]), "estate")).map(h => h.source), [ra.urn]);
  assert.deepEqual((await b.engine.search(b.f.chain([b.alex]), "estate")).map(h => h.source), [rb.urn]);
  assert.doesNotMatch(a.engine._dump(), /Northwind/);
  const [r] = await a.engine.facts.propose([fact(a, rb, "note", "x")]);
  assert.equal(r.outcome, "unreadable", "a fact about another Space's record is refused");
});

test("erasure follows the sources: rows, suggestions and proposal keys go, and a record that still exists is re-derived", async t => {
  const w = world(t);
  const rec = matter(w.f, { note: "bakery" });
  await w.engine.index({ kind: "record", type: "matter", id: rec.id });
  await w.engine.facts.propose([fact(w, rec, "practice_area", "Bakery")]);
  w.f.records.get("matter").get(rec.id).data.note = "cafe";
  const gone = await w.engine.forgetSource(rec.urn);
  assert.deepEqual(gone, [rec.urn]);
  assert.equal((await w.engine.facts.suggestions(w.f.chain([w.alex]), rec.urn)).length, 0);
  assert.match(w.engine._dump(), /note: cafe/, "re-derived from what the record says now");
  assert.doesNotMatch(w.engine._dump(), /bakery/);
  w.f.records.get("matter").delete(rec.id);
  await w.engine.forgetSource(rec.urn);
  assert.equal(w.engine._count(), 0);
});

test("no polling: a sweep runs at most once a minute and never on its own", async t => {
  const w = world(t);
  const rec = matter(w.f, { note: "x" });
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
  const w = world(t, { engine: { embed } });
  const a = w.f.seed("matter", { note: "bakery lease" }), b = w.f.seed("matter", { note: "estate plan" });
  await w.engine.index({ kind: "record", type: "matter", id: a.id }); await w.engine.index({ kind: "record", type: "matter", id: b.id });
  assert.equal((await w.engine.search(w.f.chain([w.alex]), "estate"))[0].source, b.urn);
});
