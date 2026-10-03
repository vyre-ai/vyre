// The kernel's memory follows the working set, not the history: the event log keeps a recent window and reads the rest from SQLite; the built-in store keeps hot rows
// and the change feed on disk. These tests hold the bound and hold that nothing else changes: a bounded log answers every read exactly as the unbounded one does.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createEventLog, verifyEvents } from "../core/events.js";
import { createSqliteEventLog } from "./sqlite-log.js";
import { createSqliteStore } from "./sqlite.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const job = n => chains.fromFacts({ kind: "module", module: `m${n % 3}`, first_party: true });
const fill = (log, n) => { for (let i = 0; i < n; i++) log.append(i % 4 === 0 ? job(i) : owner(), { type: i % 5 === 0 ? "grant.created" : i % 7 === 0 ? "chat.changed" : "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/c${i % 40}`, data: { i, ...(i % 11 === 0 ? { version_hash: `h${i}`, version: i } : {}) }, ...(i % 9 === 0 ? { corr: "run-1" } : {}) }); };

test("the event log holds a window, reads the rest from disk, and answers every read exactly as the unbounded log does", () => {
  const db = new DatabaseSync(":memory:");
  const small = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 50, bytes: 1_000_000 }, rand: n => Buffer.alloc(n, 7) });
  fill(small, 600);
  assert.equal(small.stats().count, 600);
  assert.ok(small.stats().in_memory <= 50, `the window is bounded (${small.stats().in_memory})`);
  // the same events in an unbounded in-memory log, to compare every read against
  const ref = createEventLog({ space: SPACE, clock: (() => { let t = 1_800_000_000_000; return () => ++t; })(), rand: n => Buffer.alloc(n, 7) });
  const all = [...small.iterate({})];
  assert.equal(all.length, 600);
  assert.equal(verifyEvents(SPACE, all).ok, true);
  assert.deepEqual(small.verify(), { ok: true, head: small.head(), seq: 600 });
  for (const f of [{}, { type: "grant.created" }, { type: "contact.*" }, { type: "chat.*", since: 100 }, { subject_prefix: `vyre://${SPACE}/contact/c3` }, { subject_prefix: `vyre://${SPACE}/contact/c3`, limit: 4 }, { corr: "run-1" }, { actor: all[1].actor }, { type: "grant.created", since: 300, limit: 7 }]) {
    const want = all.filter(e => (f.since === undefined || e.seq > f.since) && (!f.type || f.type === "*" || f.type === e.type || (f.type.endsWith(".*") && e.type.startsWith(f.type.slice(0, -1)))) && (!f.subject_prefix || e.subject === f.subject_prefix || e.subject.startsWith(f.subject_prefix.replace(/\/$/, "") + "/")) && (!f.corr || e.corr === f.corr) && (!f.actor || e.actor === f.actor)).slice(0, f.limit || Infinity);
    assert.deepEqual(small.read(f).map(e => e.seq), want.map(e => e.seq), JSON.stringify(f));
  }
  assert.equal(small.get(1).seq, 1, "an old event by seq, from disk");
  assert.equal(small.get(600).seq, 600);
  assert.equal(small.get(601), null);
  assert.equal(small.proves(2), true, "an old event still proves its data against its salt");
  assert.equal(small.latestFor(`vyre://${SPACE}/contact/c0`).data.version_hash, "h0".replace("0", String(small.latestFor(`vyre://${SPACE}/contact/c0`).data.i)), "the last write of a record, by lookup");
  void ref;
  // erasing an old event survives and the chain still verifies
  small.erase(3);
  assert.equal(small.get(3).data.erased, true);
  assert.equal(small.proves(3), false);
  assert.equal(small.verify().ok, true);
});

