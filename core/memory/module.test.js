// @ts-check
// The memory module inside a real vyred: tools over the socket, the session.indexed event, and
// a daemon with no Recall index at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../store/index.js";
import { start } from "../daemon/index.js";
import { call, request } from "../daemon/client.js";
import { SESSIONS, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

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
