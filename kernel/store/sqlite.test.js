import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { conformance, CONTACT } from "../conformance/suite.js";
import { createSqliteStore } from "./sqlite.js";

const file = () => path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-sqlstore-")), "kernel.db");
// The same suite that defines the reference store defines this one.
conformance(async () => createSqliteStore({ db: new DatabaseSync(":memory:") }), { test, assert }, "sqlite");

test("sqlite store: everything survives a restart (types, records, versions, the bin, the change feed)", async () => {
  const f = file();
  let s = createSqliteStore({ db: new DatabaseSync(f) });
  await s.define({ add_types: [CONTACT] });
  const id = "0190c3f2-1111-4abc-8def-000000000001", id2 = "0190c3f2-1111-4abc-8def-000000000002";
  await s.create("contact", id, { name: "Jane", age: 41 });
  await s.update("contact", id, { age: 42 }, 1);
  await s.create("contact", id2, { name: "Bin" });
  await s.remove("contact", id2, 1);
  const feed = await s.changes(null, 10);
  s = createSqliteStore({ db: new DatabaseSync(f) });
  const r = await s.get("contact", id);
  assert.deepEqual([r.data.age, r.version], [42, 2]);
  assert.equal(await s.get("contact", id2), null);
  assert.equal((await s.get("contact", id2, { include_deleted: true })).version, 2);
  assert.deepEqual(await s.changes(null, 10), feed);
  assert.deepEqual((await s.types()).map(t => t.name), ["contact"]);
  await assert.rejects(() => s.update("contact", id, { age: 1 }, 1), { code: "version_conflict" });
  assert.equal((await s.update("contact", id, { age: 43 }, 2)).version, 3);
  assert.equal((await s.version()).store, "sqlite");
});

test("sqlite log: events, their salts and cursors survive a restart; erase survives; a row edited on disk fails the chain", async () => {
  const { createSqliteEventLog } = await import("./sqlite-log.js");
  const { createChainBuilder } = await import("../core/chain.js");
  const { verifyEvents } = await import("../core/events.js");
  const SPACE = "spc_aaaaaaaaaaaa";
  const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 1) });
  const ch = chains.fromFacts({ kind: "module", module: "x", first_party: true });
  const f = file();
  let log = createSqliteEventLog({ db: new DatabaseSync(f), space: SPACE });
  for (let i = 0; i < 4; i++) log.append(ch, { type: "note.added", sv: 1, subject: `vyre://${SPACE}/note/${i}`, data: { i } });
  log.erase(2);
  const before = log.read({}).map(e => e.hash);
  log = createSqliteEventLog({ db: new DatabaseSync(f), space: SPACE });
  assert.deepEqual(log.read({}).map(e => e.hash), before);
  assert.equal(log.latestSeq(), 4);
  assert.equal(log.proves(1), true, "the salt came back with the event");
  assert.equal(log.proves(2), false, "the erased one stays erased");
  assert.deepEqual(log.verify().ok, true);
  const e5 = log.append(ch, { type: "note.added", sv: 1, subject: `vyre://${SPACE}/note/5`, data: {} });
  assert.equal(e5.seq, 5);
  assert.equal(e5.prev, before[3], "the chain continues from the stored head");
  // a row edited on disk
  const db = new DatabaseSync(f);
  const row = db.prepare("SELECT event FROM kernel_events WHERE seq = 3").get();
  db.prepare("UPDATE kernel_events SET event = ? WHERE seq = 3").run(row.event.replace('"i":2', '"i":99').replace(/"type":"note.added"/, '"type":"note.edited"'));
  const reread = createSqliteEventLog({ db: new DatabaseSync(f), space: SPACE });
  assert.equal(verifyEvents(SPACE, reread.read({})).ok, false);
});

test("sqlite store scrub: a field sealed in place leaves no plain value in the change log, the file's free pages, the write-ahead log or the search index; other fields and other types are untouched", async () => {
  const f = file();
  const PLAIN = "PLAINSECRET-4471-ssn";
  let db = new DatabaseSync(f);
  db.exec("PRAGMA journal_mode = WAL");
  const s = createSqliteStore({ db });
  await s.define({ add_types: [{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "ssn", kind: "text", label: "SSN" }] }, CONTACT] });
  const ids = Array.from({ length: 40 }, (_, i) => `0190c3f2-1111-4abc-8def-${String(i + 1).padStart(12, "0")}`);
  for (const [i, id] of ids.entries()) { await s.create("person", id, { name: `Pat ${i}`, ssn: `${PLAIN}-${i}` }); await s.update("person", id, { ssn: `${PLAIN}-${i}-v2` }, 1); }
  await s.create("contact", "0190c3f2-2222-4abc-8def-000000000001", { name: `keep ${PLAIN} elsewhere` });
  // sealing in place: the values move into a sealed field elsewhere and the plain field is emptied on every record
  for (const id of ids) { const r = await s.get("person", id); await s.update("person", id, { ssn: null }, r.version); }
  await s.scrub("person", ["ssn"]);
  const entries = db.prepare("SELECT entry FROM kernel_changes").all().map(r => JSON.parse(r.entry));
  const mine = entries.filter(e => e.type === "person");
  assert.ok(mine.length >= 80, "the person entries are still there");
  for (const e of mine) for (const side of ["before", "after"]) if (e[side]) { assert.equal(Object.hasOwn(e[side], "ssn"), false, "no ssn key left"); assert.ok(Object.hasOwn(e[side], "name") || side === "before", "other fields are kept"); }
  const other = entries.filter(e => e.type === "contact");
  assert.ok(JSON.stringify(other).includes(PLAIN), "another type's log is untouched");
  assert.equal((await s.get("person", ids[0])).data.name, "Pat 0");
  db.close();
  // the bytes on disk: the person's plain values are gone from the main file and the write-ahead log (the other type's copy is the only one left)
  const bytes = fs.readFileSync(f, "latin1") + (fs.existsSync(f + "-wal") ? fs.readFileSync(f + "-wal", "latin1") : "");
  const left = bytes.split(`${PLAIN}-`).length - 1;
  assert.equal(left, 0, `no copy of the sealed field's values remains on disk (found ${left})`);
  assert.ok(bytes.includes(`keep ${PLAIN} elsewhere`), "the other type's own value is still stored");
});

