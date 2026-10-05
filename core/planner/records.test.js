// @ts-check
// The planner on the Space's records: an alarm, a reminder or a note is a record the Records screens show and edit, an event is an Event
// record, a todo is a kernel task, a record someone else writes rings, a restart finds everything again, and a 0.2.x planner's own tables
// are carried into the records once.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import planner, { seams } from "./index.js";
import { migrate } from "../store/index.js";
import { Events } from "../events/index.js";
import { createKernel } from "../../kernel/index.js";
import { importLegacy } from "./legacy.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const Z = (/** @type {number[]} */ ...a) => Date.UTC(a[0], a[1] - 1, a[2], a[3] ?? 0, a[4] ?? 0);
const T0 = Z(2026, 9, 24, 5); // Thursday 10:00 in Karachi
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const NEEDS = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8")).needs;
const PERSON = { kind: "device", device_key_id: "d", person: OWNER, path: "direct" };
let homes = 0;
const until = async (/** @type {() => any} */ f, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await new Promise(r => setTimeout(r, 10)); } };

/** A planner on a fake clock over a kernel. Pass `k` to start another planner on the same Space (a restart). */
async function world(t, { k = null, start = T0, db = null, kernel = true, rows = [] } = {}) {
  const sdb = db || new DatabaseSync(":memory:");
  if (!db) sdb.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  const events = new Events(sdb);
  const kern = kernel ? k || await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4) }) : null;
  const root = `/planner-records-test-${++homes}`;
  const clock = { t: start };
  /** @type {Map<number, { at: number, fn: () => void }>} */
  const timers = new Map();
  let seq = 0;
  seams.set(root, { now: () => clock.t, setTimer: (fn, ms) => { timers.set(++seq, { at: clock.t + ms, fn }); return seq; }, clearTimer: id => timers.delete(id) });
  t.after(() => seams.delete(root));
  const fired = [], logs = [];
  events.on("planner.fired", e => fired.push({ at: clock.t, ...e.payload }));
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = {
    name: "planner", config: { role: "box", planner: { timezone: "Asia/Karachi" } }, paths: { root },
    store: { db: sdb, migrate: steps => migrate(sdb, "planner", steps) },
    ...(kern ? { kernel: kern.kernelFor({ name: "planner", needs: NEEDS }) } : {}),
    log: m => logs.push(m),
    events: { emit: (type, p, where) => events.emit("planner", type, p, where), on: (p, fn) => events.on(p, fn), latestId: () => events.latestId() },
    tool: (name, def) => tools.set(name, def),
    call: async tool => (tool === "google.accounts" ? { data: [] } : tool === "agents.list" ? { data: [{ name: "juno", kind: "assistant" }] } : { error: { code: "no_such_tool", message: "no" } }),
    remote: async () => ({ error: { code: "no_link", message: "no link" } }),
  };
  const handle = await planner.start(ctx);
  t.after(() => handle.stop());
  const owner = () => kern.chains.fromFacts(PERSON);
  const w = {
    k: kern, db: sdb, clock, timers, fired, logs, handle, events, owner,
    async call(name, input = {}, caller = "cli") {
      const def = tools.get(name);
      if (!def) return { error: { code: "no_such_tool" } };
      try { return { data: await def.run(input, { caller, kernelFacts: PERSON }) }; }
      catch (e) { const err = /** @type {any} */ (e); return { error: { code: err.code || "failed", message: err.message } }; }
    },
    async ok(name, input = {}, caller = "cli") { const r = await w.call(name, input, caller); assert.ok(!r.error, `${name}: ${JSON.stringify(r.error)}`); return r.data; },
    advance(ms) {
      const end = clock.t + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        clock.t = next[1].at;
        next[1].fn();
      }
      clock.t = end;
    },
    /** The records of a type, as the person's own query sees them. */
    async records(type) { await handle.flush(); return (await kern.gateway.records.query(owner(), type, { page: { limit: 200 } })).rows; },
    async stop() { await handle.stop(); },
  };
  return w;
}

