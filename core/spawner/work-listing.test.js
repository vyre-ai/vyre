// @ts-check
// prepareWork on a /work the spawner itself cannot list (the spawner is root with no capability, and /work is 2711: others pass through, never list). The notice's listing is Vyre's, so the start says nothing
// false about /work and the folders above it are closed all the same.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareWork } from "./project-groups.js";

const noRoot = !!process.getuid && process.getuid() === 0;   // root reads anything, so a folder it cannot list cannot be made

function work(/** @type {import("node:test").TestContext} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-work-"));
  t.after(() => { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test("a /work that cannot be listed here gets its loose files named by the lister, and is not called not set up", { skip: noRoot }, t => {
  const dir = work(t);
  fs.chmodSync(dir, 0o311);   // pass through only: readdir is EACCES for this process
  assert.throws(() => fs.readdirSync(dir), { code: "EACCES" });
  /** @type {string[]} */ const said = [], ran = [];
  const loose = prepareWork({ work: dir, shared: fs.statSync(dir).gid, asVyre: (...a) => { ran.push(a[0]); }, list: () => ["notes.txt", "projects"], log: m => said.push(m) });
  assert.deepEqual(loose, ["notes.txt"], "a folder named projects is not a loose file");
  assert.ok(said.some(m => /1 loose file\(s\).*notes\.txt/.test(m)));
  assert.ok(!said.some(m => /not set up/.test(m)), said.join("; "));
  assert.ok(ran.includes("chmod") && ran.includes("find"), "the folders were closed");
});

test("if the listing still fails, the notice is lost and the log says exactly that, never that /work is not set up", { skip: noRoot }, t => {
  const dir = work(t);
  fs.chmodSync(dir, 0o311);
  /** @type {string[]} */ const said = [];
  assert.deepEqual(prepareWork({ work: dir, shared: fs.statSync(dir).gid, asVyre: () => {}, log: m => said.push(m) }), []);
  assert.ok(said.some(m => /loose files of .* were not listed for the upgrade notice: EACCES/.test(m)), said.join("; "));
  assert.ok(!said.some(m => /not set up for project groups/.test(m)));
});