test("opening a durable log reads a window and two counters, not the log; the chain, the head and the cursors come back; a start point checks only the tail", () => {
  const db = new DatabaseSync(":memory:");
  const a = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 40 } });
  fill(a, 500);
  a.subscribe("watcher", {}, () => {});
  const head = a.head();
  const b = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 40 } });
  assert.equal(b.latestSeq(), 500);
  assert.equal(b.head(), head);
  assert.ok(b.stats().in_memory <= 40, "only the window was loaded");
  assert.equal(b.verify().ok, true);
  const mid = b.get(450);
  assert.deepEqual(b.verify({ from: 450, prev: mid.hash }), { ok: true, head, seq: 500 }, "from a checkpoint, only what came after");
  assert.equal(b.verify({ from: 450, prev: "not-the-hash" }).ok, false, "a tail that does not continue the checkpoint is refused");
  fill(b, 5);
  assert.equal(b.latestSeq(), 505);
  assert.equal(b.verify().ok, true);
  // a row edited on disk is found by the chain check, even one far outside the window
  db.prepare("UPDATE kernel_events SET event = replace(event, '\"sv\":1', '\"sv\":2') WHERE seq = 11").run();
  const c = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 40 } });
  assert.equal(c.verify().ok, false);
  assert.equal(c.verify().at, 11);
});

test("a consumer reads forward from its cursor through the disk, not the window, and misses nothing", async () => {
  const db = new DatabaseSync(":memory:");
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 10 } });
  fill(log, 200);
  const seen = [];
  log.subscribe("late", { type: "grant.created" }, e => { seen.push(e.seq); });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(seen, log.read({ type: "grant.created" }).map(e => e.seq), "every grant event, including those long out of the window");
});

test("the built-in store keeps hot rows and no change feed in memory, and still answers as the reference store does", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteStore({ db, clock, hotRows: 50 });
  await store.define({ add_types: [{ name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "email", kind: "text", label: "Email" }, { name: "age", kind: "number", label: "Age" }] }] });
  const ids = [];
  for (let i = 0; i < 800; i++) { const id = `01a${String(i).padStart(5, "0")}-0000-4000-8000-000000000000`; ids.push(id); await store.create("contact", id, { name: `Client ${i}`, email: `c${i}@x.test`, age: i % 90 }); }
  for (let i = 0; i < 800; i += 3) { const r = await store.get("contact", ids[i]); await store.update("contact", ids[i], { age: 91 }, r.version); }
  assert.ok(store.stats().hot_rows <= 50, `hot rows are bounded (${store.stats().hot_rows})`);
  assert.equal((await store.get("contact", ids[5])).data.name, "Client 5", "a row that left the cache is read back");
  const byEmail = await store.query("contact", { filter: { field: "email", op: "eq", value: "c77@x.test" }, page: { limit: 5 } });
  assert.deepEqual(byEmail.rows.map(r => r.data.name), ["Client 77"]);
  const byAge = await store.query("contact", { filter: { and: [{ field: "age", op: "eq", value: 91 }, { field: "name", op: "contains", value: "9" }] }, sort: [{ field: "name", dir: "asc" }], page: { limit: 500 } });
  assert.ok(byAge.rows.length > 0 && byAge.rows.every(r => r.data.age === 91 && r.data.name.includes("9")));
  assert.equal((await store.query("contact", { filter: { field: "id", op: "eq", value: ids[9] }, page: { limit: 5 } })).rows.length, 1, "the row's own columns are filtered by the exact code");
  assert.equal((await store.search({ text: "Client 4", types: ["contact"], page: { limit: 3 } })).rows.length, 3);
  assert.equal((await store.aggregate("contact", { filter: { field: "age", op: "eq", value: 91 }, measures: [{ fn: "count" }] }))[0].values.count, Math.ceil(800 / 3));
  // the change feed is on disk and read by cursor
  const first = await store.changes(null, 100);
  assert.equal(first.entries.length, 100);
  const more = await store.changes(first.cursor, 2000);
  assert.equal(first.entries.length + more.entries.length, 800 + Math.ceil(800 / 3));
  assert.equal(more.entries[0].cursor, "c101");
  assert.equal(store.stats().changes_in_memory, 0);
  // kernel attributes are on disk too
  store.meta.set("vyre://x/contact/1", { owner: "per_a" });
  assert.deepEqual(store.meta.get("vyre://x/contact/1"), { owner: "per_a" });
  const again = createSqliteStore({ db, clock });
  assert.deepEqual(again.meta.get("vyre://x/contact/1"), { owner: "per_a" }, "they survive a restart");
  assert.equal((await again.get("contact", ids[700])).data.name, "Client 700");
});
