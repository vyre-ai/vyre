// @ts-check
// Recall's index never keeps a value shaped like a sealed class: scrubbed on the way in, reported by a scan (counts, never a value), and rewritten by the owner-run scrub (only the
// matched spans change, the vectors made from a changed turn go, one log row without a value is kept). Synthetic values only.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { scrubText, scanIndex, scrubIndex, scrubLog } from "./sealed.js";
import { SESSIONS, writeTranscripts, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

const SSN = "078-05-1120";
const CARD = "4242 4242 4242 4242";

function mkdb(t) {
  const home = tempHome(t);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  return { home, db };
}
const turn = (db, session, seq, text) => db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text, provider, model) VALUES (?,?,?,?,?,?,?)").run(session, seq, "user", 1000 + seq, text, "claude", null);
const vec = (db, session, seq) => db.prepare("INSERT INTO recall_vectors (session, seq, chunk, off, v) VALUES (?,?,0,0,?)").run(session, seq, new Uint8Array(8));
const session = (db, id, title, name = null) => db.prepare("INSERT INTO recall_sessions (id, file, title, name, turns) VALUES (?,?,?,?,2)").run(id, "/x/" + id + ".jsonl", title, name);

test("scrubText rewrites only the matched span", () => {
  const r = scrubText(`my ssn is ${SSN} and the rest stays, ok`);
  assert.ok(r.classes.length >= 1);
  assert.ok(!r.text.includes(SSN));
  assert.ok(r.text.startsWith("my ssn is ") && r.text.endsWith(" and the rest stays, ok"));
  assert.deepEqual(scrubText("nothing sealed here 12 apples"), { text: "nothing sealed here 12 apples", classes: [] });
  assert.equal(scrubText(r.text).text, r.text, "idempotent: a placeholder is not matched again");
});

test("on the way in: a transcript with sealed shapes is indexed with placeholders, titles included, and a second pass appends cleanly", async t => {
  const { home, db } = mkdb(t);
  const dir = path.join(home, "transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const sessions = JSON.parse(JSON.stringify(SESSIONS));
  const first = sessions[0];
  const u = first.turns.find(x => x.role === "user");
  u.text = `${u.text} my card is ${CARD} thanks`;
  writeTranscripts(dir, sessions);
  const ix = new Indexer(db);
  await ix.run([dir]);
  const all = db.prepare("SELECT text FROM recall_turns").all().map(r => String(r.text)).join("\n");
  assert.ok(!all.includes("4242 4242 4242 4242") && !all.includes("4242424242424242"), "no card in the index");
  assert.match(all, /my card is .*thanks/);
  const again = await ix.run([dir]);
  assert.equal(again.reindexed, 0, "the scrubbed text is what a later pass compares against, so nothing is re-indexed");
  assert.deepEqual(scanIndex(db).found, []);
});

test("scan reports table, column, rows and classes, never a value, and changes nothing", t => {
  const { db } = mkdb(t);
  session(db, "s1", `about ${SSN}`, "plain");
  turn(db, "s1", 0, `ssn ${SSN}`); turn(db, "s1", 1, "fine"); vec(db, "s1", 0); vec(db, "s1", 1);
  const before = JSON.stringify(db.prepare("SELECT rowid, * FROM recall_turns").all());
  const r = scanIndex(db);
  assert.deepEqual(r.found.map(f => [f.table, f.column, f.rows]), [["recall_turns", "text", 1], ["recall_sessions", "title", 1]]);
  assert.equal(r.vectors, 1);
  assert.ok(!JSON.stringify(r).includes(SSN));
  assert.equal(JSON.stringify(db.prepare("SELECT rowid, * FROM recall_turns").all()), before, "nothing changed");
});

test("scrub rewrites only matched spans, drops only the matched turns' vectors, bumps the generation, logs without a value, and a second run finds nothing", t => {
  const { db } = mkdb(t);
  session(db, "s1", `about ${SSN}`, "plain");
  turn(db, "s1", 0, `before ${SSN} after`); turn(db, "s1", 1, "untouched turn"); turn(db, "s2", 0, `card ${CARD}`);
  vec(db, "s1", 0); vec(db, "s1", 1); vec(db, "s2", 0);
  const other = db.prepare("SELECT rowid, session, seq, role, ts, text FROM recall_turns WHERE session = 's1' AND seq = 1").get();
  const r = scrubIndex(db, { batch: 1, now: () => 42 });
  assert.deepEqual([r.turns, r.titles, r.names, r.vectors], [2, 1, 0, 2]);
  const rows = db.prepare("SELECT session, seq, ts, text FROM recall_turns ORDER BY rowid").all();
  assert.ok(rows[0].text.startsWith("before ") && rows[0].text.endsWith(" after") && !rows[0].text.includes(SSN));
  assert.equal(rows[0].ts, 1000);
  assert.equal(JSON.stringify(db.prepare("SELECT rowid, session, seq, role, ts, text FROM recall_turns WHERE session = 's1' AND seq = 1").get()), JSON.stringify(other), "an untouched turn is byte for byte the same");
  assert.deepEqual(db.prepare("SELECT session, seq FROM recall_vectors").all().map(v => [v.session, v.seq]), [["s1", 1]]);
  assert.equal(db.prepare("SELECT v FROM recall_meta WHERE k = 'generation'").get().v, "1");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recall_turns WHERE recall_turns MATCH 'before'").get().n, 1, "full-text search still finds the turn by its other words");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recall_turns WHERE recall_turns MATCH '078'").get().n, 0, "and no longer by the value");
  const log = scrubLog(db);
  assert.equal(log.length, 1);
  assert.equal(log[0].at, 42);
  assert.ok(!JSON.stringify(log).includes(SSN) && !JSON.stringify(log).includes("4242"));
  assert.deepEqual(scanIndex(db).found, []);
  const again = scrubIndex(db);
  assert.deepEqual([again.turns, again.titles, again.vectors], [0, 0, 0]);
});

test("the tools are registered with the right door: the scrub needs presence and no agent or module may call either", async t => {
  const { db } = mkdb(t);
  const tools = new Map();
  const { default: recall } = await import("./index.js");
  const ctx = { name: "recall", config: {}, paths: { root: tempHome(t) }, store: { db, migrate: () => {} }, log: () => {}, events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 }, call: async () => ({}), tool: (n, d, o) => tools.set(n, { ...d, ...(o || {}) }) };
  let h;
  try { h = await recall.start(ctx); } catch { /* the embedder is optional: the tools are registered before it is needed */ }
  t.after(() => h && h.stop && h.stop());
  for (const n of ["recall.sealscan", "recall.sealscrub"]) {
    const d = tools.get(n);
    assert.ok(d, n);
    assert.deepEqual(d.callers, ["cli", "local", "deck", "capsule"], n);
  }
  assert.ok(tools.get("recall.sealscrub").presence, "the scrub asks for presence");
  assert.ok(!tools.get("recall.sealscan").presence, "the scan changes nothing");
});
