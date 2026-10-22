// @ts-check
// The module's own table of where each version of a Kit came from: a pointer, one row per Kit and
// version, and nothing kept that is not a pointer.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, ensureTable, rememberSource, forgetVersion, forgetSource, sourcesFor, sourceKey } from "./sources.js";

/** A store with the table made, as the module makes it. */
const store = () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of MIGRATIONS) db.exec(sql);
  return { db };
};

test("the table is the module's own, named with its prefix, and keyed by the Kit and its version", () => {
  assert.match(MIGRATIONS[0], /CREATE TABLE IF NOT EXISTS flows_kit_sources/);
  assert.equal(MIGRATIONS.length, 2, "the second step is a new one: a released step never moves");
  assert.match(MIGRATIONS[1], /PRIMARY KEY \(kit_id, version\)/);
});

test("where a version of a Kit came from is kept, and the newest source of that version wins", () => {
  const s = store();
  rememberSource(s, "demo-kit", 1, "/tmp/demo-kit.json");
  assert.deepEqual(sourcesFor(s).get(sourceKey("demo-kit", 1)), { source: "/tmp/demo-kit.json", version: 1 });
  // another version of the same Kit is another row: it says nothing about the version on the Space
  rememberSource(s, "demo-kit", 2, "https://example.com/kit.json");
  assert.equal(sourcesFor(s).size, 2);
  assert.equal(sourcesFor(s).get(sourceKey("demo-kit", 1)).source, "/tmp/demo-kit.json", "the installed version keeps its own source");
  assert.equal(sourcesFor(s).get(sourceKey("demo-kit", 2)).source, "https://example.com/kit.json");
  // the same version from another place: the newest source of that version wins
  rememberSource(s, "demo-kit", 1, "/tmp/other-kit.json");
  assert.equal(sourcesFor(s).get(sourceKey("demo-kit", 1)).source, "/tmp/other-kit.json");
  assert.equal(sourcesFor(s).size, 2);
});

test("a version that came from nowhere forgets its source, and a Kit that is gone forgets every version", () => {
  const s = store();
  rememberSource(s, "demo-kit", 1, "/tmp/demo-kit.json");
  rememberSource(s, "demo-kit", 2, "/tmp/demo-kit.json");
  forgetVersion(s, "demo-kit", 2);
  assert.equal(sourcesFor(s).size, 1);
  assert.equal(sourcesFor(s).get(sourceKey("demo-kit", 1)).source, "/tmp/demo-kit.json");
  forgetSource(s, "demo-kit");
  assert.equal(sourcesFor(s).size, 0);
});

test("a store with no table yet has no sources, and a write that fails does not throw", () => {
  const empty = { db: { prepare: () => { throw new Error("no table yet"); } } };
  assert.equal(sourcesFor(empty).size, 0);
  rememberSource(empty, "demo-kit", 1, "/tmp/demo-kit.json");
});

test("the table is made when it is needed, and the numbered step makes the same table", () => {
  const said = /** @type {string[]} */ ([]);
  const s = { db: { exec: (/** @type {string} */ sql) => { said.push(sql); }, prepare: () => ({ all: () => [] }) } };
  assert.equal(ensureTable(s), true);
  assert.match(said[0], /CREATE TABLE IF NOT EXISTS flows_kit_sources/);
  assert.match(said[0], /PRIMARY KEY \(kit_id, version\)/);
  assert.ok(MIGRATIONS[1].endsWith(said[0]), "the numbered step makes the same table");
});
