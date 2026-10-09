// @ts-check
// recall.marks (R031-00u): a moment in a thread's windows maps to the pointer of the latest turn at or before it, by index reads alone.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { marksOf } from "./turns.js";
import { tempHome } from "../../test/helpers.js";

test("marksOf finds the latest turn at or before each moment, across windows", (t) => {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const add = db.prepare("INSERT INTO recall_turns (session, seq, role, ts, text, provider, model) VALUES (?,?,?,?,?,?,?)");
  for (const [s, q, ts] of [["aaaaaaaa-1", 0, 1000], ["aaaaaaaa-1", 1, 2000], ["bbbbbbbb-2", 0, 3000]]) add.run(s, q, "user", ts, "x", "claude", null);
  const m = marksOf(db, ["aaaaaaaa-1", "bbbbbbbb-2"], [500, 1000, 2500, 9000]);
  assert.equal(m.length, 4);
  assert.match(m[1], /:0$/); assert.match(m[2], /:1$/); assert.match(m[3], /:0$/);
  assert.notEqual(m[2], m[3]);
  assert.equal(marksOf(db, [], [1])[0], null);
});
