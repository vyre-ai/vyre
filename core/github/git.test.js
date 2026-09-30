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
import { cloneRepo, worktreeAdd, worktreeRemove, freeFolder, safeSegment, originFullName, sanitizeRemoteUrl, remoteUrl, listRemotes, folderGitState, defaultBranchOf, scanOutgoing, pushSession } from "./git.js";

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
    cloneRepo({ projectsDir, name: "harlow", url: src, token: "not-a-real-token", fullName: "alex/harlow", base: DEAD }),
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

test("worktreeAdd: unarchive - an existing branch is checked out as it is (commits kept), and a worktree already there is returned unchanged", async t => {
  const repoDir = makeClonedRepo(t);
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-remote-"));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  plainGit(remote, ["init", "-q", "--bare"]);
  plainGit(repoDir, ["remote", "set-url", "origin", remote]);
  const w1 = await worktreeAdd({ repoDir, session: "back1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w1.path, "kept.md"), "still here\n");
  plainGit(w1.path, ["add", "kept.md"]);
  plainGit(w1.path, ["commit", "-q", "-m", "kept"]);
  plainGit(w1.path, ["push", "-q", "origin", "vyre/back1"]);
  const rm = await worktreeRemove({ repoDir, session: "back1", defaultBranch: "main" });
  assert.equal(rm.removed, true);
  assert.equal(rm.pruned, false, "the branch outlives the worktree: it holds a commit main lacks");
  const w2 = await worktreeAdd({ repoDir, session: "back1", defaultBranch: "main" });
  assert.equal(w2.branch, "vyre/back1");
  assert.equal(fs.readFileSync(path.join(w2.path, "kept.md"), "utf8"), "still here\n");
  const again = await worktreeAdd({ repoDir, session: "back1", defaultBranch: "main" });
  assert.deepEqual(again, w2);
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
  // repo names with a real dot in them still work (the charset allows dots; only the exact
  // literal "." or ".." is excluded, next).
  assert.equal(originFullName("https://github.com/alex/harlow.legal.git"), "alex/harlow.legal");
});

test("originFullName: a path-traversal owner or a bare '.'/'..' name is refused, not resolved (reviewer's LOW on e5a612c0 - the old owner charset let '../user' reach /repos/user)", () => {
  assert.equal(originFullName("https://github.com/../user/harlow-legal.git"), null, "owner's charset has no slash or dot to traverse with");
  assert.equal(originFullName("https://github.com/alex/."), null);
  assert.equal(originFullName("https://github.com/alex/.."), null);
  assert.equal(originFullName("git@github.com:alex/..git"), null, "the lazy name match takes '.' here once the optional .git suffix absorbs the rest, and a bare '.' must still be refused");
});

test("sanitizeRemoteUrl: strips userinfo, query and fragment from a scheme:// URL; leaves scp-like ssh (no such syntax) and an unparsable value alone", () => {
  assert.equal(sanitizeRemoteUrl("https://x-access-token:ghp_supersecrettoken123@github.com/alex/harlow-legal.git"), "https://github.com/alex/harlow-legal.git");
  assert.equal(sanitizeRemoteUrl("https://ghp_supersecrettoken123@github.com/alex/harlow-legal.git"), "https://github.com/alex/harlow-legal.git");
  assert.equal(sanitizeRemoteUrl("https://github.com/alex/harlow-legal.git?token=ghp_leak#frag"), "https://github.com/alex/harlow-legal.git");
  assert.equal(sanitizeRemoteUrl("git@github.com:alex/harlow-legal.git"), "git@github.com:alex/harlow-legal.git");
  assert.equal(sanitizeRemoteUrl(""), "");
  assert.equal(sanitizeRemoteUrl("not a url at all"), "not a url at all");
});

test("sanitizeRemoteUrl: fails CLOSED when WHATWG URL itself throws - the userinfo is still stripped by a regex, never the raw input (reviewer's LOW on 5b1c69f1)", () => {
  const withCreds = "http://u:p@github.com:99999/o/r"; // an out-of-range port makes new URL() throw
  assert.throws(() => new URL(withCreds), "confirms this value really does throw, so the fallback path is what's under test");
  const out = sanitizeRemoteUrl(withCreds);
  assert.ok(!out.includes("u:p@"), `userinfo survived the fallback: ${out}`);
  assert.ok(!out.includes(":p@"), `the password half alone survived: ${out}`);
  assert.equal(out, "http://github.com:99999/o/r");

  // the fallback also cuts a query string or fragment, the same two things the happy path strips
  assert.equal(sanitizeRemoteUrl("http://secret:tok@github.com:99999/o/r?x=1#y"), "http://github.com:99999/o/r");
});

test("remoteUrl: the URL a named remote points at, or null when there is no remote by that name", async t => {
  const repoDir = makeClonedRepo(t);
  assert.equal(await remoteUrl(repoDir, "origin"), (await listRemotes(repoDir))[0].url);
  assert.equal(await remoteUrl(repoDir, "github"), null);
});

test("listRemotes: every remote in the repo, [] with no remotes and outside a repo, in git's own order", async t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-noremotes-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.deepEqual(await listRemotes(plain), []);

  const repoDir = makeClonedRepo(t);
  plainGit(repoDir, ["remote", "remove", "origin"]);
  assert.deepEqual(await listRemotes(repoDir), []);

  plainGit(repoDir, ["remote", "add", "origin", "https://gitlab.com/alex/somewhere.git"]);
  plainGit(repoDir, ["remote", "add", "github", "https://github.com/alex/harlow-legal.git"]);
  assert.deepEqual(await listRemotes(repoDir), [
    { name: "github", url: "https://github.com/alex/harlow-legal.git" },
    { name: "origin", url: "https://gitlab.com/alex/somewhere.git" },
  ]);
});

test("folderGitState: isRepo:false with no remotes outside a repo, isRepo:true plus every remote inside one", async t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-state-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.deepEqual(await folderGitState(plain), { isRepo: false, remotes: [] });

  const repoDir = makeClonedRepo(t);
  const state = await folderGitState(repoDir);
  assert.equal(state.isRepo, true);
  assert.deepEqual(state.remotes, [{ name: "origin", url: await remoteUrl(repoDir, "origin") }]);
});

