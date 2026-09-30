// @ts-check
// Recall's indexer and search, against the fictional corpus and small hand-written transcripts.
// Vectors use a fake embedder: tests never download a model, and pass whether or not the
// optional package is installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { search, thread, sessions, anyOf, floorFor, prefixOf } from "./search.js";
import { Dense } from "./dense.js";
import { chunks, encode, decode, cosine, CHUNK } from "./embed.js";
import { SESSIONS, writeTranscripts, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeEmbedder } from "./testing.js";

/** A temp home with a database, a transcripts folder and an indexer that records its events. */
function setup(t) {
  const home = tempHome(t);
  const dir = path.join(home, "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const events = [];
  const ix = new Indexer(db, { emit: (type, payload) => events.push({ type, ...payload }) });
  const file = path.join(dir, "-tmp-p", "s1.jsonl");
  const writeTurns = texts => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, texts.map((text, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", timestamp: new Date(1e12 + i * 1000).toISOString(),
      cwd: "/tmp/p", message: { role: i % 2 ? "assistant" : "user", content: text } })).join("\n") + "\n");
    // A later write must look changed even within the same millisecond.
    const when = new Date(Date.now() + texts.length * 1000);
    fs.utimesSync(file, when, when);
  };
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  return { home, dir, db, ix, events, file, writeTurns, rows, index: () => ix.run([dir]) };
}

const SESSION_COLS = "id, file, cwd, name, title, started, ended, turns, human, parent";

test("recall: indexing the corpus yields exactly seedRecall's rows", async t => {
  const e = setup(t);
  writeTranscripts(e.dir);
  const s = await e.index();
  assert.deepEqual({ ...s, ms: 0 }, { sessions: SESSIONS.length, added: SESSIONS.length, appended: 0, reindexed: 0, skipped: 0, failed: 0, turns: 16, ms: 0 });

  const seeded = open(path.join(e.home, "seed.db"));
  t.after(() => seeded.close());
  seedRecall(seeded, SESSIONS, { transcripts: e.dir });
  const q = (db, sql) => JSON.parse(JSON.stringify(db.prepare(sql).all()));
  assert.deepEqual(q(e.db, `SELECT ${SESSION_COLS} FROM recall_sessions ORDER BY id`), q(seeded, `SELECT ${SESSION_COLS} FROM recall_sessions ORDER BY id`));
  const TURNS = "SELECT session, seq, role, ts, text FROM recall_turns ORDER BY session, seq";
  assert.deepEqual(q(e.db, TURNS), q(seeded, TURNS));
});

test("recall: an unchanged transcript is skipped, and a second pass writes nothing", async t => {
  const e = setup(t);
  writeTranscripts(e.dir);
  await e.index();
  const before = e.rows("SELECT rowid, session, seq FROM recall_turns ORDER BY rowid");
  const s = await e.index();
  assert.equal(s.skipped, SESSIONS.length);
  assert.equal(s.turns, 0);
  assert.deepEqual(e.rows("SELECT rowid, session, seq FROM recall_turns ORDER BY rowid"), before);
  assert.equal(e.events.length, SESSIONS.length, "an unchanged pass emitted events");
});

test("recall: a grown transcript appends its new turns and keeps every vector", async t => {
  const e = setup(t);
  e.writeTurns(["first question here", "first answer here", "second question here"]);
  await e.index();
  await e.ix.vectorize(fakeEmbedder());
  const before = e.rows("SELECT rowid, seq FROM recall_turns WHERE session = 's1' ORDER BY seq");
  const vecs = e.rows("SELECT seq, v FROM recall_vectors WHERE session = 's1' ORDER BY seq");
  assert.equal(vecs.length, 3);

  e.writeTurns(["first question here", "first answer here", "second question here", "second answer here"]);
  const s = await e.index();
  assert.equal(s.appended, 1);
  const after = e.rows("SELECT rowid, seq FROM recall_turns WHERE session = 's1' ORDER BY seq");
  assert.equal(after.length, 4, "the new turn was not appended");
  assert.deepEqual(after.slice(0, 3), before, "old turns were rewritten");
  assert.deepEqual(e.rows("SELECT seq, v FROM recall_vectors WHERE session = 's1' ORDER BY seq"), vecs, "the old turns' vectors were thrown away");
  assert.deepEqual(e.events.at(-1), { type: "session.indexed", session: "s1", from: 3, to: 3, rewritten: false });
  const v = await e.ix.vectorize(fakeEmbedder());
  assert.equal(v.turns, 1, "only the new turn should need a vector");
});