test("sqlite store counts: count by stage is read from kept counts and always equals the scan, through creates, edits, removes, restores, a restart, a rolled-back write and a changed definition", async () => {
  const f = file();
  const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }] };
  let db = new DatabaseSync(f);
  let s = createSqliteStore({ db });
  await s.define({ add_types: [MATTER] });
  const id = i => `0190c3f2-1111-4abc-8def-${String(i + 1).padStart(12, "0")}`;
  const spec = { group_by: ["stage"], measures: [{ fn: "count" }] };
  const kept = st => st.aggregate("matter", spec);
  const scan = st => st.aggregate("matter", { ...spec, filter: { and: [] } });   // a filter takes the planner's GROUP BY, the reference
  const same = async (st, what) => assert.deepEqual(await kept(st), await scan(st), what);
  const stages = ["intake", "open", "closed", undefined];
  for (let i = 0; i < 40; i++) await s.create("matter", id(i), { title: `M${i}`, ...(stages[i % 4] ? { stage: stages[i % 4] } : {}) });
  const before = s.stats().aggregate_pushed;
  await same(s, "built from the table on the first ask");
  // maintained by every kind of write
  for (let i = 0; i < 40; i += 3) { const r = await s.get("matter", id(i)); await s.update("matter", id(i), { stage: stages[(i + 1) % 3] }, r.version); }
  for (let i = 1; i < 40; i += 5) { const r = await s.get("matter", id(i)); await s.remove("matter", id(i), r.version); }
  await same(s, "after edits and removes");
  for (let i = 1; i < 40; i += 10) await s.restore("matter", id(i));
  for (let i = 40; i < 50; i++) await s.create("matter", id(i), { title: `N${i}`, stage: "open" });
  await same(s, "after restores and creates");
  assert.ok(s.stats().aggregate_pushed > before);
  // a restart keeps the counts and they still agree
  db.close(); db = new DatabaseSync(f); s = createSqliteStore({ db });
  await same(s, "after a restart");
  const r0 = await s.get("matter", id(2));
  await s.update("matter", id(2), { stage: "closed" }, r0.version);
  await same(s, "after a restart and a write");
  // a write rolled back in a transaction leaves the counts as they were (they are part of it)
  const want = JSON.stringify(await kept(s));
  db.exec("BEGIN");
  const r1 = await s.get("matter", id(3));
  await s.update("matter", id(3), { stage: "closed" }, r1.version);
  db.exec("ROLLBACK");
  await s.undo("matter", id(3), r1);
  assert.equal(JSON.stringify(await kept(s)), want, "a rolled-back write moved nothing");
  await same(s, "after a rollback");
  // a changed definition drops the counts and they are built again
  await s.define({ change_types: [{ ...MATTER, fields: [...MATTER.fields, { name: "extra", kind: "text", label: "Extra" }] }] });
  await same(s, "after the definition changed");
  // anything but a plain count by one stage field is not answered from the counts
  assert.deepEqual((await s.aggregate("matter", { group_by: ["stage"], measures: [{ fn: "count" }], filter: { field: "stage", op: "eq", value: "open" } })).map(g => g.group.stage), ["open"]);
  db.close();
});

