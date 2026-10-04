import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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
