// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Events, DRAIN_CAP } from "./bus.js";

const fresh = _t => new Events();

test("events: emitted events are stored and read back in order", t => {
  const ev = fresh(t);
  ev.emit("watchers", "watcher.fired", { n: 1 }, { project: "harlow" });
  ev.emit("watchers", "watcher.fired", { n: 2 });
  const all = ev.since(0);
  assert.deepEqual(all.map(e => e.payload.n), [1, 2]);
  assert.equal(all[0].project, "harlow");
  assert.equal(ev.since(all[0].id).length, 1);
});

test("events: names must read as noun.past-verb", t => {
  const ev = fresh(t);
  assert.throws(() => ev.emit("x", "FireWatcher", {}), /noun.past-verb/);
});

test("events: a random id is not a secret (FL-1), a real token after a space or an equals sign still is", t => {
  const ev = fresh(t);
  // Each of these used to match: a token prefix inside a longer word or a base64url id. Built at runtime so no literal looks like a secret.
  const ids = ["task" + "-abcdefghijklmnopqrstuvwx", "n8" + "-sk" + "-AbCdEfGhIjKlMnOpQrSt", "x" + "AKIA" + "1234567890ABCDEF", "Q2" + "_ghp" + "_" + "a".repeat(24), "desk" + "-" + "b".repeat(20)];
  for (const id of ids) assert.doesNotThrow(() => ev.emit("wink", "wink.adopted", { id, device: id }), id);
  for (const text of ["Bearer sk" + "-" + "a".repeat(24), "token=ghp" + "_" + "a".repeat(24), "key AKIA" + "1234567890ABCDEF"]) assert.throws(() => ev.emit("x", "thing.happened", { text }), /looks like a secret/, text);
});

test("events: a payload that looks like a secret is refused", t => {
  const ev = fresh(t);
  assert.throws(() => ev.emit("x", "thing.happened", { key: "sk" + "-" + "a".repeat(24) }), /looks like a secret/);
  assert.throws(() => ev.emit("x", "thing.happened", { password: "hunter2hunter2" }), /looks like a secret/);
});

test("events: listeners hear exact, family and all patterns; one bad listener stops nobody", t => {
  const ev = fresh(t);
  const heard = [];
  ev.on("watcher.fired", () => heard.push("exact"));
  ev.on("watcher.*", () => { throw new Error("broken listener"); });
  ev.on("*", () => heard.push("all"));
  ev.emit("w", "watcher.fired", {});
  assert.deepEqual(heard, ["exact", "all"]);
});

test("events: prune deletes only the matching rows", t => {
  const ev = fresh(t);
  const at = (type, payload, thread, source = "threads") => ev.emit(source, type, payload, { thread }).id;
  const d1 = at("thread.text", { delta: "he" }, "a");
  const whole = at("thread.text", { text: "hello", done: true }, "a");
  const other = at("thread.text", { delta: "yo" }, "b");
  const tool = at("thread.tool", { delta: "not text" }, "a");
  const foreign = at("thread.text", { delta: "x" }, "a", "someone");
  const fin = at("thread.finished", { ok: true }, "a");
  const later = at("thread.text", { delta: "next turn" }, "a");
  assert.equal(ev.prune({ type: "thread.text", before: fin, source: "threads", thread: "a", has: "delta" }), 1);
  const left = ev.since(0, { limit: 100 }).map(e => e.id);
  assert.deepEqual(left, [whole, other, tool, foreign, fin, later], "other threads, types, sources and later rows stay");
  assert.ok(!left.includes(d1));
  assert.throws(() => ev.prune({ type: "thread.text", before: fin, has: "a'); DROP TABLE events; --" }), /not a payload key/);
  assert.throws(() => ev.prune({ type: "thread.text" }), /event id/);
});

test("events: ids never go back, even after the newest rows are pruned (ADR 0029, R1)", t => {
  const ev = fresh(t);
  ev.emit("x", "thread.text", { delta: "a" });
  const b = ev.emit("x", "thread.text", { delta: "b" });
  ev.prune({ type: "thread.text", before: b.id });
  assert.equal(ev.latestId(), b.id, "the cursor a surface holds must still be the newest");
  assert.ok(ev.emit("x", "thread.text", {}).id > b.id);
});

