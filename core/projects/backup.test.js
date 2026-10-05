// @ts-check
// The Basic backup's list of a computer's projects: files with the ignore rules applied, a notice for a file over the cap, and the project rows as one row file.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { backupSources } from "./backup.js";

test("backupSources lists a project's files, skips dependency and build folders and caches, notes a big file, never follows a symlink", t => {
  const root = fs.realpathSync(tempHome(t));
  const home = path.join(root, "northwind"), other = path.join(root, "secret");
  for (const d of ["src", "node_modules/x", ".git/objects", "dist"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "private.txt"), "not this project's");
  fs.writeFileSync(path.join(home, "src/app.js"), "x");
  fs.writeFileSync(path.join(home, "notes.md"), "hello");
  fs.writeFileSync(path.join(home, "node_modules/x/i.js"), "no");
  fs.writeFileSync(path.join(home, ".git/objects/o"), "no");
  fs.writeFileSync(path.join(home, "dist/out.js"), "no");
  fs.writeFileSync(path.join(home, "run.log"), "no");
  fs.writeFileSync(path.join(home, ".DS_Store"), "no");
  fs.writeFileSync(path.join(home, "big.bin"), Buffer.alloc(20));
  fs.symlinkSync(other, path.join(home, "link"));
  const { items, notices } = backupSources([{ slug: "northwind", name: "Northwind", workspaces: [home], home, archived_at: null, org: null }], { maxFile: 10 });
  const names = items.filter(i => i.kind === "file").map(i => i.name).sort();
  assert.deepEqual(names, ["northwind/northwind/notes.md", "northwind/northwind/src/app.js"]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /big\.bin/);
  const rows = items.find(i => i.name === "rows/projects.jsonl");
  assert.equal(rows.kind, "rows");
  assert.equal(JSON.parse(rows.text.trim()).slug, "northwind");
  assert.ok(items.every(i => i.kind === "rows" || (typeof i.size === "number" && typeof i.mtime === "number" && path.isAbsolute(i.path))));
});
