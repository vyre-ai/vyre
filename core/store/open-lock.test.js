// @ts-check
// Two processes opening the same new database at once (vyre-core's daemon starting while the installer's
// `code` command mints a code): the second must wait for the first, not fail with "database is locked".
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { open } from "./index.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("store.open waits out another process holding the file, instead of failing with 'database is locked'", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "lk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "core.db");
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(file)});
    db.exec("PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS x (a); BEGIN EXCLUSIVE;");
    process.stdout.write("locked\\n");
    setTimeout(() => { db.exec("COMMIT"); process.exit(0); }, 1500);`], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { try { holder.kill(); } catch {} });
  await new Promise(r => holder.stdout.once("data", r));
  const t0 = Date.now();
  const db = open(file); // before the fix: throws "database is locked" at once
  assert.ok(Date.now() - t0 >= 800, "it waited for the holder");
  assert.equal(/** @type {any} */ (db.prepare("PRAGMA journal_mode").get()).journal_mode, "wal");
  db.close();
});
