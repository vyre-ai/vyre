// @ts-check
// git.js: the sanitisers, the folder-naming helper, cloneRepo (against a local https-refusing
// case only — team rules forbid a real outbound network call in a test, so the real GitHub path
// is exercised by lib/git-safe-askpass.test.js's credential-fill proof instead, and here we prove
// the protocol restriction itself: nothing but https gets through, not even a local file:// repo),
// and worktree add/remove against a real local repo. Worktree operations are local-only git, so
// they need no network allowance and are tested for real, through git-safe.js, exactly as
// github.session.worktree/.cleanup use them.
//
// Test setup for the worktree tests clones the fixture repo with plain child_process (not through
// git-safe, and not through cloneRepo): that stands in for "a repo Vyre already cloned", the state
// worktreeAdd and worktreeRemove actually operate on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitSync } from "../../lib/git-safe.js";
import { cloneRepo, worktreeAdd, worktreeRemove, freeFolder, safeSegment, originFullName, readOrigin, remoteUrl, remoteAdd } from "./git.js";

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

test("cloneRepo: only https is reachable - a local file:// repo (or any other transport) is refused, even with a correct token", async t => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-src2-"));
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-projects4-"));
  t.after(() => { fs.rmSync(src, { recursive: true, force: true }); fs.rmSync(projectsDir, { recursive: true, force: true }); });
  plainGit(src, ["init", "-q", "-b", "main"]);
  plainGit(src, ["config", "user.email", "a@example.com"]);
  plainGit(src, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(src, "README.md"), "hello\n");
  plainGit(src, ["add", "README.md"]);
  plainGit(src, ["commit", "-q", "-m", "first"]);

  await assert.rejects(
    cloneRepo({ projectsDir, name: "harlow", url: src, token: "not-a-real-token" }),
    /clone failed/,
  );
  assert.ok(!fs.existsSync(path.join(projectsDir, "harlow")), "a refused clone leaves no folder behind");
});