test("recall: a rewritten transcript is indexed again from scratch, and its vectors go", async t => {
  const e = setup(t);
  e.writeTurns(["alpha question", "alpha answer"]);
  await e.index();
  await e.ix.vectorize(fakeEmbedder());
  e.writeTurns(["a different opening", "alpha answer", "more"]);
  const s = await e.index();
  assert.equal(s.reindexed, 1);
  assert.deepEqual(e.rows("SELECT seq, text FROM recall_turns WHERE session = 's1' ORDER BY seq").map(r => r.text), ["a different opening", "alpha answer", "more"]);
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_vectors")[0].n, 0, "a stale vector survived a rewrite");
  assert.deepEqual(e.events.at(-1), { type: "session.indexed", session: "s1", from: 0, to: 2, rewritten: true });
});

test("recall: a transcript that shrank or changed at the end leaves nothing stale", async t => {
  const e = setup(t);
  e.writeTurns(["the long version", "about the intake form", "about the invoices", "about the site"]);
  await e.index();
  e.writeTurns(["the long version"]);
  await e.index();
  assert.deepEqual(e.rows("SELECT text FROM recall_turns").map(r => r.text), ["the long version"]);
  assert.equal(e.rows("SELECT turns FROM recall_sessions")[0].turns, 1);
  // Same count and first turn, different last turn: a rewrite, not a growth.
  e.writeTurns(["the long version", "the old ending"]);
  await e.index();
  e.writeTurns(["the long version", "a new ending", "and more"]);
  const s = await e.index();
  assert.equal(s.reindexed, 1);
  assert.deepEqual(e.rows("SELECT text FROM recall_turns ORDER BY seq").map(r => r.text), ["the long version", "a new ending", "and more"]);
});

test("recall: an mtime that went backwards is still a change", async t => {
  const e = setup(t);
  e.writeTurns(["aaaa", "the first answer"]);
  await e.index();
  e.writeTurns(["bbbb", "the OTHER answer"]);
  const old = new Date(Date.now() - 86_400_000);
  fs.utimesSync(e.file, old, old);
  const s = await e.index();
  assert.equal(s.skipped, 0, "an older mtime was mistaken for an unchanged file");
  assert.ok(e.rows("SELECT text FROM recall_turns").some(r => r.text === "the OTHER answer"));
});

test("recall: a renamed session takes its new name on the next pass", async t => {
  const e = setup(t);
  e.writeTurns(["start", "ok"]);
  fs.appendFileSync(e.file, JSON.stringify({ type: "custom-title", customTitle: "old name" }) + "\n");
  await e.index();
  fs.appendFileSync(e.file, JSON.stringify({ type: "custom-title", customTitle: "new name" }) + "\n");
  await e.index();
  assert.equal(e.rows("SELECT name FROM recall_sessions")[0].name, "new name");
});

test("recall: a transcript moved to another folder keeps its rows and learns its new path", async t => {
  const e = setup(t);
  e.writeTurns(["hello", "there"]);
  await e.index();
  const st = fs.statSync(e.file);
  const moved = path.join(e.dir, "-archived", "s1.jsonl");
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.renameSync(e.file, moved);
  fs.utimesSync(moved, st.atime, st.mtime);
  const s = await e.index();
  assert.equal(s.skipped, 1);
  assert.equal(e.rows("SELECT file FROM recall_sessions")[0].file, moved);
});

test("recall: a transcript that is gone keeps its history in the index", async t => {
  // Claude Code deletes old transcripts after a while; the index outlives them.
  const e = setup(t);
  e.writeTurns(["remember this", "remembered"]);
  await e.index();
  fs.rmSync(e.file);
  await e.index();
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_turns")[0].n, 2);
});

// ------------------------------------------------------------------ vectors