test("sqlite store counts: two writers changing a stage at the same moment, and a kill between the row write and the count upsert, both leave the kept count equal to the scan", async () => {
  const f = file();
  const MATTER = { name: "matter", label: "Matter", fields: [{ name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }] };
  const db = new DatabaseSync(f);
  db.exec("PRAGMA journal_mode = WAL");
  const s = createSqliteStore({ db });
  await s.define({ add_types: [MATTER] });
  const id = i => `0190c3f2-1111-4abc-8def-${String(i + 1).padStart(12, "0")}`;
  const spec = { group_by: ["stage"], measures: [{ fn: "count" }] };
  const same = async (st, what) => assert.deepEqual(await st.aggregate("matter", spec), await st.aggregate("matter", { ...spec, filter: { and: [] } }), what);
  for (let i = 0; i < 30; i++) await s.create("matter", id(i), { stage: ["intake", "open", "closed"][i % 3] });
  await same(s, "built");
  // many writers at once, several on the same record (the losers get version_conflict) and several on different ones
  const moves = [];
  for (let w = 0; w < 60; w++) moves.push((async () => { const i = w % 10, r = await s.get("matter", id(i)); try { await s.update("matter", id(i), { stage: ["open", "closed", "intake"][w % 3] }, r.version); } catch (e) { if (e.code !== "version_conflict") throw e; } })());
  await Promise.all(moves);
  await same(s, "after concurrent stage changes");
  db.close();
  // a kill between the row write and the count upsert: neither moved
  const f2 = file();
  const child = spawnSync(process.execPath, [path.join(path.dirname(new URL(import.meta.url).pathname), "counts-crash.child.mjs"), f2], { encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", `the child was killed mid-write: ${child.stderr}`);
  assert.doesNotMatch(child.stdout, /survived/);
  const db2 = new DatabaseSync(f2);
  db2.function("die", () => 0);   // the child's triggers name it; here it does nothing
  const after = createSqliteStore({ db: db2 });
  assert.equal((await after.get("matter", id(0))).data.stage, "intake", "the row did not move");
  const kept = await after.aggregate("matter", spec);
  assert.deepEqual(kept, await after.aggregate("matter", { ...spec, filter: { and: [] } }), "the kept count equals the scan");
  assert.deepEqual(kept.map(g => [g.group.stage, g.values.count]), [["intake", 3], ["open", 3]]);
});

test("sqlite store forget: a live record leaves its kept stage counts, its attribute row and its cache entry, and nothing of it is left in the file or the log; a rolled-back forget changes nothing", async () => {
  const f = file();
  const MATTER = { name: "matter", label: "Matter", fields: [{ name: "title", kind: "text", label: "Title" }, { name: "stage", kind: "stage", label: "Stage", options: ["intake", "open", "closed"] }] };
  let db = new DatabaseSync(f);
  db.exec("PRAGMA journal_mode = WAL");
  let s = createSqliteStore({ db });
  await s.define({ add_types: [MATTER] });
  const id = i => `0190c3f2-1111-4abc-8def-${String(i + 1).padStart(12, "0")}`;
  const urn = i => `vyre://spc_aaaaaaaaaaaa/matter/${id(i)}`;
  const spec = { group_by: ["stage"], measures: [{ fn: "count" }] };
  const kept = st => st.aggregate("matter", spec);
  const scan = st => st.aggregate("matter", { ...spec, filter: { and: [] } });
  const same = async (st, what) => assert.deepEqual(await kept(st), await scan(st), what);
  const MARK = "Zebulon-Quartz-Unique-Marker";
  for (let i = 0; i < 12; i++) { await s.create("matter", id(i), { title: i === 3 ? `${MARK} contract` : `M${i}`, stage: ["intake", "open", "closed"][i % 3] }); s.meta.set(urn(i), { project: i === 3 ? `proj-${MARK}` : "p", owner: "per_x" }); }
  await same(s, "counts built");
  // a rolled-back forget (inside a caller's transaction that fails) changes nothing
  db.exec("BEGIN");
  await s.destroy("matter", id(3));
  db.exec("ROLLBACK");
  await same(s, "rolled back: counts equal a scan");
  assert.equal((await s.get("matter", id(3))).data.stage, "intake");
  assert.ok(db.prepare("SELECT 1 FROM kernel_attrs WHERE urn = ?").get(urn(3)), "the attribute row is back");
  // the real forget
  const total = async st => (await st.aggregate("matter", spec)).reduce((n, g) => n + g.values.count, 0);
  assert.equal(await total(s), 12);
  s.meta.get(urn(3));
  await s.destroy("matter", id(3));
  assert.equal(await total(s), 11, "the kept counts lost the record");
  await same(s, "forgotten: counts equal a scan");
  assert.equal(await s.get("matter", id(3), { include_deleted: true }), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM kernel_attrs WHERE urn LIKE ?").get(`%${id(3)}`).n, 0, "no attribute row");
  assert.equal(s.meta.get(urn(3)), undefined, "no cache entry");
  assert.equal(s.stats().hot_attrs, 11);
  // a removed record forgotten does not take a count it no longer held
  await s.remove("matter", id(4), 1);
  await same(s, "after remove");
  await s.destroy("matter", id(4));
  await same(s, "a removed record forgotten");
  // restart
  db.close();
  db = new DatabaseSync(f);
  s = createSqliteStore({ db });
  await same(s, "after a restart");
  assert.equal(await total(s), 10);
  db.close();
  const bytes = fs.readFileSync(f, "latin1") + (fs.existsSync(f + "-wal") ? fs.readFileSync(f + "-wal", "latin1") : "");
  assert.equal(bytes.split(MARK).length - 1, 0, "no byte of the forgotten record's text or attribute remains in the file or the write-ahead log");
});
