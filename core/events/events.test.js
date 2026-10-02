// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { Events, DRAIN_CAP } from "./index.js";
import { tempHome } from "../../test/helpers.js";

const fresh = t => new Events(open(path.join(tempHome(t), "vyre.db")));

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
