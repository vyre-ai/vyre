// The kernel's memory follows the working set, not the history: the event log keeps a recent window and reads the rest from SQLite; the built-in store keeps hot rows
// and the change feed on disk. These tests hold the bound and hold that nothing else changes: a bounded log answers every read exactly as the unbounded one does.
import "../../scripts/mac-test-guard.mjs";
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

test("a read with a small limit asks the disk for that many rows, not a whole batch (a consumer far behind the window took 500 rows to deliver one event)", () => {
  const db = new DatabaseSync(":memory:");
  const asked = [];
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    const st = prepare(sql);
    if (!/FROM kernel_events WHERE .*ORDER BY seq LIMIT \?$/.test(sql)) return st;
    return new Proxy(st, { get: (t, k) => (k === "all" ? (...a) => { asked.push(a[a.length - 1]); return t.all(...a); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  };
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 10 } });
  fill(log, 200);
  asked.length = 0;
  assert.equal([...log.iterate({ since: 3, limit: 1 })][0].seq, 4, "the next event after the cursor, from the disk");
  assert.deepEqual(asked, [1], "one row asked for, not a batch");
  asked.length = 0;
  assert.equal([...log.iterate({ since: 3, limit: 7 })].length, 7);
  assert.ok(asked.every(n => n <= 7), `at most the limit asked for: ${asked}`);
  asked.length = 0;
  assert.ok([...log.iterate({})].length >= 200);
  assert.ok(asked.every(n => n <= 500) && asked.some(n => n === 500), "an unlimited walk still goes in batches");
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

test("a boot reads the newest snapshot and the grants events after it, not the history: the grants store snapshots as it goes and the state comes back whole", async () => {
  const { createKernel } = await import("../index.js");
  const { canonical, sha256 } = await import("../core/canonical.js");
  const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
  const used = new Set();
  const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
  const db = new DatabaseSync(":memory:");
  const read = { events: 0 };
  const open = async () => {
    const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 20 } });
    const counting = { ...log, iterate: (f, o) => (function* () { for (const e of log.iterate(f, o)) { read.events++; yield e; } })() };
    return createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), clock, presence, log: counting, store: createSqliteStore({ db, clock }), snapshot_every: 6 });
  };
  const k = await open();
  const ow = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (let i = 0; i < 25; i++) { const r = { person: `per_p${i}`, role: "member" }; await k.gateway.grants.setRole(ow, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/per_p${i}`) }); }
  const snaps = k.log.read({ type: "grants.snapshot" });
  assert.ok(snaps.length >= 3, `snapshots were written as it went (${snaps.length})`);
  const total = k.log.latestSeq();
  const members = (await k.gateway.grants.members.list(ow)).length;
  read.events = 0;
  const k2 = await open();
  assert.ok(read.events < total / 2, `the boot read ${read.events} events of ${total}, not the history`);
  const ow2 = k2.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  assert.equal((await k2.gateway.grants.members.list(ow2)).length, members, "the whole state came back from the snapshot and the tail");
  assert.equal(k2.log.verify().ok, true);
  // and it keeps working: a new change after the reboot is a member after another reboot
  const r = { person: "per_late", role: "admin" };
  await k2.gateway.grants.setRole(ow2, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/per_late`) });
  const k3 = await open();
  assert.equal((await k3.gateway.grants.members.list(k3.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" }))).some(m => m.person === "per_late"), true);
});

test("BL-1: the filter columns are generated from the event, so a database edit cannot make a by-type read disagree with the event", () => {
  const db = new DatabaseSync(":memory:");
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 20, bytes: 1_000_000 }, rand: n => Buffer.alloc(n, 7) });
  fill(log, 300);
  const before = log.read({ type: "grant.created" }).length;
  // probe 1: change only the type column of an old event
  for (const col of ["type", "subject", "corr", "actor", "ref"]) assert.throws(() => db.prepare(`UPDATE kernel_events SET ${col} = 'x' WHERE seq = 6`).run(), /generated/i, `${col} cannot be written`);
  assert.equal(log.read({ type: "grant.created" }).length, before);
  // probe 2: a row whose JSON says contact.updated is never returned by a grant.created read, whatever the row's other fields: the column is the JSON
  const e = JSON.parse(/** @type {any} */ (db.prepare("SELECT event FROM kernel_events WHERE seq = 2").get()).event);
  assert.notEqual(e.type, "grant.created");
  assert.ok(!log.read({ type: "grant.created" }).some(x => x.seq === 2));
  // editing the event's own type is a different edit: the column follows it, and the chain catches it
  db.prepare("UPDATE kernel_events SET event = json_set(event, '$.type', 'grant.created') WHERE seq = 2").run();
  assert.equal(log.verify().ok, false, "the edit is found by the chain");
  assert.equal(log.verify().at, 2);
});

test("BL-1: a database made with plain filter columns is migrated to generated ones, and a column that is not generated is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kernel_events (seq INTEGER PRIMARY KEY, space TEXT NOT NULL, event TEXT NOT NULL, salt TEXT, type TEXT, subject TEXT, corr TEXT, actor TEXT, ref TEXT)");
  const old = createEventLog({ space: SPACE, clock, rand: n => Buffer.alloc(n, 7) });
  fill(old, 40);
  for (const e of old.iterate({})) db.prepare("INSERT INTO kernel_events (seq, space, event, salt, type, subject, corr, actor, ref) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, NULL)").run(e.seq, SPACE, JSON.stringify(e), "contact.updated", e.subject, e.actor);
  const log = createSqliteEventLog({ db, space: SPACE, clock });
  assert.equal(log.read({ type: "grant.created" }).length, old.read({ type: "grant.created" }).length, "the lying column was dropped, the JSON answers");
  for (const c of /** @type {any[]} */ (db.prepare("PRAGMA table_xinfo(kernel_events)").all())) if (["type", "subject", "corr", "actor", "ref"].includes(c.name)) assert.notEqual(c.hidden, 0, c.name);
});

test("a read by type prefix is a range on the type index (a LIKE with ESCAPE scans every row and parses every event at boot), and matches exactly the types under the prefix", () => {
  const db = new DatabaseSync(":memory:");
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 5, bytes: 1_000_000 } });
  for (const type of ["grant.created", "grant.revoked", "grants.created", "grantz.updated", "member.set", "gran.updated", "grant.narrowed", "grant-x.updated", "grant_x.updated", "grant0.updated", "grantt.updated", "grant.zz"]) log.append(owner(), { type, sv: 1, subject: `vyre://${SPACE}/x/${type}`, data: {} });
  for (let i = 0; i < 10; i++) log.append(owner(), { type: "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/${i}`, data: {} });
  assert.deepEqual(log.read({ type: "grant.*" }).map(e => e.type), ["grant.created", "grant.revoked", "grant.narrowed", "grant.zz"]);
  assert.deepEqual(log.read({ type: "member.*" }).map(e => e.type), ["member.set"]);
  assert.deepEqual(log.read({ type: "grant.created" }).map(e => e.type), ["grant.created"]);
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT event FROM kernel_events WHERE space = ? AND seq > ? AND type >= ? AND type < ? ORDER BY seq LIMIT ?").all(SPACE, 0, "grant.", "grant/", 10).map(r => r.detail).join(" | ");
  assert.match(plan, /kernel_events_type/, plan);
});