test("records: an alarm and a note are reminder and note records, written as the tools change them", async t => {
  const w = await world(t);
  const a = await w.ok("planner.add", { kind: "alarm", title: "Northwind Bakery delivery", wall: "07:00", tags: ["bakery"] });
  const n = await w.ok("planner.add", { kind: "note", title: "juno prefers mornings", body: "- ask first", pinned: true });
  const [r] = await w.records("reminder");
  assert.equal(r.id, a.id, "the item's id is the record's");
  assert.deepEqual([r.data.kind, r.data.title, r.data.state, r.data.at, r.data.floating, r.data.wall, r.data.source], ["alarm", "Northwind Bakery delivery", "open", new Date(a.at).toISOString(), true, "07:00", "cli"]);
  assert.equal(r.data.next_fire, new Date(a.at).toISOString());
  assert.equal(r.data.tags, JSON.stringify(["bakery"]));
  const [rn] = await w.records("note");
  assert.deepEqual([rn.id, rn.data.title, rn.data.body, rn.data.pinned], [n.id, "juno prefers mornings", "- ask first", true]);
  // A change is written to the record, and a ring moves the next ring on.
  await w.ok("planner.update", { item: a.id, title: "Bakery delivery (moved)", wall: "08:00" });
  const [r2] = await w.records("reminder");
  assert.deepEqual([r2.data.title, r2.data.wall, r2.data.at], ["Bakery delivery (moved)", "08:00", new Date(Z(2026, 9, 25, 3)).toISOString()]);
  await w.ok("planner.delete", { item: n.id });
  assert.ok((await w.records("note"))[0].data.deleted_at, "a deleted item is marked, and can come back for 30 days");
  const back = await w.ok("planner.delete", { item: n.id, restore: true });
  assert.equal(back.deleted_at, null);
  assert.equal((await w.records("note"))[0].data.deleted_at, undefined);
  // The planner's own rings and settings are system records, not the person's.
  await w.ok("planner.settings", { escalate_max: 0 });
  w.advance(DAY);
  assert.equal(w.fired.length, 1);
  const rings = await w.records("planner-ring");
  assert.deepEqual([rings.length, rings[0].data.item, rings[0].data.state], [1, a.id, "ringing"]);
  assert.ok((await w.records("planner-state")).some(r => r.data.key === "settings" && JSON.parse(r.data.value).escalate_max === 0));
});

test("records: a restart finds the items, the pending ring and the answered ring again", async t => {
  const w = await world(t);
  const a = await w.ok("planner.add", { kind: "reminder", title: "Call kit", at: new Date(T0 + 2 * HOUR).toISOString() });
  const b = await w.ok("planner.add", { kind: "reminder", title: "Send the invoice", at: new Date(T0 + 5 * HOUR).toISOString() });
  await w.ok("planner.settings", { escalate_after: 7, escalate_max: 0 });
  w.advance(2 * HOUR);
  assert.deepEqual(w.fired.map(f => f.item), [a.id]);
  await w.ok("planner.done", { firing: w.fired[0].firing });
  await w.stop();
  const w2 = await world(t, { k: w.k, start: T0 + 2 * HOUR + MIN });
  assert.equal((await w2.ok("planner.get", { item: a.id })).item.state, "done");
  assert.equal((await w2.ok("planner.get", { item: a.id })).firings[0].state, "acked", "the answer is kept");
  assert.equal((await w2.ok("planner.settings", {})).escalate_after, 7, "the settings are kept");
  assert.deepEqual([...w2.timers.values()].map(x => x.at), [T0 + 5 * HOUR], "the next ring is waited for again");
  w2.advance(4 * HOUR);
  assert.deepEqual(w2.fired.map(f => f.item), [b.id]);
});

test("records: a reminder written outside the planner (the Records screens) rings, and an edit moves its ring", async t => {
  const w = await world(t);
  const at = T0 + 3 * HOUR;
  const rec = await w.k.gateway.records.create(w.owner(), "reminder", { title: "Renew the licence", kind: "reminder", state: "open", at: new Date(at).toISOString() });
  await until(() => w.timers.size > 0);
  assert.equal((await w.ok("planner.get", { item: rec.id })).item.title, "Renew the licence", "the planner sees it");
  assert.deepEqual([...w.timers.values()].map(x => x.at), [at], "it waits for its time");
  // Edited on a screen to an earlier time.
  const latest = await w.k.gateway.records.get(w.owner(), "reminder", rec.id);
  await w.k.gateway.records.update(w.owner(), "reminder", rec.id, { at: new Date(T0 + HOUR).toISOString() }, latest.version);
  await until(() => [...w.timers.values()].some(x => x.at === T0 + HOUR));
  w.advance(HOUR);
  assert.deepEqual(w.fired.map(f => [f.item, f.title]), [[rec.id, "Renew the licence"]]);
  // Written out of the planner and then deleted: it is gone from the planner's list.
  const gone = await w.k.gateway.records.create(w.owner(), "reminder", { title: "Never mind", kind: "reminder", state: "open", at: new Date(T0 + 9 * HOUR).toISOString() });
  await until(() => w.call("planner.get", { item: gone.id }).then(r => !r.error));
  await w.k.gateway.records.remove(w.owner(), "reminder", gone.id, (await w.k.gateway.records.get(w.owner(), "reminder", gone.id)).version);
  await until(() => w.call("planner.get", { item: gone.id }).then(r => r.error));
});

