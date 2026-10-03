import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { conformance, CONTACT } from "../conformance/suite.js";
import { createSqliteStore } from "./sqlite.js";

const file = () => path.join(fs.mkdtempSync(path.join(SCRATCH, "vyre-sqlstore-")), "kernel.db");
// The same suite that defines the reference store defines this one.
conformance(async () => createSqliteStore({ db: new DatabaseSync(":memory:") }), { test, assert }, "sqlite");

test("sqlite store: everything survives a restart (types, records, versions, the bin, the change feed)", async () => {
  const f = file();
  let s = createSqliteStore({ db: new DatabaseSync(f) });
  await s.define({ add_types: [CONTACT] });
  const id = "0190c3f2-1111-4abc-8def-000000000001", id2 = "0190c3f2-1111-4abc-8def-000000000002";
  await s.create("contact", id, { name: "Jane", age: 41 });
  await s.update("contact", id, { age: 42 }, 1);
  await s.create("contact", id2, { name: "Bin" });
  await s.remove("contact", id2, 1);
  const feed = await s.changes(null, 10);
  s = createSqliteStore({ db: new DatabaseSync(f) });
  const r = await s.get("contact", id);
  assert.deepEqual([r.data.age, r.version], [42, 2]);
  assert.equal(await s.get("contact", id2), null);
  assert.equal((await s.get("contact", id2, { include_deleted: true })).version, 2);
  assert.deepEqual(await s.changes(null, 10), feed);
  assert.deepEqual((await s.types()).map(t => t.name), ["contact"]);
  await assert.rejects(() => s.update("contact", id, { age: 1 }, 1), { code: "version_conflict" });
  assert.equal((await s.update("contact", id, { age: 43 }, 2)).version, 3);
  assert.equal((await s.version()).store, "sqlite");
});
