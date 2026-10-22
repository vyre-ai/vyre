// @ts-check
// What a first push to a new repo may send: the folder's tree and, when it already has commits, every line any commit ever added; and when git cannot answer, the answer is "could not check", never "clean".
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localInit, prepareFirstPush, scanWholeBranch } from "./git.js";

const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-scan-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

test("a clean folder passes; a secret in the tree is found with its file and line", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "index.html"), "<p>hi</p>\n");
  const i = await localInit(d);
  assert.equal(await scanWholeBranch({ repoDir: d, branch: i.branch }), null);
  fs.writeFileSync(path.join(d, "config.js"), `// c\nconst t = "${TOKEN}";\n`);
  git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", "add"]);
  assert.deepEqual(await scanWholeBranch({ repoDir: d, branch: i.branch }), { pattern: "GitHub token", file: "config.js", line: 2 });
});

test("a secret committed once and deleted later is still found, because the push sends the history", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "index.html"), "<p>hi</p>\n");
  const i = await localInit(d);
  fs.writeFileSync(path.join(d, "old.env.js"), `const t = "${TOKEN}";\n`);
  git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", "oops"]);
  git(d, ["rm", "-q", "old.env.js"]); git(d, ["commit", "-q", "-m", "removed it"]);
  assert.equal(fs.existsSync(path.join(d, "old.env.js")), false);
  const hit = /** @type {any} */ (await scanWholeBranch({ repoDir: d, branch: i.branch }));
  assert.equal(hit.pattern, "GitHub token");
  assert.equal(hit.file, "old.env.js");
});

test("a folder with a long history publishes the files that are there now, as one commit, and keeps its own history", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "now.txt"), "first\n");
  await localInit(d);
  for (let i = 0; i < 9; i++) {
    fs.writeFileSync(path.join(d, "old.txt"), `v${i} ${TOKEN}\n`);
    git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", `c${i}`]);
  }
  fs.writeFileSync(path.join(d, "now.txt"), "current only\n");
  fs.rmSync(path.join(d, "old.txt"));
  const ready = await prepareFirstPush({ dir: d });
  t.after(() => { if (ready.publishDir) fs.rmSync(ready.publishDir, { recursive: true, force: true }); });
  assert.equal(ready.fresh, true);
  assert.equal(git(ready.publishDir, ["rev-list", "--count", "HEAD"]).trim(), "1");
  assert.equal(fs.readFileSync(path.join(ready.publishDir, "now.txt"), "utf8"), "current only\n");
  assert.equal(fs.existsSync(path.join(ready.publishDir, "old.txt")), false);
  assert.equal(ready.hit, null, "a secret that lives only in the old commits is not sent");
  assert.ok(Number(git(d, ["rev-list", "--count", "HEAD"]).trim()) > 8);
});

test("a folder with only a few commits still publishes its history", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "now.txt"), "first\n");
  await localInit(d);
  fs.writeFileSync(path.join(d, "now.txt"), "second\n");
  git(d, ["add", "-A"]); git(d, ["commit", "-q", "-m", "second"]);
  const ready = await prepareFirstPush({ dir: d });
  assert.equal(ready.fresh, false);
  assert.equal(ready.publishDir, undefined);
  assert.equal(Number(git(d, ["rev-list", "--count", "HEAD"]).trim()) > 1, true);
});

test("when git cannot answer (a missing branch, a broken object) the folder is not called clean", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "index.html"), "<p>hi</p>\n");
  const i = await localInit(d);
  assert.deepEqual(await scanWholeBranch({ repoDir: d, branch: "no-such-branch" }), { unreadable: true });
  const blob = git(d, ["rev-parse", `${i.branch}:index.html`]).trim();
  fs.rmSync(path.join(d, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  assert.deepEqual(await scanWholeBranch({ repoDir: d, branch: i.branch }), { unreadable: true }, "the file git cannot read is not called clean");
});
