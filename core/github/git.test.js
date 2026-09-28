// @ts-check
// git.js: the sanitisers, the folder-naming helper, cloneRepo's honest refusal (blocked on
// git-safe.js gaining network access — see git.js's header), and worktree add/remove against a
// real local repo. Worktree operations are local-only git, so they need no network allowance and
// are tested for real, through git-safe.js, exactly as github.session.worktree/.cleanup use them.
//
// Test setup clones the fixture repo with plain child_process (not through git-safe, and not
// through cloneRepo): that stands in for "a repo Vyre already cloned", the state worktreeAdd and
// worktreeRemove actually operate on. It is not a claim that Vyre's own clone works today.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitSync } from "../../lib/git-safe.js";
import { cloneRepo, worktreeAdd, worktreeRemove, freeFolder, safeSegment } from "./git.js";

const plainGit = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });

/** A source repo with one commit on `main`, and a plain-git clone of it: "an existing clone". */
function makeClonedRepo(t) {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-src-"));
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-projects-"));
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(projectsDir, { recursive: true, force: true }); });
  plainGit(src, ["init", "-q", "-b", "main"]);
  plainGit(src, ["config", "user.email", "a@example.com"]);
  plainGit(src, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  plainGit(src, ["add", "README.md"]);
  plainGit(src, ["commit", "-q", "-m", "first"]);
  const repoDir = path.join(projectsDir, "harlow");
  plainGit(projectsDir, ["clone", "-q", src, repoDir]);
  plainGit(repoDir, ["config", "user.email", "a@example.com"]);
  plainGit(repoDir, ["config", "user.name", "a"]);
  return repoDir;
}

test("safeSegment: strips a path escape and a leading dot, collapses '..' anywhere (git's own ref-format rule), refuses a dots-only or empty result", () => {
  assert.equal(safeSegment("my-repo_1.2"), "my-repo_1.2");
  const escaped = safeSegment("../../etc/passwd");
  assert.doesNotMatch(escaped, /\//, "no slash survives, so it can never become more than one path segment");
  assert.doesNotMatch(escaped, /\.\./, "no .. survives anywhere (git refuses a branch name that has one)");
  assert.equal(safeSegment(".hidden"), "hidden");
  assert.equal(safeSegment("-x"), "x", "a leading dash could be read as a flag");
  assert.throws(() => safeSegment(""), /no safe form/);
  assert.throws(() => safeSegment(".."), /no safe form/);
  assert.throws(() => safeSegment("."), /no safe form/);
});

test("freeFolder: the first free name, then -2, -3 once the folder exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-free-"));
  try {
    assert.equal(freeFolder(dir, "harlow"), path.join(dir, "harlow"));
    fs.mkdirSync(path.join(dir, "harlow"));
    assert.equal(freeFolder(dir, "harlow"), path.join(dir, "harlow-2"));
    fs.mkdirSync(path.join(dir, "harlow-2"));
    assert.equal(freeFolder(dir, "harlow"), path.join(dir, "harlow-3"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cloneRepo: refuses plainly for a public repo (git-safe has no network allowance yet) and names the extra reason for a private one", async () => {
  await assert.rejects(cloneRepo({ projectsDir: "/tmp", name: "x", url: "https://github.com/x/y", private: false }), /network-allow addition/);
  await assert.rejects(cloneRepo({ projectsDir: "/tmp", name: "x", url: "https://github.com/x/y", private: true }), /askpass addition for a private repo/);
});

test("worktreeAdd/worktreeRemove: a session gets its own worktree and branch, invisible to git status in the main clone; the branch survives cleanup only when it has no commits", async t => {
  const repoDir = makeClonedRepo(t);

  const w1 = await worktreeAdd({ repoDir, session: "abc123", defaultBranch: "main" });
  assert.equal(w1.branch, "vyre/abc123");
  assert.ok(fs.existsSync(path.join(w1.path, "README.md")));
  // .sessions/ is excluded locally (.git/info/exclude), never the tracked .gitignore.
  const status = gitSync(repoDir, ["status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "", "the worktree folder does not show up as untracked");
  assert.ok(fs.readFileSync(path.join(repoDir, ".git", "info", "exclude"), "utf8").includes(".sessions/"));

  // No commits of its own: cleanup prunes the branch too.
  const r1 = await worktreeRemove({ repoDir, session: "abc123", defaultBranch: "main" });
  assert.deepEqual(r1, { removed: true, pruned: true });
  assert.equal(gitSync(repoDir, ["rev-parse", "--verify", "--quiet", "vyre/abc123"]).ok, false);

  // A session that committed keeps its branch after its worktree is cleaned up.
  const w2 = await worktreeAdd({ repoDir, session: "def456", defaultBranch: "main" });
  fs.writeFileSync(path.join(w2.path, "notes.md"), "work in progress\n");
  plainGit(w2.path, ["add", "notes.md"]);
  plainGit(w2.path, ["commit", "-q", "-m", "wip"]);
  const r2 = await worktreeRemove({ repoDir, session: "def456", defaultBranch: "main" });
  assert.deepEqual(r2, { removed: true, pruned: false });
  assert.equal(gitSync(repoDir, ["rev-parse", "--verify", "--quiet", "vyre/def456"]).ok, true, "the branch with real work survives");
});

test("worktreeAdd: a hostile session id cannot escape .sessions/ or forge a branch name", async t => {
  const repoDir = makeClonedRepo(t);
  const w = await worktreeAdd({ repoDir, session: "../../etc/passwd", defaultBranch: "main" });
  assert.ok(w.path.startsWith(path.join(repoDir, ".sessions") + path.sep), "the worktree stays under .sessions/");
  assert.doesNotMatch(w.branch, /\.\./);
});
