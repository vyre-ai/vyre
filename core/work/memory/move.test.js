// @ts-check
// The Work engine's lines move with a project: rewritten through the id map, labels pointed at the target Space, idempotent, forgotten only against the receipt.
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { exportKnow, importKnow, forgetKnow } from "./move.js";

const SCHEMA = `
  CREATE TABLE memory_engine_lines (session TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL, trust TEXT NOT NULL, red TEXT NOT NULL, spaces TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (session, seq));
  CREATE TABLE memory_engine_index (source TEXT PRIMARY KEY, kind TEXT NOT NULL, resource TEXT NOT NULL, text TEXT NOT NULL, vec TEXT, trust TEXT NOT NULL, red TEXT NOT NULL, spaces TEXT NOT NULL);
  CREATE TABLE memory_engine_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, record TEXT NOT NULL, value TEXT NOT NULL);
  CREATE TABLE memory_engine_proposals (key TEXT PRIMARY KEY, record TEXT NOT NULL, task TEXT NOT NULL, at INTEGER NOT NULL);`;
const mk = () => { const db = new DatabaseSync(":memory:"); db.exec(SCHEMA); return db; };
const P = "vyre://A/project/p1", CH = "vyre://A/chat/c1", OTHER = "vyre://A/project/p2";
function seed(db) {
  const ins = db.prepare("INSERT INTO memory_engine_lines VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("s1", 1, "user", "hello", 1, "internal", "internal", JSON.stringify(["A"]), CH);
  ins.run("s1", 2, "assistant", "hi", 2, "internal", "internal", JSON.stringify(["A", "Z"]), CH);
  ins.run("s2", 1, "user", "project wide", 3, "internal", "internal", JSON.stringify(["A"]), P);
  ins.run("s3", 1, "user", "someone else's", 4, "internal", "internal", JSON.stringify(["A"]), OTHER);
  db.prepare("INSERT INTO memory_engine_index VALUES (?,?,?,?,?,?,?,?)").run("line:s1#1", "lines", CH, "hello", null, "internal", "internal", "[]");
  db.prepare("INSERT INTO memory_engine_suggestions (record, value) VALUES (?,?)").run(P, "x");
}

test("the lines of a project's records move with their record rewritten and the labels pointed at the target; another project's lines stay", () => {
  const a = mk(), b = mk(); seed(a);
  const out = exportKnow(a, { records: [P, CH] });
  assert.equal(out.count, 3);
  const r = importKnow(b, out.rows, { map: { [P]: "vyre://B/project/q1", [CH]: "vyre://B/chat/d1" }, from: "A", to: "B" });
  assert.equal(r.count, 3);
  assert.deepEqual(r.sessions.sort(), ["s1", "s2"]);
  const rows = b.prepare("SELECT session, seq, record, spaces FROM memory_engine_lines ORDER BY session, seq").all();
  assert.deepEqual(rows.map(x => [x.session, x.seq, x.record]), [["s1", 1, "vyre://B/chat/d1"], ["s1", 2, "vyre://B/chat/d1"], ["s2", 1, "vyre://B/project/q1"]]);
  assert.deepEqual(JSON.parse(rows[1].spaces), ["B", "Z"], "the source Space is replaced by the target");
  assert.equal(importKnow(b, out.rows, { map: { [P]: "vyre://B/project/q1", [CH]: "vyre://B/chat/d1" }, from: "A", to: "B" }).digest, r.digest, "a repeat gives the same receipt");
  assert.equal(b.prepare("SELECT count(*) AS n FROM memory_engine_lines").get().n, 3, "and no extra rows");
});

test("a line naming a record that did not move is refused and nothing is written", () => {
  const a = mk(), b = mk(); seed(a);
  const out = exportKnow(a, { records: [P, CH] });
  assert.throws(() => importKnow(b, out.rows, { map: { [P]: "vyre://B/project/q1" }, from: "A", to: "B" }), /did not move/);
  assert.equal(b.prepare("SELECT count(*) AS n FROM memory_engine_lines").get().n, 0);
});

test("forget needs the receipt, refuses when the lines changed since, and drops the derived rows with the lines", () => {
  const a = mk(); seed(a);
  const out = exportKnow(a, { records: [P, CH] });
  assert.throws(() => forgetKnow(a, { records: [P, CH], receipt: { digest: "wrong", count: 3 } }), /changed since/);
  a.prepare("INSERT INTO memory_engine_lines VALUES ('s1',3,'user','late',9,'internal','internal','[]',?)").run(CH);
  assert.throws(() => forgetKnow(a, { records: [P, CH], receipt: out }), /changed since/, "a line added after the export");
  a.prepare("DELETE FROM memory_engine_lines WHERE seq = 3 AND session = 's1'").run();
  assert.deepEqual(forgetKnow(a, { records: [P, CH], receipt: out }), { forgotten: 3 });
  assert.equal(a.prepare("SELECT count(*) AS n FROM memory_engine_lines").get().n, 1, "only the other project's line is left");
  assert.equal(a.prepare("SELECT count(*) AS n FROM memory_engine_index").get().n, 0);
  assert.equal(a.prepare("SELECT count(*) AS n FROM memory_engine_suggestions").get().n, 0);
});

test("forget is idempotent: after the lines are gone a repeat is a no-op, so a resumed move completes", () => {
  const a = mk(); seed(a);
  const out = exportKnow(a, { records: [P, CH] });
  assert.deepEqual(forgetKnow(a, { records: [P, CH], receipt: out }), { forgotten: 3 });
  assert.deepEqual(forgetKnow(a, { records: [P, CH], receipt: out }), { forgotten: 0 }, "a second forget finds nothing and succeeds");
  assert.throws(() => forgetKnow(a, { records: [P, CH], receipt: null }), /changed since/ , "but never without a receipt, while lines remain");
});