test("recall: chunking stays under the token wall, overlaps, and always moves forward", () => {
  assert.deepEqual(chunks(""), []);
  assert.deepEqual(chunks("short"), [{ off: 0, text: "short" }]);
  const long = ("word ".repeat(100) + "\n").repeat(10);
  const cs = chunks(long);
  assert.ok(cs.length > 1);
  assert.ok(cs.every(c => c.text.length <= CHUNK));
  assert.equal(cs[0].off, 0);
  for (let i = 1; i < cs.length; i++) assert.ok(cs[i].off < cs[i - 1].off + cs[i - 1].text.length, "chunks do not overlap");
  assert.ok(chunks("x".repeat(5000)).length > 1, "an unbroken blob was not cut");
  const v = Float32Array.from([0.5, -0.25, 1]);
  assert.deepEqual(decode(encode(v)), v);
  assert.throws(() => decode(Buffer.alloc(3)), /not a vector/);
  assert.equal(Math.round(cosine(v, v) * 1000), 1000);
});

test("recall: vectorize embeds each turn once, one chunk per piece, and is incremental", async t => {
  const e = setup(t);
  writeTranscripts(e.dir);
  await e.index();
  const emb = fakeEmbedder();
  const r = await e.ix.vectorize(emb);
  assert.equal(r.turns, 16);
  assert.equal(e.rows("SELECT COUNT(*) n FROM recall_vectors WHERE chunk = 0")[0].n, 16);
  assert.equal(e.rows("SELECT length(v) b FROM recall_vectors LIMIT 1")[0].b, 384 * 4);
  assert.equal((await e.ix.vectorize(emb)).turns, 0, "a second pass embedded again");
  assert.equal(e.ix.pending().length, 0);
});

test("recall: a turn deleted while it was being embedded gets no vector", async t => {
  // A re-index can delete a session mid-embed and reuse its seqs for different text. The vector
  // must not be written against the new text.
  const e = setup(t);
  e.writeTurns(["alpha question", "alpha answer"]);
  await e.index();
  const inner = fakeEmbedder();
  let rewrote = false;
  const racing = {
    model: "fake",
    async embed(text) {
      if (!rewrote) { rewrote = true; e.writeTurns(["a rewritten opening", "and a new answer"]); await e.index(); }
      return inner.embed(text);
    },
  };
  const r = await e.ix.vectorize(racing);
  assert.ok(r.gone >= 1, "the turn that changed underneath was not noticed");
  await e.ix.vectorize(inner);
  // Every stored vector must be the embedding of the text its (session, seq) holds now.
  for (const t of e.rows("SELECT session, seq, text FROM recall_turns")) {
    const [row] = e.rows("SELECT v FROM recall_vectors WHERE session = ? AND seq = ? AND chunk = 0", t.session, t.seq);
    assert.ok(row, "a current turn has no vector");
    assert.deepEqual(decode(row.v), await inner.embed(t.text), "a vector is attached to text it was not made from");
  }
});

// ------------------------------------------------------------------ search

async function corpus(t, { vectors = false } = {}) {
  const e = setup(t);
  writeTranscripts(e.dir);
  await e.index();
  if (vectors) await e.ix.vectorize(fakeEmbedder());
  return e;
}

test("recall: search finds turns with their session's name, title and folder", async t => {
  const e = await corpus(t);
  const { hits, hybrid } = await search(e.db, { q: "intake form" });
  assert.equal(hybrid, false);
  assert.ok(hits.length > 0);
  const top = hits[0];
  assert.deepEqual(Object.keys(top).sort(), ["cwd", "name", "role", "score", "seq", "session", "snippet", "text", "title", "ts"]);
  assert.equal(top.session, "11111111-aaaa-4000-8000-000000000001");
  assert.equal(top.name, "Harlow site rebuild");
  assert.match(top.snippet, /«intake» «form»/);
});

