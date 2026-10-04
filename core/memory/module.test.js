// @ts-check
// The memory module inside a real vyred: tools over the socket, the session.indexed event, and
// a daemon with no Recall index at all.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start, callerFacts } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
// The kernel is the daemon's only source of "who is calling": these tests start a real vyred, so they run it with the kernel on (the default once VYRE_KERNEL is flipped).
process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";

function seeded(t, { recall = true } = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ me: { domains: ["riverastudio.com"] } }));
  if (recall) { const db = open(path.join(root, "vyre.db")); seedRecall(db); db.close(); }
  return root;
}

test("memory module: curates in the background and answers every tool over the socket", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const mods = (await request("GET", "/v1/modules", undefined, { root })).data;
  assert.equal(mods.find(m => m.name === "memory")?.state, "running");

  const cur = await call("memory.curate", {}, { root });
  assert.ok(cur.data.nodes > 0, JSON.stringify(cur));
  const facts = (await call("memory.facts", { about: "Harlow" }, { root })).data;
  assert.equal(facts.about.label, "Harlow Legal");
  assert.ok(facts.facts.some(f => f.text === "Dana Reyes works at Harlow Legal"));
  const rel = (await call("memory.relevant", { text: "is the Northwind watcher still running?" }, { root })).data;
  assert.ok(rel.length > 0 && rel.every(f => f.text.includes("Northwind Bakery")));
  const why = (await call("memory.why", { fact: facts.facts[0].id }, { root })).data;
  assert.ok(why.turns.length > 0);
  assert.equal((await call("memory.pin", { node: "Sam Okafor" }, { root })).data.mode, "pin");
  assert.equal((await call("memory.mute", { node: "Sam Okafor", off: true }, { root })).data.mode, null);
  const stats = (await call("memory.stats", {}, { root })).data;
  assert.equal(stats.recall, true);
  assert.equal(stats.focus, 1);
  assert.equal((await call("memory.relevant", {}, { root })).error.code, "bad_input");
  const ev = (await request("GET", "/v1/events?type=memory.curated", undefined, { root })).data;
  assert.ok(ev.length >= 1 && ev[0].payload.nodes > 0, "memory.curated was not emitted");
  // The first pass grew the graph from nothing: how many people and orgs, never their names.
  const grew = (await request("GET", "/v1/events?type=memory.graph-grew", undefined, { root })).data;
  assert.ok(grew.length >= 1, "memory.graph-grew was not emitted");
  assert.ok(grew[0].payload.new.person >= 1 && grew[0].payload.new.org >= 1, JSON.stringify(grew[0].payload));
  assert.doesNotMatch(JSON.stringify(grew), /Dana|Harlow/, "names in an event");
});

test("memory module: session.indexed with rewritten re-reads that session", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  const s = SESSIONS[2];
  db.prepare("DELETE FROM recall_turns WHERE session = ?").run(s.id);
  db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text) VALUES (?,?,?,?,?)").run(s.id, 0, "user", s.start, "Northwind invoices, compacted.");
  db.prepare("UPDATE recall_sessions SET turns = 1 WHERE id = ?").run(s.id);
  const done = new Promise(resolve => { const off = d.events.on("memory.curated", e => { off(); resolve(e); }); });
  d.events.emit("recall", "session.indexed", { session: s.id, from: 0, to: 0, rewritten: true });
  await done;
  const about = (await call("memory.facts", { about: "Sam Okafor" }, { root })).data;
  assert.equal(about.about, null, "Sam Okafor was only named in the rewritten transcript");
});

test("memory module: with no Recall index vyred still starts and memory answers with nothing", async t => {
  const root = seeded(t, { recall: false });
  // Recall is installed now, so turn it off the way a user would, to get a machine with no index.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ modules: { disable: ["recall"] } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.equal((await request("GET", "/v1/modules", undefined, { root })).data.find(m => m.name === "memory")?.state, "running");
  const cur = (await call("memory.curate", {}, { root })).data;
  assert.equal(cur.recall, false);
  assert.deepEqual((await call("memory.relevant", { text: "Harlow Legal" }, { root })).data, []);
  assert.equal((await call("memory.stats", {}, { root })).data.recall, false);
});