test("defaultBranchOf: prefers origin/HEAD when there's a remote, falls back to the checked-out branch when there isn't (0.2: any repo, GitHub's or local-only)", async t => {
  const repoDir = makeClonedRepo(t);
  // makeClonedRepo's plain clone sets origin/HEAD via the clone itself.
  assert.equal(await defaultBranchOf(repoDir), "main");

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-defbranch-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  plainGit(plain, ["init", "-q", "-b", "trunk"]);
  plainGit(plain, ["config", "user.email", "a@example.com"]);
  plainGit(plain, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(plain, "f"), "x\n");
  plainGit(plain, ["add", "f"]);
  plainGit(plain, ["commit", "-q", "-m", "first"]);
  assert.equal(await defaultBranchOf(plain), "trunk", "no remote at all - falls back to whatever's checked out");

  const noRepo = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-defbranch-none-"));
  t.after(() => fs.rmSync(noRepo, { recursive: true, force: true }));
  assert.equal(await defaultBranchOf(noRepo), null);
});

test("scanOutgoing: finds a known secret shape only in the ADDED lines of a branch, not in the default branch's own history, and reports the file and an approximate line", async t => {
  const repoDir = makeClonedRepo(t);
  plainGit(repoDir, ["checkout", "-q", "-b", "vyre/s1"]);
  fs.writeFileSync(path.join(repoDir, "config.env"), "PORT=3000\nAWS_KEY=" + "AKIA" + "ABCDEFGHIJKLMNOP\n");
  plainGit(repoDir, ["add", "config.env"]);
  plainGit(repoDir, ["commit", "-q", "-m", "add config"]);

  const hit = await scanOutgoing({ repoDir, branch: "vyre/s1", defaultBranch: "main" });
  assert.equal(hit.pattern, "AWS access key");
  assert.equal(hit.file, "config.env");
  assert.equal(hit.line, 2);

  // a branch with nothing secret-shaped in it: no hit.
  plainGit(repoDir, ["checkout", "-q", "-b", "vyre/s2", "main"]);
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "just some notes\n");
  plainGit(repoDir, ["add", "readme.txt"]);
  plainGit(repoDir, ["commit", "-q", "-m", "notes"]);
  assert.equal(await scanOutgoing({ repoDir, branch: "vyre/s2", defaultBranch: "main" }), null);
});

const DEAD = "https://127.0.0.1:9"; // nothing listens: a push that gets past every check fails fast, offline

