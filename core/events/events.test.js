// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { Events } from "./index.js";
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