test("worktreeAdd: makes an isolated worktree and branch, invisible to git status in the main clone", async t => {
  const repoDir = makeClonedRepo(t);
  const w1 = await worktreeAdd({ repoDir, session: "abc123", defaultBranch: "main" });
  assert.equal(w1.branch, "vyre/abc123");
  assert.ok(fs.existsSync(path.join(w1.path, "README.md")));
  // .sessions/ is excluded locally (.git/info/exclude), never the tracked .gitignore.
  const status = gitSync(repoDir, ["status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "", "the worktree folder does not show up as untracked");
  assert.ok(fs.readFileSync(path.join(repoDir, ".git", "info", "exclude"), "utf8").includes(".sessions/"));
});

test("worktreeRemove: a clean worktree with no commits of its own is removed, and its branch pruned", async t => {
  const repoDir = makeClonedRepo(t);
  await worktreeAdd({ repoDir, session: "clean1", defaultBranch: "main" });
  const r = await worktreeRemove({ repoDir, session: "clean1", defaultBranch: "main" });
  assert.deepEqual(r, { removed: true, pruned: true });
  assert.ok(!fs.existsSync(path.join(repoDir, ".sessions", "clean1")));
  assert.equal(gitSync(repoDir, ["rev-parse", "--verify", "--quiet", "vyre/clean1"]).ok, false);
});

test("worktreeRemove: the user's binding rule - never auto-delete. An uncommitted change, an untracked file, or a commit not on the default branch or a remote each block removal; nothing is force-removed and no branch is force-deleted", async t => {
  const repoDir = makeClonedRepo(t);

  // Uncommitted change to a tracked file.
  const w1 = await worktreeAdd({ repoDir, session: "dirty1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w1.path, "README.md"), "changed\n");
  const r1 = await worktreeRemove({ repoDir, session: "dirty1", defaultBranch: "main" });
  assert.equal(r1.removed, false);
  assert.equal(r1.needsConfirm, true);
  assert.ok(r1.dirty.length > 0, "the modified file shows up as something that would be lost");
  assert.equal(r1.commits.length, 0);
  assert.ok(fs.existsSync(w1.path), "the worktree is untouched");
  assert.equal(gitSync(repoDir, ["rev-parse", "--verify", "--quiet", "vyre/dirty1"]).ok, true, "the branch is untouched");

  // An untracked file, nothing committed.
  const w2 = await worktreeAdd({ repoDir, session: "dirty2", defaultBranch: "main" });
  fs.writeFileSync(path.join(w2.path, "scratch.txt"), "notes\n");
  const r2 = await worktreeRemove({ repoDir, session: "dirty2", defaultBranch: "main" });
  assert.equal(r2.removed, false);
  assert.ok(r2.dirty.some(l => l.includes("scratch.txt")));
  assert.ok(fs.existsSync(w2.path));

  // A real commit that is on neither the default branch nor any remote.
  const w3 = await worktreeAdd({ repoDir, session: "unmerged1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w3.path, "notes.md"), "work in progress\n");
  plainGit(w3.path, ["add", "notes.md"]);
  plainGit(w3.path, ["commit", "-q", "-m", "wip"]);
  const r3 = await worktreeRemove({ repoDir, session: "unmerged1", defaultBranch: "main" });
  assert.equal(r3.removed, false);
  assert.equal(r3.dirty.length, 0, "the worktree itself is clean; it's the commit that's at risk");
  assert.ok(r3.commits.length === 1 && r3.commits[0].includes("wip"));
  assert.equal(gitSync(repoDir, ["rev-parse", "--verify", "--quiet", "vyre/unmerged1"]).ok, true, "the branch survives untouched");

  // An IGNORED file (a .env, build output, a local dataset): plain `git status --porcelain`
  // skips these entirely, and a plain `git worktree remove` deletes them without complaint - the
  // reviewer's MEDIUM on 58d0dd87. Nothing here is committed or tracked at all.
  const w4 = await worktreeAdd({ repoDir, session: "ignored1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w4.path, ".gitignore"), "secrets.env\n");
  fs.writeFileSync(path.join(w4.path, "secrets.env"), "API_KEY=do-not-lose-me\n");
  const r4 = await worktreeRemove({ repoDir, session: "ignored1", defaultBranch: "main" });
  assert.equal(r4.removed, false);
  assert.ok(r4.dirty.some(l => l.includes("secrets.env")), "the ignored file is counted as at-risk");
  assert.ok(fs.existsSync(path.join(w4.path, "secrets.env")), "the ignored file survives - nothing was removed");
});

test("worktreeRemove: a commit already merged into the default branch, or already on a remote, is safe and gets cleaned up", async t => {
  const repoDir = makeClonedRepo(t);

  // Merged into the default branch: fast-forward main to include the session's commit.
  const w1 = await worktreeAdd({ repoDir, session: "merged1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w1.path, "notes.md"), "done\n");
  plainGit(w1.path, ["add", "notes.md"]);
  plainGit(w1.path, ["commit", "-q", "-m", "landed"]);
  plainGit(repoDir, ["merge", "-q", "--ff-only", "vyre/merged1"]);
  const r1 = await worktreeRemove({ repoDir, session: "merged1", defaultBranch: "main" });
  assert.equal(r1.removed, true, JSON.stringify(r1));

  // On a remote, even though it's not on the default branch: push the session branch to a
  // second local repo standing in for "origin", which is exactly what `--remotes` sees.
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-remote-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  plainGit(remote, ["init", "-q", "--bare"]);
  // makeClonedRepo's clone already made an "origin" remote pointing at the throwaway src repo;
  // point it at this one instead rather than adding a second remote.
  plainGit(repoDir, ["remote", "set-url", "origin", remote]);
  const w2 = await worktreeAdd({ repoDir, session: "pushed1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w2.path, "feature.md"), "shipped elsewhere\n");
  plainGit(w2.path, ["add", "feature.md"]);
  plainGit(w2.path, ["commit", "-q", "-m", "on a remote, not on main"]);
  plainGit(w2.path, ["push", "-q", "origin", "vyre/pushed1"]);
  const r2 = await worktreeRemove({ repoDir, session: "pushed1", defaultBranch: "main" });
  assert.equal(r2.removed, true, JSON.stringify(r2));
});

test("worktreeAdd: a hostile session id cannot escape .sessions/ or forge a branch name", async t => {
  const repoDir = makeClonedRepo(t);
  const w = await worktreeAdd({ repoDir, session: "../../etc/passwd", defaultBranch: "main" });
  assert.ok(w.path.startsWith(path.join(repoDir, ".sessions") + path.sep), "the worktree stays under .sessions/");
  assert.doesNotMatch(w.branch, /\.\./);
});

test("originFullName: reads owner/name out of https (with or without a userinfo prefix), ssh and ssh:// forms, and refuses anything that isn't github.com", () => {
  assert.equal(originFullName("https://github.com/alex/harlow-legal"), "alex/harlow-legal");
  assert.equal(originFullName("https://github.com/alex/harlow-legal.git"), "alex/harlow-legal");
  assert.equal(originFullName("https://x-access-token@github.com/alex/harlow-legal.git"), "alex/harlow-legal");
  assert.equal(originFullName("git@github.com:alex/harlow-legal.git"), "alex/harlow-legal");
  assert.equal(originFullName("ssh://git@github.com/alex/harlow-legal.git"), "alex/harlow-legal");
  assert.equal(originFullName("https://gitlab.com/alex/harlow-legal.git"), null);
  assert.equal(originFullName("/local/path/harlow-legal"), null);
  assert.equal(originFullName(""), null);
});

test("readOrigin: says isRepo:false outside any git repo, isRepo:true with origin:null when there's no origin remote, and the URL when there is one", async t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.deepEqual(await readOrigin(plain), { isRepo: false, origin: null });

  const repoDir = makeClonedRepo(t);
  assert.deepEqual(await readOrigin(repoDir), { isRepo: true, origin: await remoteUrl(repoDir, "origin") });

  plainGit(repoDir, ["remote", "remove", "origin"]);
  assert.deepEqual(await readOrigin(repoDir), { isRepo: true, origin: null });
});

test("remoteAdd/remoteUrl: adds a new remote and reads it back; never overwrites one that's already there", async t => {
  const repoDir = makeClonedRepo(t);
  plainGit(repoDir, ["remote", "remove", "origin"]);
  assert.equal(await remoteUrl(repoDir, "github"), null);
  await remoteAdd(repoDir, "github", "https://github.com/alex/harlow-legal.git");
  assert.equal(await remoteUrl(repoDir, "github"), "https://github.com/alex/harlow-legal.git");

  // A second add for the same name is refused (git's own "remote already exists"), and the
  // original URL survives untouched - the actual protection github.project.link relies on.
  await assert.rejects(remoteAdd(repoDir, "github", "https://github.com/someone-else/other.git"), /remote add failed/);
  assert.equal(await remoteUrl(repoDir, "github"), "https://github.com/alex/harlow-legal.git");
});
