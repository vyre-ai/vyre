// @ts-check
// The module's own table of where each Kit came from: a pointer, one row per Kit, and nothing kept
// that is not a pointer.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, rememberSource, forgetSource, sourcesFor } from "./sources.js";

/** A store with the table made, as the module makes it. */
const store = () => {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATIONS[0]);
  return { db };
};

test("the table is the module's own, named with its prefix", () => {
  assert.match(MIGRATIONS[0], /CREATE TABLE flows_kit_sources/);
  assert.equal(MIGRATIONS.length, 1);
});

test("where a Kit came from is kept, one row per Kit, and the newest source wins", () => {
  const s = store();
  rememberSource(s, "demo-kit", 1, "/tmp/demo-kit.json");
  assert.deepEqual(sourcesFor(s).get("demo-kit"), { source: "/tmp/demo-kit.json", version: 1 });
  rememberSource(s, "demo-kit", 2, "https://example.com/kit.json");
  assert.deepEqual(sourcesFor(s).get("demo-kit"), { source: "https://example.com/kit.json", version: 2 });
  assert.equal(sourcesFor(s).size, 1);
});

test("a Kit that is gone takes its source with it", () => {
  const s = store();
  rememberSource(s, "demo-kit", 1, "/tmp/demo-kit.json");
  forgetSource(s, "demo-kit");
  assert.equal(sourcesFor(s).size, 0);
});

test("a store with no table yet has no sources, and a write that fails does not throw", () => {
  const empty = { db: { prepare: () => { throw new Error("no table yet"); } } };
  assert.equal(sourcesFor(empty).size, 0);
  rememberSource(empty, "demo-kit", 1, "/tmp/demo-kit.json");
});