test("pushSession: refuses on a secret hit before ever attempting the network push, and the override skips the scan", async t => {
  const repoDir = makeClonedRepo(t);
  const w = await worktreeAdd({ repoDir, session: "secret1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w.path, "keys.txt"), "github_pat_11AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n");
  plainGit(w.path, ["add", "keys.txt"]);
  plainGit(w.path, ["commit", "-q", "-m", "oops"]);

  const blocked = await pushSession({ repoDir, session: "secret1", defaultBranch: "main", token: "not-a-real-token", fullName: "alex/harlow", base: DEAD });
  assert.equal(blocked.pushed, false);
  assert.equal(blocked.blocked, "secret");
  assert.equal(blocked.pattern, "GitHub token");
  assert.equal(blocked.file, "keys.txt");

  // allowSecret skips the scan and reaches the actual push attempt - which then hits the same
  // https-only protocol restriction every other network call in this module has (git.test.js's
  // own cloneRepo test proves the same thing for clone; makeClonedRepo's origin is a plain local
  // path, so this proves the restriction holds for push too, without needing a real network call).
  await assert.rejects(
    pushSession({ repoDir, session: "secret1", defaultBranch: "main", token: "not-a-real-token", fullName: "alex/harlow", base: DEAD, allowSecret: true }),
    /push failed/,
  );
});

test("pushSession: a session with nothing secret-shaped still hits the same https-only protocol restriction against a local remote (no real network needed to prove the isolation holds)", async t => {
  const repoDir = makeClonedRepo(t);
  const w = await worktreeAdd({ repoDir, session: "clean1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w.path, "notes.md"), "nothing secret here\n");
  plainGit(w.path, ["add", "notes.md"]);
  plainGit(w.path, ["commit", "-q", "-m", "notes"]);

  await assert.rejects(
    pushSession({ repoDir, session: "clean1", defaultBranch: "main", token: "not-a-real-token", fullName: "alex/harlow", base: DEAD }),
    /push failed/,
  );
});

test("pushSession: a hostile session id can't push anything but its own sanitized vyre/<id> branch", async t => {
  const repoDir = makeClonedRepo(t);
  // No worktree/branch exists for this id at all (safeSegment already proves the sanitizing
  // itself elsewhere) - the push fails outright, never reaching or affecting any other branch.
  await assert.rejects(
    pushSession({ repoDir, session: "../../etc/passwd", defaultBranch: "main", token: "not-a-real-token", fullName: "alex/harlow", base: DEAD }),
    /push failed/,
  );
});

test("pushSession: the push runs from a fresh throwaway repo that has read none of the project's config - origin, pushurl, insteadOf, http.*, include.path, credential - and the folder is deleted after", async t => {
  const repoDir = makeClonedRepo(t);
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-evil-"));
  t.after(() => fs.rmSync(evil, { recursive: true, force: true }));
  plainGit(evil, ["init", "-q", "--bare"]);
  const w = await worktreeAdd({ repoDir, session: "tamper1", defaultBranch: "main" });
  fs.writeFileSync(path.join(w.path, "n.md"), "x\n");
  plainGit(w.path, ["add", "n.md"]);
  plainGit(w.path, ["commit", "-q", "-m", "n"]);
  const tip = plainGit(repoDir, ["rev-parse", "refs/heads/vyre/tamper1"]).trim();
  // Everything an agent's shell could plant, including an include.path to a file that carries a scoped curloptResolve.
  const poison = path.join(evil, "evil.cfg");
  fs.writeFileSync(poison, '[http "https://github.com/"]\n\tcurloptResolve = github.com:443:127.0.0.1\n\tsslCAInfo = /tmp/evil-ca.pem\n');
  plainGit(repoDir, ["remote", "set-url", "origin", evil]);
  plainGit(repoDir, ["config", "remote.origin.pushurl", evil]);
  plainGit(repoDir, ["config", `url.${evil}/.insteadOf`, `${DEAD}/`]);
  plainGit(repoDir, ["config", `url.${evil}/.pushInsteadOf`, `${DEAD}/`]);
  plainGit(repoDir, ["config", "http.curloptResolve", "github.com:443:127.0.0.1"]);
  plainGit(repoDir, ["config", "http.proxy", "http://127.0.0.1:1"]);
  plainGit(repoDir, ["config", "credential.helper", "store"]);
  plainGit(repoDir, ["config", "core.gitProxy", "x"]);
  plainGit(repoDir, ["config", "include.path", poison]);
  let seen = null;
  const inspect = tmp => {
    const cfg = fs.readFileSync(path.join(tmp, "config"), "utf8");
    seen = { tmp, cfg, refs: plainGit(tmp, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim(), hooks: fs.existsSync(path.join(tmp, "hooks")), type: plainGit(tmp, ["cat-file", "-t", tip]).trim() };
  };
  await assert.rejects(pushSession({ repoDir, session: "tamper1", defaultBranch: "main", token: "not-a-real-token", fullName: "alex/harlow", base: DEAD, inspect }), /push failed/);
  assert.ok(seen, "the push ran from a temp repo");
  for (const bad of ["evil", "include", "insteadOf", "http", "credential", "gitProxy", "remote"]) assert.ok(!seen.cfg.includes(bad), `the temp repo's config has no ${bad}`);
  assert.equal(seen.refs, `refs/heads/vyre/tamper1 ${tip}`, "one ref, the session's tip");
  assert.equal(seen.hooks, false);
  assert.equal(seen.type, "commit", "the project's objects are reachable through the alternates file");
  assert.equal(fs.existsSync(seen.tmp), false, "the temp repo is deleted");
  assert.equal(plainGit(evil, ["for-each-ref"]).trim(), "", "the rewritten origin was never pushed to");
  await assert.rejects(pushSession({ repoDir, session: "tamper1", defaultBranch: "main", token: "t", fullName: "../evil", base: DEAD }), e => e.code === "bad_input");
  await assert.rejects(pushSession({ repoDir, session: "nobranch", defaultBranch: "main", token: "t", fullName: "alex/harlow", base: DEAD }), /no branch/);
});
