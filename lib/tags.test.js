import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as tags from "./tags.js";

test("a tag has one spelling; the stored text is a JSON list; changes add and remove without duplicates", () => {
  assert.equal(tags.normalize("  #Client Work "), "client-work");
  assert.equal(tags.normalize("a/b"), null);
  assert.deepEqual(tags.parse('["a","b","a"]'), ["a", "b"]);
  assert.deepEqual(tags.parse("not json"), []);
  assert.equal(tags.change("", { add: ["Estate", "estate", "urgent"] }), '["estate","urgent"]');
  assert.equal(tags.change('["estate","urgent"]', { remove: ["Urgent"] }), '["estate"]');
  assert.equal(tags.change('["x"]', { remove: ["x"] }), "");
  assert.throws(() => tags.change("", { add: ["no way!"] }), /lower-case letters/);
  assert.throws(() => tags.change("", { add: Array.from({ length: 21 }, (_, i) => `t${i}`) }), /at most 20/);
});

test("the filter finds a whole tag, not a part of one, on the in-memory and the SQLite store", async () => {
  const { createMemoryStore } = await import("../kernel/store/memory.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { createSqliteStore } = await import("../kernel/store/sqlite.js");
  const { mintUuid } = await import("../kernel/core/ids.js");
  const type = { name: "thing", label: "Thing", fields: [{ name: "name", kind: "text", label: "Name" }, { name: "tags", kind: "text", label: "Tags" }] };
  let t = 1_800_000_000_000; const clock = () => ++t;
  for (const mk of [() => createMemoryStore({ clock }), () => createSqliteStore({ db: new DatabaseSync(":memory:"), clock })]) {
    const s = /** @type {any} */ (mk());
    await s.define({ add_types: [type] });
    await s.create("thing", mintUuid(), { name: "one", tags: tags.write(["tax", "client"]) });
    await s.create("thing", mintUuid(), { name: "two", tags: tags.write(["taxes"]) });
    const got = await s.query("thing", { filter: tags.filter("tax"), page: { limit: 10 } });
    assert.deepEqual(got.rows.map((/** @type {any} */ r) => r.data.name), ["one"]);
  }
});