test("recall: search filters by role, by project folders and caps hits per session", async t => {
  const e = await corpus(t);
  const users = (await search(e.db, { q: "Northwind", role: "user" })).hits;
  assert.ok(users.length && users.every(h => h.role === "user"));
  const inHarlow = (await search(e.db, { q: "intake", project_cwds: ["/home/alex/Work/harlow-site/"] })).hits;
  assert.ok(inHarlow.length);
  assert.ok(inHarlow.every(h => h.cwd === "/home/alex/Work/harlow-site"), "a session outside the project's folder came back");
  const under = (await search(e.db, { q: "intake", project_cwds: ["/home/alex/Work"] })).hits;
  assert.ok(new Set(under.map(h => h.cwd)).size > 1, "sessions in subfolders of a project folder were missed");
  assert.equal((await search(e.db, { q: "intake", project_cwds: ["/home/alex/Work/harlow"] })).hits.length, 0, "a folder matched another folder that only starts with the same letters");
  const one = (await search(e.db, { q: "intake form", per_session: 1 })).hits;
  assert.equal(new Set(one.map(h => h.session)).size, one.length);
  // A project's attached sessions count wherever they ran; alone they scope as tightly.
  const outside = under.find(h => h.cwd !== "/home/alex/Work/harlow-site");
  const joined = (await search(e.db, { q: "intake", project_cwds: ["/home/alex/Work/harlow-site/"], sessions: [outside.session] })).hits;
  assert.ok(joined.some(h => h.session === outside.session), "an attached session outside the folder was missed");
  assert.ok(joined.every(h => h.cwd === "/home/alex/Work/harlow-site" || h.session === outside.session));
  assert.ok((await search(e.db, { q: "intake", sessions: [outside.session] })).hits.every(h => h.session === outside.session));
});

test("recall: FTS grammar in a query is a search, not a crash", async t => {
  const e = await corpus(t);
  assert.ok((await search(e.db, { q: "harlow-site" })).hits.length > 0, "a hyphenated term found nothing");
  for (const q of ['"quoted', "(with parens", "parens)", "*", "a-b-c-d", '"', "((", "NEAR", "AND", "OR", "^", "intake OR", "-", "text:"]) {
    const r = await search(e.db, { q });
    assert.ok(Array.isArray(r.hits), `search(${JSON.stringify(q)}) did not return hits`);
  }
  assert.deepEqual((await search(e.db, { q: "zygomorphic" })).hits, []);
  assert.deepEqual((await search(e.db, { q: "  " })).hits, []);
});

test("recall: a quoted phrase finds the phrase, not the words apart", async t => {
  const e = setup(t);
  e.writeTurns(["adjacency", "the intake form is broken"]);
  const other = path.join(e.dir, "-tmp-p", "s2.jsonl");
  fs.writeFileSync(other, JSON.stringify({ type: "user", message: { role: "user", content: "the form we use for intake of new matters" } }) + "\n");
  await e.index();
  assert.deepEqual((await search(e.db, { q: '"intake form"' })).hits.map(h => h.session), ["s1"]);
});

test("recall: a question in a sentence still finds turns through its words", async t => {
  const e = await corpus(t);
  assert.equal(anyOf("what is the invoice total?"), '"invoice" OR "total"');
  const { hits } = await search(e.db, { q: "what did Sam want on Fridays for the invoice total" });
  assert.ok(hits.some(h => h.session === "11111111-aaaa-4000-8000-000000000003"));
});

test("recall: hybrid re-ranks by meaning but never loses the top keyword hits", async t => {
  const e = await corpus(t, { vectors: true });
  const limit = 4;
  const kw = (await search(e.db, { q: "intake", limit, per_session: 0 }, null)).hits;
  const { hits, hybrid } = await search(e.db, { q: "intake", limit, per_session: 0 }, fakeEmbedder(), new Dense(e.db));
  assert.equal(hybrid, true);
  const pinned = kw.slice(0, Math.ceil(limit / 2)).map(h => `${h.session}:${h.seq}`);
  const got = hits.map(h => `${h.session}:${h.seq}`);
  for (const p of pinned) assert.ok(got.includes(p), "hybrid lost a turn the keyword search ranked at the top");
});

test("recall: hybrid degrades to keyword when the model throws or there are no vectors", async t => {
  const e = await corpus(t);
  const none = await search(e.db, { q: "intake" }, fakeEmbedder(), new Dense(e.db));
  assert.equal(none.hybrid, false, "claimed hybrid with no vectors stored");
  await e.ix.vectorize(fakeEmbedder());
  const broken = await search(e.db, { q: "intake" }, fakeEmbedder({ fail: true }), new Dense(e.db));
  assert.equal(broken.hybrid, false);
  assert.ok(broken.hits.length > 0, "a broken model took keyword search down with it");
});

