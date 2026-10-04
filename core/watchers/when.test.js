import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { parseWhen } from "./when.js";

test("when: schedules, events, pushes and cron read into the runtime's shape", () => {
  assert.deepEqual(parseWhen("daily 07:00"), { schedule: "0 7 * * *", on: null, where: null });
  assert.deepEqual(parseWhen("weekdays 9:30"), { schedule: "30 9 * * 1-5", on: null, where: null });
  assert.equal(parseWhen("hourly").schedule, "0 * * * *");
  assert.equal(parseWhen("every 30 minutes").schedule, "*/30 * * * *");
  assert.equal(parseWhen("every 2 hours").schedule, "0 */2 * * *");
  assert.equal(parseWhen("15 7 * * 1-5").schedule, "15 7 * * 1-5");
  assert.deepEqual(parseWhen("thread.finished"), { schedule: "event", on: "thread.finished", where: null });
  assert.deepEqual(parseWhen("memory.decided where project=harlow-legal n=3 ok=true"), { schedule: "event", on: "memory.decided", where: { project: "harlow-legal", n: 3, ok: true } });
  assert.deepEqual(parseWhen("push Gmail"), { schedule: "event", on: "vault.push", where: { connection: "gmail" } });
});

test("when: what cannot be read says how to write it, and nothing polls faster than five minutes", () => {
  for (const bad of ["", "whenever", "daily 25:00", "daily 7", "every 1 minutes", "every 90 minutes", "thread.finished where x", "push", "a.b where a=1 where b=2"]) {
    assert.throws(() => parseWhen(bad), /trigger|time of day|every N|field=value|where|connection/i, bad);
  }
});