test("records: the planner's own event is an Event record, rings before it starts, and a delete takes the record away and back", async t => {
  const w = await world(t);
  const e = await w.ok("planner.calendar.create", { title: "Plan with kit", start: "2026-09-24T10:30", end: "2026-09-24T11:45", where: "Studio" });
  assert.equal(e.kind, "event");
  const [rec] = await w.records("event");
  assert.equal(rec.id, e.id);
  assert.deepEqual([rec.data.title, rec.data.starts_at, rec.data.ends_at, rec.data.place, rec.data.source, rec.data.time_zone],
    ["Plan with kit", "2026-09-24T05:30:00.000Z", "2026-09-24T06:45:00.000Z", "Studio", "vyre", "Asia/Karachi"]);
  w.advance(20 * MIN);
  assert.deepEqual(w.fired.map(f => [f.kind, f.at]), [["event", Z(2026, 9, 24, 5, 20)]], "event_lead (10 minutes) before the start");
  await w.ok("planner.delete", { item: e.id });
  assert.equal((await w.records("event")).length, 0, "the record is removed");
  const agenda = await w.ok("planner.agenda", { from: "2026-09-24", to: "2026-09-24" });
  assert.deepEqual(agenda.entries.map(x => x.title), []);
  await w.ok("planner.delete", { item: e.id, restore: true });
  assert.equal((await w.records("event")).length, 1, "restored");
  // An event does not repeat.
  assert.equal((await w.call("planner.add", { kind: "event", title: "x", at: T0 + HOUR, wall: "11:00", repeat: { every: "day" } })).error.code, "bad_input");
  // A restart finds the event and rings for it still.
  const w2 = await world(t, { k: w.k, start: Z(2026, 9, 24, 5, 21) });
  assert.deepEqual([...w2.timers.values()].map(x => x.at), [], "it rang already, so no second ring");
  const e2 = await w2.ok("planner.calendar.create", { title: "Later", start: "2026-09-24T14:00" });
  assert.deepEqual([...w2.timers.values()].map(x => x.at), [Z(2026, 9, 24, 8, 50)]);
  const w3 = await world(t, { k: w.k, start: Z(2026, 9, 24, 5, 22) });
  assert.deepEqual([...w3.timers.values()].map(x => x.at), [Z(2026, 9, 24, 8, 50)], "the ring of an event is worked out again at a start");
  assert.equal((await w3.ok("planner.get", { item: e2.id })).item.title, "Later");
});

test("records: a todo is a kernel task for the person, and what the Tasks screens do shows in the planner", async t => {
  const w = await world(t);
  const todo = await w.ok("planner.add", { kind: "todo", title: "Send the engagement letter", due: "2026-09-25", project: "harlow-legal", priority: 3, tags: ["intake"] }, "mcp:agent:juno");
  const tasks = await w.k.tasks.list(w.owner(), { doer: OWNER });
  assert.deepEqual(tasks.map(x => [x.id, x.title, x.due, x.state]), [[todo.id, "Send the engagement letter", "2026-09-25", "ready"]]);
  assert.equal((await w.records("reminder")).length + (await w.records("note")).length, 0, "no reminder or note record for it");
  assert.deepEqual([todo.project, todo.priority, todo.tags, todo.source, todo.added_by], ["harlow-legal", 3, ["intake"], "agent:juno", null]);
  // Done on the Tasks screen (the person starts and completes it): the planner reads the task, not a copy.
  await w.k.tasks.start(w.owner(), todo.id);
  await w.k.tasks.complete(w.owner(), todo.id, { note: "sent", sources: ["mail"] });
  assert.equal((await w.ok("planner.get", { item: todo.id })).item.state, "done");
  assert.deepEqual((await w.ok("planner.list", { kind: "todo" })).map(x => x.id), [], "done is no longer open");
  assert.deepEqual((await w.ok("planner.list", { kind: "todo", state: "done" })).map(x => x.id), [todo.id]);
  // A task someone else made (not the planner's) is not a todo here.
  await w.k.tasks.request(w.k.chains.fromFacts(PERSON), { title: "Review the Kit", doer: { kind: "person", id: OWNER, space: SPACE }, output: { kind: "note" } });
  assert.deepEqual((await w.ok("planner.list", { state: "all", kind: "todo" })).map(x => x.title), ["Send the engagement letter"]);
});

test("records: without the kernel the planner starts and says why, and the parser still answers", async t => {
  const w = await world(t, { kernel: false });
  const r = await w.call("planner.add", { kind: "alarm", wall: "07:00" });
  assert.equal(r.error.code, "unavailable");
  assert.match(r.error.message, /kernel is not on/);
  assert.equal((await w.call("planner.list", {})).error.code, "unavailable");
  const p = await w.ok("planner.parse", { text: "alarm 7am" });
  assert.equal(p.kind, "alarm");
  assert.equal(w.timers.size, 0, "nothing is scheduled");
});

