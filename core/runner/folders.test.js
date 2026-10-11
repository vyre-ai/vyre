// The folders of a computer the person approved for chats: the home hears ids and labels, never a path; a folder the sandbox must never see whole is refused; an id the computer does not hold resolves to nothing.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createFolders } from "./folders.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "fld-")));

test("a folder is approved by its real path, listed with its path to the person and by id and label only to the home, and resolved again at use", t => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), proj = path.join(home, "work", "acme"); fs.mkdirSync(proj, { recursive: true });
  const f = createFolders(path.join(dir, "state", "folders.json"), { home });
  const a = f.add(proj, "Acme site");
  assert.match(a.id, /^fld_[0-9a-f]{12}$/);
  assert.deepEqual(f.visible(), [{ id: a.id, label: "Acme site" }], "no path leaves the computer");
  assert.deepEqual(f.list(), [{ id: a.id, label: "Acme site", path: proj }]);
  assert.equal(f.add(path.join(proj, "..", "acme"), "Acme").id, a.id, "the same folder by another spelling is the same folder, and the label is renewed");
  assert.equal(f.list().length, 1);
  assert.equal(f.resolve(a.id), proj);
  assert.deepEqual(f.remove(a.id), { removed: true });
  assert.throws(() => f.resolve(a.id), (/** @type {any} */ e) => e.code === "folder_unknown");
});

test("a folder the sandbox must never see whole, a file, a relative path and a missing folder are refused in words", t => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"); fs.mkdirSync(path.join(home, "proj", ".ssh"), { recursive: true }); fs.writeFileSync(path.join(home, "file.txt"), "x");
  const f = createFolders(path.join(dir, "folders.json"), { home });
  assert.throws(() => f.add(home), (/** @type {any} */ e) => e.code === "refused" && /home folder/.test(e.message), "the home folder");
  assert.throws(() => f.add(path.join(home, "proj")), (/** @type {any} */ e) => e.code === "refused" && /\.ssh/.test(e.message), "a folder that holds a secret folder");
  assert.throws(() => f.add(path.join(home, "file.txt")), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => f.add("relative/path"), (/** @type {any} */ e) => e.code === "bad_input");
  assert.throws(() => f.add(path.join(dir, "nowhere")), (/** @type {any} */ e) => e.code === "not_found");
  assert.deepEqual(f.visible(), []);
});

test("an approved folder that was swapped for another or became unacceptable is not resolved", t => {
  const dir = tmp(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, "home"), proj = path.join(home, "p"); fs.mkdirSync(proj, { recursive: true });
  const f = createFolders(path.join(dir, "folders.json"), { home });
  const a = f.add(proj);
  fs.mkdirSync(path.join(proj, ".ssh"));
  assert.throws(() => f.resolve(a.id), (/** @type {any} */ e) => e.code === "refused", "it grew a secret folder since it was approved");
  fs.rmSync(path.join(proj, ".ssh"), { recursive: true }); fs.rmSync(proj, { recursive: true }); fs.mkdirSync(proj); fs.symlinkSync(dir, path.join(proj, "x"));
  assert.equal(f.resolve(a.id), proj, "the same real folder still resolves");
  fs.rmSync(proj, { recursive: true, force: true });
  assert.throws(() => f.resolve(a.id), (/** @type {any} */ e) => e.code === "folder_unknown");
});