test("recall: thread returns a session and its turns in order, by id or prefix", async t => {
  const e = await corpus(t);
  const r = thread(e.db, { session: "11111111-aaaa-4000-8000-000000000003" });
  assert.equal(r.session.name, "Northwind invoices");
  assert.deepEqual(r.turns.map(x => x.seq), [0, 1, 2, 3]);
  assert.deepEqual(thread(e.db, { session: "11111111-aaaa-4000-8000-000000000003", from: 2, limit: 1 }).turns.map(x => x.seq), [2]);
  assert.throws(() => thread(e.db, { session: "11111111" }), /more than one/);
  assert.throws(() => thread(e.db, { session: "nope" }), /no session/);
  assert.equal(thread(e.db, { session: "11111111-aaaa-4000-8000-000000000006" }).session.human, 0);
});

test("recall: sessions lists newest first, by folder, time and who started them", async t => {
  const e = await corpus(t);
  const all = sessions(e.db);
  assert.equal(all.length, SESSIONS.length);
  assert.ok(all.every((s, i) => i === 0 || Number(all[i - 1].ended) >= Number(s.ended)));
  assert.deepEqual(sessions(e.db, { cwd: "/home/alex/Work/northwind" }).map(s => s.id).sort(),
    ["11111111-aaaa-4000-8000-000000000003", "11111111-aaaa-4000-8000-000000000006"]);
  assert.equal(sessions(e.db, { human: false }).length, 2);
  assert.equal(sessions(e.db, { human: true, limit: 2 }).length, 2);
  assert.equal(sessions(e.db, { since: Date.parse("2026-09-01T11:30:00Z") }).length, 2);
  // ids: exact ids only, never a prefix, and an empty list is no sessions rather than all of them.
  const one = "11111111-aaaa-4000-8000-000000000003", four = "11111111-aaaa-4000-8000-000000000004";
  assert.deepEqual(sessions(e.db, { ids: [one, four, "nope"] }).map(s => s.id).sort(), [one, four]);
  assert.deepEqual(sessions(e.db, { ids: ["11111111"] }), []);
  assert.deepEqual(sessions(e.db, { ids: [] }), []);
  assert.deepEqual(sessions(e.db, { ids: [one, four], cwd: "/home/alex/Work/northwind" }).map(s => s.id), [one]);
});

// ------------------------------------------------------------------ dense retrieval

// Words that mean the same thing to the fake model and share nothing on the page.
const SAME = { blind: "accessibility", visitors: "problems", baker: "bakery", money: "dollars", spend: "total" };

test("recall: meaning alone finds a turn that shares no word with the question", async t => {
  const e = await corpus(t);
  const emb = fakeEmbedder({ same: SAME });
  await e.ix.vectorize(emb);
  const dense = new Dense(e.db);
  const blind = await search(e.db, { q: "blind visitors" }, emb, dense);
  assert.equal(blind.hybrid, true);
  assert.equal(blind.hits[0]?.session, "11111111-aaaa-4000-8000-000000000001/agent-a5ub", "the accessibility audit was not found");
  assert.equal(blind.hits[0]?.seq, 0);
  assert.match(blind.hits[0].snippet, /accessibility/, "a meaning hit must show the text its score came from");
  const baker = await search(e.db, { q: "baker money spend" }, emb, dense);
  assert.ok(baker.hits.some(h => h.session === "11111111-aaaa-4000-8000-000000000006" && h.seq === 1), "the invoice total was not found");
  assert.equal((await search(e.db, { q: "blind visitors" }, null, dense)).hits.length, 0, "keyword alone should find nothing here");
});

test("recall: a question with no near turn returns nothing, because of the floor", async t => {
  const e = await corpus(t);
  const emb = fakeEmbedder();
  await e.ix.vectorize(emb);
  assert.deepEqual((await search(e.db, { q: "zygomorphic quux" }, emb, new Dense(e.db))).hits, []);
  // The two measured corpora: the floor must sit between nonsense and real matches in each.
  assert.ok(floorFor(16) > 0.186 && floorFor(16) < 0.339, "the floor no longer fits the fixture measurement");
  assert.ok(floorFor(36878) > 0.413 && floorFor(36878) < 0.476, "the floor no longer fits the real-corpus measurement");
  assert.equal(floorFor(10_000_000), 0.45);
});