test("records: a 0.2.x planner's own tables are carried into the records once, and then dropped", async t => {
  const sdb = new DatabaseSync(":memory:");
  sdb.exec("CREATE TABLE _migrations (module TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (module, version))");
  sdb.exec(`CREATE TABLE planner_items (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT, list TEXT, priority INTEGER NOT NULL DEFAULT 0, parent TEXT,
    project TEXT, thread TEXT, tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open', at INTEGER, tz TEXT, floating INTEGER NOT NULL DEFAULT 0,
    wall TEXT, date TEXT, repeat TEXT, due TEXT, duration_ms INTEGER, snooze_until INTEGER, next_fire INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, done_at INTEGER, deleted_at INTEGER,
    source TEXT, where_ TEXT, source_name TEXT, waits_on TEXT, run_count INTEGER NOT NULL DEFAULT 0, last_result TEXT, paused INTEGER NOT NULL DEFAULT 0, waits_on_fired INTEGER);
    CREATE TABLE planner_firings (id TEXT PRIMARY KEY, item TEXT NOT NULL, kind TEXT NOT NULL, due INTEGER NOT NULL, ring INTEGER NOT NULL DEFAULT 1, missed INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, fired_at INTEGER NOT NULL, next_ring INTEGER, acked_at INTEGER, action TEXT, by TEXT, until INTEGER);
    CREATE TABLE planner_calendar (id TEXT PRIMARY KEY, account TEXT NOT NULL, event_id TEXT NOT NULL, title TEXT, start INTEGER NOT NULL);
    CREATE TABLE planner_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const ins = sdb.prepare("INSERT INTO planner_items (id, kind, title, state, at, wall, floating, repeat, next_fire, created, updated, parent, priority, source, tags) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  ins.run("i_alarm1", "alarm", "Wake", "open", T0 + 3 * HOUR, "08:00", 1, JSON.stringify({ every: "day", start: "2026-09-24" }), T0 + 3 * HOUR, T0 - DAY, T0 - DAY, null, 0, "cli", "[]");
  ins.run("i_note1", "note", "juno prefers mornings", "open", null, null, 0, null, null, T0 - DAY, T0 - DAY, "i_alarm1", 0, "agent:juno", JSON.stringify(["juno"]));
  ins.run("i_todo1", "todo", "Send the letter", "open", null, null, 0, null, null, T0 - DAY, T0 - DAY, null, 2, "cli", "[]");
  ins.run("i_todo2", "todo", "Already done", "done", null, null, 0, null, null, T0 - DAY, T0 - DAY, null, 0, "cli", "[]");
  sdb.prepare("INSERT INTO planner_firings (id, item, kind, due, ring, state, fired_at, acked_at, action, by) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("f_old1", "i_alarm1", "alarm", T0 - 2 * HOUR, 1, "acked", T0 - 2 * HOUR, T0 - 2 * HOUR + MIN, "done", "cli");
  sdb.prepare("INSERT INTO planner_state (key, value) VALUES (?, ?)").run("settings", JSON.stringify({ escalate_after: 9, escalate_max: 1 }));
  const w = await world(t, { db: sdb });
  const tables = sdb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'planner_%'").all();
  assert.deepEqual(tables, [], "the planner's own tables are gone");
  const items = await w.ok("planner.list", { state: "all" });
  assert.deepEqual(items.map(x => x.title).sort(), ["Send the letter", "Wake", "juno prefers mornings"].sort(), "a done todo is not carried");
  const wake = items.find(x => x.title === "Wake");
  assert.match(wake.id, /^[0-9a-f]{8}-/, "ids are the records' now");
  assert.deepEqual([wake.at, wake.next_fire, wake.repeat.every, wake.floating], [T0 + 3 * HOUR, T0 + 3 * HOUR, "day", true]);
  const note = items.find(x => x.kind === "note");
  assert.deepEqual([note.parent, note.tags, note.source], [wake.id, ["juno"], "agent:juno"], "a link between items follows to the new ids");
  assert.deepEqual((await w.ok("planner.get", { item: wake.id })).firings.map(f => [f.state, f.action]), [["acked", "done"]]);
  assert.equal((await w.ok("planner.settings", {})).escalate_after, 9);
  assert.equal((await w.k.tasks.list(w.owner(), { doer: OWNER })).length, 1, "the open todo is a task");
  assert.deepEqual([...w.timers.values()].map(x => x.at), [T0 + 3 * HOUR], "the alarm still rings");
  // Nothing to carry the next time.
  assert.equal(await importLegacy({ db: sdb, K: /** @type {any} */ (null), log: () => {} }), null);
});