test("events: a cursor past the newest id is not resumable, and says where to follow from", t => {
  const ev = fresh(t);
  const e = ev.emit("x", "thing.happened", {});
  assert.deepEqual(ev.resumable(e.id), { ok: true });
  assert.deepEqual(ev.resumable(e.id + 10), { ok: false, from: e.id });
});

test("events: an event emitted by a listener is heard after the one being delivered, so every listener hears ids in order (#41)", t => {
  const ev = fresh(t);
  const early = [], late = [];
  ev.on("model.switched", () => { early.push("model.switched"); ev.emit("x", "settings.changed", {}); });
  ev.on("*", e => early.push(e.id));
  ev.on("*", e => late.push(e.id));
  const first = ev.emit("x", "model.switched", { model: "haiku" });
  assert.deepEqual(late, [first.id, first.id + 1], "a later listener hears the outer event first");
  assert.deepEqual(early.filter(x => typeof x === "number"), [first.id, first.id + 1]);
});

test("events: listeners that emit each other stop at the drain cap, say which types, and leave the daemon running (#41 review)", t => {
  const ev = fresh(t);
  const said = [];
  ev.log = m => said.push(m);
  let heard = 0;
  ev.on("ping.sent", () => { heard++; ev.emit("x", "pong.sent", {}); });
  ev.on("pong.sent", () => { heard++; ev.emit("x", "ping.sent", {}); });
  ev.emit("x", "ping.sent", {});
  assert.ok(heard <= DRAIN_CAP, "one drain delivers at most the cap");
  assert.equal(said.length, 1);
  assert.match(said[0], /ping\.sent|pong\.sent/);
  assert.ok(ev.latestId() > 0);
  // The bus works again afterwards.
  const got = [];
  ev.on("later.said", e => got.push(e.id));
  ev.emit("x", "later.said", {});
  assert.equal(got.length, 1);
});

test("events: a home from before the bus moved into the kernel log keeps its thread history and activity: the old table is copied in once, in order, and not again", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, project TEXT, thread TEXT, payload TEXT NOT NULL)");
  const put = db.prepare("INSERT INTO events (at, type, source, project, thread, payload) VALUES (?,?,?,?,?,?)");
  put.run(1000, "thread.started", "threads", "harlow", "t1", JSON.stringify({ cwd: "/w" }));
  put.run(2000, "thread.text", "threads", "harlow", "t1", JSON.stringify({ text: "hello", done: true }));
  put.run(3000, "watcher.fired", "watchers", null, null, JSON.stringify({ n: 1 }));
  put.run(4000, "thread.text", "threads", null, "t2", "not json");
  const ev = new Events();
  assert.equal(ev.importLegacy(db), 3, "the row that is not JSON is skipped, the rest are carried");
  assert.deepEqual(ev.since(0).map(e => e.type), ["thread.started", "thread.text", "watcher.fired"]);
  assert.deepEqual(ev.since(0).map(e => e.at), [1000, 2000, 3000], "their own times");
  assert.deepEqual(ev.ofThread("t1").map(e => e.payload), [{ cwd: "/w" }, { text: "hello", done: true }], "the thread's history is there");
  assert.equal(ev.since(0, { project: "harlow" }).length, 2);
  assert.equal(ev.importLegacy(db), 0, "once");
  assert.equal(ev.since(0).length, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 4, "the old table is left as it was");
  assert.equal(new Events().importLegacy(new DatabaseSync(":memory:")), 0, "a home with no old table copies nothing");
});

test("events: eraseThread removes every event of a deleted thread, from every read, and leaves the others", () => {
  const ev = new Events();
  ev.emit("threads", "thread.started", {}, { thread: "t1" });
  ev.emit("memory", "memory.noted", { n: 1 }, { thread: "t1" });
  ev.emit("threads", "thread.started", {}, { thread: "t2" });
  assert.equal(ev.eraseThread("t1"), 2);
  assert.deepEqual(ev.ofThread("t1"), []);
  assert.deepEqual(ev.since(0).map(e => e.thread), ["t2"]);
  assert.equal(ev.eraseThread("t1"), 0);
});
