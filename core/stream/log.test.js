// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { SessionLog, Logs } from "./log.js";
import { validate } from "./protocol.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";

const td = (/** @type {string} */ text, message = "m1") => ({ message, index: 0, text });

test("log: the cursor is gapless from 1 and every frame validates", () => {
  const log = new SessionLog("s1");
  assert.equal(log.head, 0);
  const fs = [log.append("status", { state: "working" }), log.append("text-delta", td("a")), log.append("text-done", { message: "m1" })];
  assert.deepEqual(fs.map(f => f.cur), [1, 2, 3]);
  assert.equal(log.head, 3);
  for (const f of fs) assert.deepEqual(validate(f), { ok: true });
  assert.throws(() => log.append("reset", { reason: "x" }), /not a logged frame kind/);
});

test("log: subscribers hear each frame synchronously and in order, unmerged", () => {
  const log = new SessionLog("s1");
  /** @type {any[]} */ const heard = [];
  const off = log.subscribe(f => heard.push(f));
  log.append("text-delta", td("a"));
  assert.equal(heard.length, 1, "heard before append returned");
  log.append("text-delta", td("b"));
  log.append("text-delta", td("c"));
  assert.deepEqual(heard.map(f => f.data.text), ["a", "b", "c"], "live fan-out is never coalesced");
  assert.ok(heard.every(f => !f.span));
  off();
  log.append("text-delta", td("d"));
  assert.equal(heard.length, 3);
});

test("log: adjacent text deltas of one block merge in the stored history only", () => {
  const log = new SessionLog("s1");
  for (const w of ["Hel", "lo ", "wor", "ld"]) log.append("text-delta", td(w));
  log.append("text-delta", td("other", "m2"));
  const all = log.read(0);
  assert.equal(all.length, 2);
  assert.equal(all[0].cur, 4);
  assert.equal(all[0].span, 4);
  assert.equal(all[0].data.text, "Hello world");
  assert.deepEqual(all[0].data.parts, [3, 3, 3, 2]);
  assert.equal(all[1].cur, 5);
  assert.equal(log.head, 5, "the cursor does not change when history merges");
});

test("log: a different message, index, turn or kind in between stops a merge", () => {
  const log = new SessionLog("s1");
  log.append("text-delta", td("a"), { turn: "1" });
  log.append("text-delta", td("b"), { turn: "2" });
  log.append("status", { state: "working" }, { turn: "2" });
  log.append("text-delta", td("c"), { turn: "2" });
  assert.equal(log.read(0).length, 4);
});

test("log: contiguous term chunks merge, a gap in offsets does not", () => {
  const log = new SessionLog("s1");
  const c = (/** @type {number} */ offset, /** @type {string} */ s) => ({ term: "t", offset, b64: Buffer.from(s).toString("base64") });
  log.append("term-chunk", c(0, "ab"));
  log.append("term-chunk", c(2, "cd"));
  log.append("term-chunk", c(10, "zz"));
  const all = log.read(0);
  assert.equal(all.length, 2);
  assert.equal(Buffer.from(all[0].data.b64, "base64").toString(), "abcd");
  assert.deepEqual(all[0].data.parts, [2, 2]);
  assert.equal(all[1].data.offset, 10);
});

test("log: since() replays after a cursor, or says reset", () => {
  const log = new SessionLog("s1", { maxFrames: 5, coalesce: false });
  for (let i = 0; i < 12; i++) log.append("status", { state: "working" });
  assert.equal(log.head, 12);
  assert.equal(log.floor, 7, "five frames held: 8..12");
  const ok = /** @type {any} */ (log.since(7));
  assert.deepEqual(ok.frames.map(/** @param {any} f */ f => f.cur), [8, 9, 10, 11, 12]);
  assert.deepEqual(/** @type {any} */ (log.since(12)).frames, []);
  assert.deepEqual(log.since(6), { reset: true, head: 12 }, "older than the log holds");
  assert.deepEqual(log.since(99), { reset: true, head: 12 }, "ahead of the log (a server that lost it)");
  assert.deepEqual(log.since(-1), { reset: true, head: 12 });
  assert.equal(/** @type {any} */ (log.since(0)).reset, true);
  assert.deepEqual(log.read(9, 2).map(f => f.cur), [10, 11]);
});

test("log: the ring is bounded by count and by bytes, and always keeps the newest frame", () => {
  const log = new SessionLog("s1", { maxFrames: 1000, maxBytes: 2000, coalesce: false });
  for (let i = 0; i < 200; i++) log.append("text-delta", td("x".repeat(100), `m${i}`));
  assert.ok(log.ring.length < 30 && log.ring.length > 5, `bytes bound held ${log.ring.length}`);
  assert.equal(log.ring[log.ring.length - 1].cur, 200);
  const tiny = new SessionLog("s2", { maxBytes: 10, coalesce: false });
  tiny.append("text-delta", td("x".repeat(500)));
  assert.equal(tiny.ring.length, 1);
});

test("log: a merged frame never grows past mergeChars", () => {
  const log = new SessionLog("s1", { mergeChars: 10 });
  for (let i = 0; i < 20; i++) log.append("text-delta", td("abcd"));
  const all = log.read(0);
  assert.ok(all.every(f => f.data.text.length <= 10));
  assert.equal(all.map(f => f.data.text).join(""), "abcd".repeat(20));
});

test("log: persistence through the store survives a restart and serves what the ring dropped", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const a = new SessionLog("s1", { db, maxFrames: 4, coalesce: false });
  for (let i = 1; i <= 10; i++) a.append("text-delta", td(`w${i}`, `m${i}`));
  a.close();
  const b = new SessionLog("s1", { db, maxFrames: 4, coalesce: false });
  assert.equal(b.head, 10, "the cursor carries on across a restart");
  assert.equal(b.ring.length, 4);
  const r = /** @type {any} */ (b.since(2));
  assert.deepEqual(r.frames.map(/** @param {any} f */ f => f.cur), [3, 4, 5, 6, 7, 8, 9, 10], "older frames come from the store");
  assert.equal(b.floor, 0);
  assert.equal(b.append("status", { state: "working" }).cur, 11);
  b.close();
});

test("log: persisted merged frames keep their span across a restart", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const a = new SessionLog("s1", { db });
  for (const w of ["a", "b", "c"]) a.append("text-delta", td(w));
  a.close();
  const rows = db.prepare("SELECT cur, first FROM stream_frames WHERE session = 's1'").all();
  assert.equal(rows.length, 1, "the merged-away rows are gone");
  assert.deepEqual({ cur: rows[0].cur, first: rows[0].first }, { cur: 3, first: 1 });
  const b = new SessionLog("s1", { db });
  assert.equal(b.read(0)[0].data.text, "abc");
  assert.equal(b.floor, 0);
  b.close();
});

test("log: maxStored prunes the store, and its floor then answers reset", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const a = new SessionLog("s1", { db, maxStored: 5, maxFrames: 3, coalesce: false });
  for (let i = 1; i <= 12; i++) a.append("status", { state: "working" });
  a.flush();
  assert.equal(a.floor, 7);
  assert.equal(/** @type {any} */ (a.since(3)).reset, true);
  assert.equal(/** @type {any} */ (a.since(7)).frames.length, 5);
  a.close();
});

test("Logs: one log per session, shared options", () => {
  const logs = new Logs({ maxFrames: 3 });
  assert.equal(logs.get("a"), logs.get("a"));
  assert.notEqual(logs.get("a"), logs.get("b"));
  logs.drop("a");
  assert.equal(logs.has("a"), false);
  logs.close();
});