test("recall: dense retrieval honours role and project folders", async t => {
  const e = await corpus(t);
  const emb = fakeEmbedder({ same: SAME });
  await e.ix.vectorize(emb);
  const dense = new Dense(e.db);
  const asst = (await search(e.db, { q: "blind visitors", role: "assistant" }, emb, dense)).hits;
  assert.ok(asst.every(h => h.role === "assistant"));
  const elsewhere = (await search(e.db, { q: "blind visitors", project_cwds: ["/home/alex/Work/northwind"] }, emb, dense)).hits;
  assert.ok(elsewhere.every(h => h.cwd === "/home/alex/Work/northwind"), "a dense hit came from outside the project");
  const all = (await search(e.db, { q: "blind visitors" }, emb, dense)).hits;
  const far = all.find(h => h.cwd !== "/home/alex/Work/northwind");
  if (far) {
    const joined = (await search(e.db, { q: "blind visitors", project_cwds: ["/home/alex/Work/northwind"], sessions: [far.session] }, emb, dense)).hits;
    assert.ok(joined.some(h => h.session === far.session), "dense missed an attached session");
  }
});

test("recall: the exact keyword matches stay pinned when meaning disagrees", async t => {
  const e = await corpus(t);
  // A model that thinks "form" means "invoices" pulls the Northwind turns up by meaning.
  const emb = fakeEmbedder({ same: { form: "invoices", intake: "watcher" } });
  await e.ix.vectorize(emb);
  const limit = 4;
  const strict = (await search(e.db, { q: '"intake form"', limit, per_session: 0 })).hits.map(h => `${h.session}:${h.seq}`);
  const got = (await search(e.db, { q: "intake form", limit, per_session: 0 }, emb, new Dense(e.db))).hits.map(h => `${h.session}:${h.seq}`);
  for (const p of strict.slice(0, Math.ceil(limit / 2))) assert.ok(got.includes(p), "meaning pushed out an exact match");
});

test("recall: the dense index is a snapshot, and a stale one never mislabels a hit", async t => {
  const e = setup(t);
  const emb = fakeEmbedder({ same: SAME });
  e.writeTurns(["the accessibility problems in the form", "fixed"]);
  await e.index();
  await e.ix.vectorize(emb);
  const dense = new Dense(e.db);
  assert.equal((await search(e.db, { q: "blind visitors" }, emb, dense)).hits[0]?.seq, 0);
  assert.equal(dense.stats()?.chunks, 2);
  assert.ok((dense.stats()?.bytes || 0) > 2 * 384 * 4);
  // Rewrite the session without rebuilding: the old vector's (session, seq) now holds other text.
  e.writeTurns(["an unrelated opening about lunch", "fixed"]);
  await e.index();
  const stale = await search(e.db, { q: "blind visitors" }, emb, dense);
  assert.ok(!stale.hits.some(h => /lunch/.test(h.text)), "a stale vector's score was attached to new text");
  dense.invalidate();
  assert.equal(dense.stats(), null);
});

test("recall: the real model finds both questions and returns nothing for nonsense", async t => {
  let load;
  try { await import("@huggingface/transformers"); ({ load } = await import("./embed.js")); }
  catch { t.skip("the optional @huggingface/transformers package is not installed"); return; }
  // A shared cache outside any home, so the 23MB download happens once per machine, not per run.
  const { embedder, why } = await load({ cacheDir: path.join(os.tmpdir(), "vyre-test-models") });
  if (!embedder) { t.skip(`the model did not load: ${why}`); return; }
  const e = await corpus(t);
  await e.ix.vectorize(embedder);
  const dense = new Dense(e.db);
  const blind = (await search(e.db, { q: "making it easier for blind visitors" }, embedder, dense)).hits;
  assert.equal(blind[0]?.session, "11111111-aaaa-4000-8000-000000000001/agent-a5ub");
  const baker = (await search(e.db, { q: "how much money did the baker spend" }, embedder, dense)).hits;
  assert.ok(baker.slice(0, 3).some(h => h.session === "11111111-aaaa-4000-8000-000000000006" && h.seq === 1));
  for (const q of ["zygomorphic flux capacitor", "asdf qwerty", "purple elephants dancing on the moon"]) {
    assert.deepEqual((await search(e.db, { q }, embedder, dense)).hits, [], `nonsense returned hits: ${q}`);
  }
});

