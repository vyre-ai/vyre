// @ts-check
// The files module's migrations: mentions and shared links both migrate under the module name "files", and the store numbers a module's steps by position, so two separate lists collided
// (mentions ran as version 1 and shared links' own version 1 was then skipped: the files_links table never existed). One ordered list fixes it, and a box that already ran mentions
// as version 1 gets the shared-links table as the next step.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, open } from "../store/index.js";
import { MIGRATIONS as MENTION_MIGRATIONS } from "./mentions.js";
import { LINK_MIGRATIONS } from "./space-links.js";
import { filesMigrations } from "./migrations.js";

const fresh = () => open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fmig-")), "vyre.db"));
const tables = (/** @type {any} */ db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'files_%'").all().map((/** @type {any} */ r) => r.name);

test("the problem: two lists under one module name leave the shared-links table uncreated", () => {
  const db = fresh();
  migrate(db, "files", MENTION_MIGRATIONS);
  migrate(db, "files", LINK_MIGRATIONS);
  assert.ok(!tables(db).includes("files_links"), "this is the bug the single list removes");
});

test("one ordered list: mentions first, shared links next, and both tables exist on a fresh box", () => {
  const all = filesMigrations();
  assert.equal(all[0], MENTION_MIGRATIONS[0]);
  assert.equal(all[MENTION_MIGRATIONS.length], LINK_MIGRATIONS[0]);
  const db = fresh();
  migrate(db, "files", all);
  for (const t of ["files_links", "files_mention_grants", "files_linked", "files_linked_index", "files_linked_sync"]) assert.ok(tables(db).includes(t), t);
});

test("a box that already ran mentions as version 1 keeps it and gets shared links as the next step", () => {
  const db = fresh();
  migrate(db, "files", MENTION_MIGRATIONS);
  db.prepare("INSERT INTO files_mention_grants (thread, share, path, real, said, at) VALUES ('t', 's', 'p', 'r', NULL, 1)").run();
  migrate(db, "files", filesMigrations());
  assert.ok(tables(db).includes("files_links"));
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM files_mention_grants").get().n), 1, "the grants it had are untouched");
  assert.deepEqual(db.prepare("SELECT version FROM _migrations WHERE module = 'files' ORDER BY version").all().map((/** @type {any} */ r) => Number(r.version)).slice(0, 2), [1, 2], "mentions stays version 1 and shared links is version 2; later parts come after");
});

test("running the list twice changes nothing", () => {
  const db = fresh();
  migrate(db, "files", filesMigrations());
  migrate(db, "files", filesMigrations());
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM _migrations WHERE module = 'files'").get().n), filesMigrations().length);
});

test("both parts of the module migrate that list and no list of their own", () => {
  for (const f of ["drive.js", "space-links.js"]) {
    const src = fs.readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
    assert.match(src, /ctx\.store\.migrate\(filesMigrations\(\)\)/, f);
    assert.doesNotMatch(src, /ctx\.store\.migrate\((?!filesMigrations)/, f);
  }
});