test("memory module: memory.ask streamed tells each step under the caller's id, then that it answered", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  // Under node --test there is no model: IQ answers from what memory holds, or searches and is not sure.
  const r = (await call("memory.ask", { question: "which port did the Northwind staging deploy use?", stream: true, id: "cap_1" }, { root })).data;
  assert.equal(r.id, "cap_1");
  assert.equal(r.abstained, true);
  const stages = (await request("GET", "/v1/events?type=memory.thinking", undefined, { root })).data.map(e => e.payload).filter(p => p.id === "cap_1").map(p => p.stage);
  assert.deepEqual(stages.sort(), ["searching", "understanding"]);
  const answered = (await request("GET", "/v1/events?type=memory.answered", undefined, { root })).data.map(e => e.payload);
  assert.deepEqual(answered.find(p => p.id === "cap_1"), { id: "cap_1", abstained: true, limited: false }, "events carry the id and the outcome, never the question or the answer");
  // Not streamed: no id and no events.
  const plain = (await call("memory.ask", { question: "which port did the Northwind staging deploy use?" }, { root })).data;
  assert.equal(plain.id, undefined);
  // A made-up id that is not a plain token is replaced.
  assert.match((await call("memory.ask", { question: "which port did the Northwind staging deploy use?", stream: true, id: "../x" }, { root })).data.id, /^iq_[0-9a-f]{12}$/);
});

test("memory module: suggest offers the names memory knows, with who a role is", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  await call("memory.remember", { text: "my wife is Juno" }, { root });
  const direct = (await call("memory.suggest", { prefix: "wi" }, { root })).data;
  assert.deepEqual(direct.items.find(i => i.label === "wife"), { label: "wife", kind: "entity", insert: "wife", id: direct.items.find(i => i.label === "wife").id, detail: "Juno" });
  // Through suggest.query: the first keystroke may miss the 25 ms deadline while things warm up.
  let items = [];
  for (let i = 0; i < 3 && !items.some(x => x.source === "memory.suggest"); i++) items = (await call("suggest.query", { text: "dinner with my wi", surface: "deck" }, { root })).data.items;
  const wife = items.find(x => x.source === "memory.suggest" && x.label === "wife");
  assert.ok(wife, JSON.stringify(items));
  assert.equal(wife.detail, "Juno");
  items = (await call("suggest.query", { text: "call Jun", surface: "deck" }, { root })).data.items;
  assert.ok(items.some(x => x.source === "memory.suggest" && x.label === "Juno"), JSON.stringify(items));
});

test("memory module: an IQ answer corrected where it is shown is the answer next time, everywhere, and undoes", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  await call("memory.remember", { text: "my wife is Jordan" }, { root });
  const a = (await call("memory.ask", { question: "what is my wife's name?" }, { root })).data;
  assert.match(a.answer, /Jordan/);
  assert.equal(a.via, "fact");
  assert.ok(a.answer_id);

  const r = await call("memory.correct", { answer: a.answer_id, action: "replace", object: "Your wife is Juno." }, { root });
  assert.equal(r.data.fix.action, "replace", JSON.stringify(r));
  const same = (await call("memory.ask", { question: "What is my wife's name" }, { root })).data;
  assert.equal(same.answer, "Your wife is Juno.");
  assert.equal(same.via, "corrected");
  // Another way of asking: the old fact is denied and the person's words were told to memory.
  const other = (await call("memory.answer", { q: "who is my wife" }, { root })).data;
  assert.match(String(other.answer), /Juno/, JSON.stringify(other));
  assert.doesNotMatch(String(other.answer), /Jordan/);
  const stats = (await call("memory.stats", {}, { root })).data;
  assert.equal(stats.iq.corrected, 1);
  assert.equal(stats.iq.by_kind.people, 1);
  const log = (await call("memory.corrections", { answers: true }, { root })).data;
  assert.equal(log.fixes[0].old, a.answer);

  // An agent never corrects; a graph action with an answer is refused.
  assert.equal((await call("memory.correct", { answer: a.answer_id, action: "confirm" }, { root })).error.code !== undefined, true);

  await call("memory.uncorrect", { fix: r.data.fix.id }, { root });
  assert.match((await call("memory.ask", { question: "what is my wife's name?" }, { root })).data.answer, /Jordan/, "undone, the fact is back");
  assert.equal((await call("memory.stats", {}, { root })).data.iq.corrected, 0);
});