test("recall: new vectors are appended to the dense index in place, and a rewrite still rebuilds it", async t => {
  const e = setup(t);
  const emb = fakeEmbedder({ same: SAME });
  const dense = new Dense(e.db);
  const ix = new Indexer(e.db, { onVector: item => dense.add(item) });
  e.writeTurns(["the intake form question", "the intake form answer"]);
  await ix.run([e.dir]);
  await ix.vectorize(emb);
  await dense.build();
  assert.equal(dense.builds, 1);
  assert.equal(dense.stats()?.chunks, 2);

  // Many new turns: the arrays have to grow, and nothing is rebuilt.
  const more = ["the intake form question", "the intake form answer"];
  for (let i = 0; i < 100; i++) more.push(i === 99 ? "the accessibility problems in the audit" : `filler turn number ${i}`);
  e.writeTurns(more);
  await ix.run([e.dir]);
  await ix.vectorize(emb);
  assert.equal(dense.builds, 1, "appending new vectors rebuilt the whole index");
  assert.equal(dense.stats()?.chunks, 102);
  const hit = (await search(e.db, { q: "blind visitors" }, emb, dense)).hits[0];
  assert.equal(hit?.seq, 101, "an appended vector was not searchable");
  assert.equal(dense.builds, 1);

  // A new session is appended with its folder, so project filters still apply to it.
  fs.writeFileSync(path.join(e.dir, "-tmp-p", "s9.jsonl"), JSON.stringify({ type: "user", cwd: "/tmp/other", message: { role: "user", content: "accessibility problems elsewhere" } }) + "\n");
  await ix.run([e.dir]);
  await ix.vectorize(emb);
  const other = (await search(e.db, { q: "blind visitors", project_cwds: ["/tmp/other"] }, emb, dense)).hits;
  assert.deepEqual(other.map(h => h.session), ["s9"]);
  assert.equal(dense.builds, 1);

  // A rewrite deletes turns: that is the one thing that must rebuild.
  e.writeTurns(["a different opening", "and a different answer"]);
  await ix.run([e.dir]);
  await search(e.db, { q: "blind visitors" }, emb, dense);
  assert.equal(dense.builds, 2, "a rewrite did not rebuild the index");
});

test("recall: vectors that arrive during a build are not lost", async t => {
  const e = setup(t);
  const emb = fakeEmbedder({ same: SAME });
  const dense = new Dense(e.db);
  const ix = new Indexer(e.db, { onVector: item => dense.add(item) });
  e.writeTurns(["one", "two"]);
  await ix.run([e.dir]);
  await ix.vectorize(emb);
  const building = dense.build();
  e.writeTurns(["one", "two", "the accessibility problems"]);
  await ix.run([e.dir]);
  await ix.vectorize(emb);
  await building;
  assert.equal(dense.stats()?.chunks, 3);
  assert.equal((await search(e.db, { q: "blind visitors" }, emb, dense)).hits[0]?.seq, 2);
});

test("recall: prefix mode completes what is typed: every word a prefix, keyword only", async t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, SESSIONS);
  assert.equal(prefixOf("harl inta"), '"harl"* "inta"*');
  assert.equal(prefixOf("  "), null);
  const hits = (await search(db, { q: "harl inta", prefix: true, per_session: 1 })).hits;
  assert.ok(hits.length > 0);
  assert.ok(hits.every(h => /harl/i.test(h.text) && /inta/i.test(h.text)), JSON.stringify(hits.map(h => h.text)));
  // A half word in FTS5's grammar is still a prefix, never an error.
  assert.deepEqual((await search(db, { q: "north-(", prefix: true })).hybrid, false);
  assert.deepEqual((await search(db, { q: "zzzqx", prefix: true })).hits, []);
});
