// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups } from "./group.js";
import { createFakeKernel } from "./fake-reply-port.js";

test("queued cross-person turns are restored from SQLite when the member reloads", async t => {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  const ctx = { log: () => {}, kernel: fk.kernel, call: async () => ({ data: {} }) };
  const groups = createGroups({ ctx, logs, db, standIn: true });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  fk.create("g1", ["bob", "ada"], ["kit"]);
  db.prepare(`INSERT INTO stream_groups_members (grp, who, thread, cwd, name, asker, answer, last_event, kind) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("g1", "assistant:kit", "thr_1", "/tmp", "kit", "person:bob", "a1", 0, null);
  db.prepare("INSERT OR REPLACE INTO stream_groups_queued (grp, who, queued_id, asker, answer, message, text) VALUES (?,?,?,?,?,?,?)")
    .run("g1", "assistant:kit", 42, "person:ada", "a1", "q1", "wait");
  const m = /** @type {any} */ (groups.member("g1", "assistant:kit"));
  assert.ok(m.queuedTurns && m.queuedTurns.get(42), "memberOf restores queued turns from the table");
  assert.equal(m.queuedTurns.get(42).text, "wait");
});
