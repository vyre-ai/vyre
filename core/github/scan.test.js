// @ts-check
// What a first push to a new repo may send: the folder's tree and, when it already has commits, every line any commit ever added; and when git cannot answer, the answer is "could not check", never "clean".
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { localInit, scanWholeBranch } from "./git.js";

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

test("when git cannot answer in time the folder is not called clean", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "index.html"), "<p>hi</p>\n");
  const i = await localInit(d);
  assert.deepEqual(await scanWholeBranch({ repoDir: d, branch: i.branch, timeout: 1 }), { unreadable: true });
  assert.deepEqual(await scanWholeBranch({ repoDir: d, branch: "no-such-branch" }), { unreadable: true });
});
