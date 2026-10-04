// @ts-check
// C-6 (reviewer gate chat-03): assistant text deltas and shell output stay in the stream log for 24 hours, then their content is gone
// and their cursors stay. A group chat's words (authored text) are its record and stay.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { SessionLog, DEFAULTS } from "./log.js";
import { validate } from "./protocol.js";

const H = 3600_000;
const SECRET = "the build output with a key in it";

function fill(db, clock) {
  const log = new SessionLog("s1", { db, now: () => clock.t, flushMs: 0 });
  log.append("user-message", { message: "u1", text: "run it", state: "sent" });
  log.append("text-delta", { message: "m1", index: 0, text: "assistant words" });
  log.append("term-chunk", { term: "shell", offset: 0, b64: Buffer.from(SECRET).toString("base64") });
  log.append("text-delta", { message: "g1", index: 0, text: "group words" }, { author: "assistant:kit", acts_for: "person:alex", message: "g1" });
  return log;
}

test("C-6: the default is 24 hours", () => assert.equal(DEFAULTS.retainMs, 24 * H));

test("C-6: text deltas and shell output lose their content after 24 hours; user messages, authored text and cursors stay", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const clock = { t: 1_000_000 };
  const log = fill(db, clock);
  clock.t += 23 * H;
  assert.equal(log.expire(), 0, "nothing is old enough at 23 hours");
  clock.t += 2 * H;
  assert.equal(log.expire(), 2);
  const by = Object.fromEntries(log.read(0).map(f => [f.cur, f]));
  assert.deepEqual([by[2].data.text, by[2].data.expired], ["", true]);
  assert.deepEqual([by[3].data.b64, by[3].data.expired], ["", true]);
  assert.equal(by[1].data.text, "run it");
  assert.equal(by[4].data.text, "group words", "a group chat's words are its record");
  assert.deepEqual(log.read(0).map(f => f.cur), [1, 2, 3, 4], "no cursor is lost");
  for (const f of log.read(0)) assert.deepEqual(validate(f), { ok: true }, f.type);
  // the store holds none of it either, and a fresh log loaded from it agrees
  log.flush();
  const stored = JSON.stringify(db.prepare("SELECT json FROM stream_frames").all());
  assert.ok(!stored.includes("assistant words") && !stored.includes(Buffer.from(SECRET).toString("base64")));
  const again = new SessionLog("s1", { db, now: () => clock.t });
  assert.deepEqual(again.read(0).map(f => f.data.expired === true), [false, true, true, false]);
  assert.equal(again.head, 4);
});

test("C-6: a log that has sat in the store expires on load, and while appended to, at most every ten minutes", t => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  const clock = { t: 5_000_000 };
  fill(db, clock).close();
  clock.t += 30 * H;
  const log = new SessionLog("s1", { db, now: () => clock.t });
  assert.equal(log.read(0)[1].data.expired, true, "expired when it loaded");
  const l2 = new SessionLog("s2", { now: () => clock.t, flushMs: 0 });
  l2.append("text-delta", { message: "m", index: 0, text: "old" });
  clock.t += 25 * H;
  l2.append("text-delta", { message: "m", index: 1, text: "new" });
  assert.equal(l2.read(0)[0].data.expired, true, "an append past the interval expires what is old");
  assert.equal(l2.read(0)[1].data.text, "new");
});