test("memory module: the person corrects from their phone only signed in; a device with no chain, or an agent's, never", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await call("memory.curate", {}, { root });
  await call("memory.remember", { text: "my wife is Jordan" }, { root });
  const a = (await call("memory.ask", { question: "what is my wife's name?" }, { root })).data;
  const phone = "device:abcdefghijklmnop";
  // The phone is a paired app device in the home's own relay table; its facts are the daemon's own `callerFacts` from that row (PH-1), never hand-made.
  d.registry.deps.db.prepare("INSERT INTO relay_devices (id, name, pub, paired_at, kind, trusted, removed_at) VALUES (?, 'phone', 'p', 1, 'app', 0, NULL)").run("abcdefghijklmnop");
  const row = (await d.registry.call("relay.device.info", { id: "abcdefghijklmnop" }, "module:vyred")).data || null;
  const facts = (signedIn) => { const via = signedIn ? { person: { id: "s1", kind: "cookie" } } : {}; return { ...via, kernelFacts: callerFacts(phone, { caller: phone }, via, d.kernel, false, row) }; };
  const bare = await d.registry.call("memory.correct", { answer: a.answer_id, action: "wrong" }, phone, facts(false));
  assert.equal(bare.error?.code, "person_session_required", JSON.stringify(bare));
  const graphBare = await d.registry.call("memory.correct", { subject: "Dana Reyes", rel: "works_at", object: "Harlow Legal", action: "confirm" }, phone, facts(false));
  assert.equal(graphBare.error?.code, "person_session_required", "graph corrections follow the same rule");
  // A device the kernel built no chain for (a label alone) corrects nothing.
  const noChain = await d.registry.call("memory.correct", { answer: a.answer_id, action: "wrong" }, "tailnet:alex@example.com", { person: { id: "s1", kind: "cookie" } });
  assert.equal(noChain.error?.code, "denied", JSON.stringify(noChain));

  const ok = await d.registry.call("memory.correct", { answer: a.answer_id, action: "wrong" }, phone, facts(true));
  assert.equal(ok.data?.fix?.action, "wrong", JSON.stringify(ok));
  const graph = await d.registry.call("memory.correct", { subject: "Dana Reyes", rel: "works_at", object: "Harlow Legal", action: "confirm" }, phone, facts(true));
  assert.ok(graph.data?.correction, JSON.stringify(graph));
  const undo = await d.registry.call("memory.uncorrect", { fix: ok.data.fix.id }, phone, facts(true));
  assert.equal(undo.data?.fix?.undone > 0, true, JSON.stringify(undo));
});

