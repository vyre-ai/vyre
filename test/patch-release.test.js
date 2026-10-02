// @ts-check
// scripts/patch-release.mjs: a fix commit becomes a hotfix branch off the last stable tag, version bumped, notes written (the patch fast lane).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "./scratch.mjs";
import { newestStable, nextPatch, notesFrom, patchRelease } from "../scripts/patch-release.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = (/** @type {string} */ cwd, /** @type {string[]} */ ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd, encoding: "utf8" }).trim();

test("patch-release: the newest stable tag, and the next patch", () => {
  assert.equal(newestStable(["v0.2.0", "v0.2.1", "v0.10.0", "v0.2.2-rc.1", "x"]), "v0.10.0");
  assert.equal(newestStable(["v0.2.2-rc.1"]), null);
  assert.equal(nextPatch("v0.2.9"), "0.2.10");
  assert.throws(() => nextPatch("v0.2.1-rc.1"));
});

test("patch-release: notes take the commit subjects, plain, with the issue number", () => {
  const n = notesFrom(["fix(sessions): Claude's sign-in takes the code#state paste, fixes #10", "feat(app): the hosted app ships a manifest"], "0.2.2");
  assert.match(n, /^Vyre 0\.2\.2 is a patch release/);
  assert.match(n, /- Claude's sign-in takes the code#state paste\. \(#10\)/);
  assert.match(n, /- The hosted app ships a manifest\./);
});

/** A small repo with the real bump script, one release tag and a later fix. */
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-patch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (/** @type {string} */ f, /** @type {string} */ text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
  put("scripts/bump-version.mjs", fs.readFileSync(path.join(REPO, "scripts/bump-version.mjs"), "utf8"));
  put("package.json", JSON.stringify({ name: "x", version: "0.2.1" }, null, 2) + "\n");
  put("package-lock.json", JSON.stringify({ name: "x", version: "0.2.1", lockfileVersion: 3, packages: { "": { name: "x", version: "0.2.1" } } }, null, 2) + "\n");
  put("harness/.claude-plugin/plugin.json", JSON.stringify({ name: "x", version: "0.2.1" }, null, 2) + "\n");
  put("a.txt", "one\n");
  g(dir, "init", "-q", "-b", "main"); g(dir, "config", "user.name", "t"); g(dir, "config", "user.email", "t@example.com"); g(dir, "add", "-A"); g(dir, "commit", "-qm", "base"); g(dir, "tag", "v0.2.1");
  put("a.txt", "one\ntwo\n"); g(dir, "commit", "-qam", "unrelated work that is not a fix");
  put("b.txt", "fixed\n"); g(dir, "add", "-A"); g(dir, "commit", "-qm", "fix(box): the thing works, fixes #7");
  return { dir, fix: g(dir, "rev-parse", "HEAD") };
}

test("patch-release: a fix becomes hotfix/v0.2.2 off v0.2.1, without the unrelated commit, with every version place moved and the notes written", t => {
  const { dir, fix } = fixture(t);
  const r = patchRelease({ repo: dir, commits: [fix] });
  assert.equal(r.branch, "hotfix/v0.2.2");
  assert.equal(r.version, "0.2.2");
  assert.equal(fs.existsSync(path.join(r.dir, "b.txt")), true, "the fix is in");
  assert.equal(fs.readFileSync(path.join(r.dir, "a.txt"), "utf8"), "one\n", "the unrelated commit is not");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, "package.json"), "utf8")).version, "0.2.2");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.dir, "harness/.claude-plugin/plugin.json"), "utf8")).version, "0.2.2");
  assert.match(fs.readFileSync(path.join(r.dir, "release/notes/0.2.2.md"), "utf8"), /The box thing works|The thing works/);
  assert.equal(g(r.dir, "log", "-1", "--format=%s"), "release: 0.2.2 (version and notes)");
  assert.equal(g(r.dir, "log", "-1", "--format=%B").includes("Co-Authored"), false, "no trailers");
  assert.throws(() => patchRelease({ repo: dir, commits: [fix] }), /already exists/);
  g(dir, "worktree", "remove", "--force", r.dir);
});

test("patch-release: a fix that does not apply stops with the worktree left to fix, and nothing is pushed", t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, "a.txt"), "three\n"); g(dir, "commit", "-qam", "conflicting edit");
  g(dir, "checkout", "-q", "-b", "other", "v0.2.1"); fs.writeFileSync(path.join(dir, "a.txt"), "four\n"); g(dir, "commit", "-qam", "other edit"); const other = g(dir, "rev-parse", "HEAD");
  g(dir, "checkout", "-q", "main");
  assert.throws(() => patchRelease({ repo: dir, commits: [g(dir, "rev-parse", "main"), other] }), /does not apply on v0\.2\.1/);
});