test("memory module: unpairing a device keeps what came from it; the person's delete forgets it all", async t => {
  const { writeTranscripts } = await import("../../test/fixtures/corpus.js");
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ me: { domains: ["riverastudio.com"] }, vault: { keystore: "file" }, modules: { disable: ["learn"] } }));
  const synced = path.join(root, "synced", "mac-1");
  writeTranscripts(synced);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  await call("memory.curate", {}, { root });
  assert.equal((await call("recall.status", {}, { root })).data.sessions, SESSIONS.length, "the synced sessions are indexed like any others");
  assert.equal((await call("memory.facts", { about: "Harlow" }, { root })).data.about?.label, "Harlow Legal");
  await call("memory.ask", { question: "who works at Harlow Legal?" }, { root });

  // Unpaired (or replaced, or lost): nothing goes. The data is the person's, not the device's.
  d.events.emit("sync", "sync.revoked", { machine: "mac-1" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await call("recall.status", {}, { root })).data.sessions, SESSIONS.length, "unpairing deleted sessions");
  assert.equal((await call("memory.facts", { about: "Harlow" }, { root })).data.about?.label, "Harlow Legal");
  // The preview for "Delete everything that came from mac-1", in counts; a model never sees it.
  const preview = (await call("memory.device", { machine: "mac-1" }, { root })).data;
  assert.equal(preview.sessions, SESSIONS.length);
  assert.ok(preview.turns > 0 && preview.facts > 0 && preview.people > 0, JSON.stringify(preview));
  assert.equal((await d.registry.call("memory.device", { machine: "mac-1" }, "mcp")).error?.code, "denied");
  // The same event from any module but federation's (core/sync) forgets nothing.
  d.events.emit("watchers", "sync.deleted", { machine: "mac-1" });
  d.events.emit("link", "sync.deleted", { machine: "mac-1" });
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await call("recall.status", {}, { root })).data.sessions, SESSIONS.length, "a sync.deleted from another module deleted history");
  // The person deletes: federation deletes the files, then says so; memory and Recall forget the rest.
  fs.rmSync(synced, { recursive: true, force: true });
  const done = new Promise(resolve => { const off = d.events.on("memory.forgot", e => { off(); resolve(e.payload); }); });
  d.events.emit("sync", "sync.deleted", { machine: "mac-1" });
  const out = await done;
  assert.equal(out.sessions, SESSIONS.length);
  assert.equal((await call("recall.status", {}, { root })).data.sessions, 0);
  assert.equal((await call("memory.facts", { about: "Harlow" }, { root })).data.about, null, "a fact from a revoked device's sessions stayed");
  const db = open(path.join(root, "vyre.db"));
  t.after(() => db.close());
  for (const table of ["memory_iq_asks", "memory_evidence", "memory_me_claims"]) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  // A name that is not a machine's forgets nothing.
  d.events.emit("sync", "sync.deleted", { machine: "../../etc" });
});

test("memory module: the first read's pace takes Vyre's own import module only, as the loader vouches", async t => {
  const root = seeded(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const imp = d.registry.context(d.registry.modules.get("import").manifest);
  assert.deepEqual((await imp.call("memory.pace", { pace: "fast" })).data, { pace: "fast" });
  // af11226d moved firstParty from something a caller passed in to something registry.call
  // derives itself, fresh, from the caller label against the live registry (core/modules'
  // firstParty(dir)) - so a caller genuinely reading "module:import" is exactly as trusted
  // whether it arrives through import's own ctx.call (above) or straight through registry.call
  // (here): both resolve the SAME registered module's SAME real, shipped directory. The label
  // itself is still the actual security boundary this tool cares about, not the call path, so
  // the exact name is what must still be checked: a different real, shipped module's own label
  // (recall's, also loader-vouched) is refused just the same as an unrelated caller would be.
  assert.equal((await d.registry.call("memory.pace", { pace: "fast" }, "module:import")).data?.pace, "fast");
  const rec = d.registry.context(d.registry.modules.get("recall").manifest);
  assert.equal((await rec.call("memory.pace", { pace: "fast" })).error?.code, "denied");
  assert.equal((await d.registry.call("memory.pace", { pace: "fast" }, "module:recall")).error?.code, "denied");
  // A label naming no module the registry actually has running (a typo, an uninstalled one) is
  // refused too: firstParty(dir) has nothing to check it against.
  assert.equal((await d.registry.call("memory.pace", { pace: "fast" }, "module:not-a-real-module")).error?.code, "denied");
});
