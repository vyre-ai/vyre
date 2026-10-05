// @ts-check
// core/team (docs/adr/0031-teammates.md): restart, compaction and worktree isolation.
// Split from one file so each part stays well inside the per-file time limit on a loaded box; the fixtures are in team-fixture.js.


import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { neutralize, rotationContext, isAssistant } from "./index.js";
import { open as openStore } from "../store/index.js";
import { paths } from "../config/index.js";
import { execFileSync } from "node:child_process";
import { worktreePath, branchOf, repoRoot, ensureWorktree, currentBranch } from "./git.js";
import { testHooks, OPEN_WALL } from "../../lib/sandbox/index.js";
// These tests are about the flow around a watcher (the CLI, a hook delivery, a duty), not the wall, and a hosted
// runner has no bubblewrap profile: use the test seam. Production still fails closed (lib/sandbox/wall.js).
testHooks.wall = OPEN_WALL;
import { until, boot, git, GIT_ENV, bootGit, realSession, plantHook, commitOnDesign, setTestCommand } from "./team-fixture.js";

test("a vyre restart while a request is running fails it with a reason, frees the teammate, and runs the next queued one", async t => {
  const { tool, stop, root, project } = await boot(t);
  const agent = `design-${project.slug}`;
  await tool("team.add", { project: project.slug, role: "design" });
  await stop();
  // What a restart leaves behind: one request "running" for a teammate marked working, and one queued behind it.
  const db = openStore(paths(root).db);
  const now = Date.now();
  const ins = (id, state) => db.prepare(`INSERT INTO team_requests (id, teammate, project, from_kind, from_label, via, text, refs, priority, state, attempt, created_at, started_at)
    VALUES (?,?,?,'person','cli','[]',?,'[]','normal',?,1,?,?)`).run(id, agent, project.slug, 'vyre team.done {"result":"second ok","notes":"unchanged","reason":"test"}', state, now, state === "running" ? now : null);
  ins("r_stuck001", "running");
  ins("r_next0002", "queued");
  db.prepare("UPDATE team_teammates SET current_request = 'r_stuck001', state = 'working' WHERE agent = ?").run(agent);
  db.close();
  const d2 = await start({ root, presence: present, log: () => {} });
  t.after(() => d2.stop());
  const st = id => call("team.status", { request: id }, { root, caller: "cli", timeout: 20_000 }).then(r => r.data);
  const stuck = await until(async () => { const r = await st("r_stuck001"); return r && r.state !== "running" ? r : null; }, "the stuck request to close");
  assert.equal(stuck.state, "failed");
  assert.match(stuck.result, /vyre restarted/);
  const next = await until(async () => { const r = await st("r_next0002"); return r && r.state === "done" ? r : null; }, "the queued request to run");
  assert.match(next.result, /second ok/);
});

test("team.act.target and team.roster are internal: a person's surface cannot call them", async t => {
  const { tool, raw, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "design" });
  const r = await raw("team.act.target", { tool: "team.retire", input: { project: project.slug, role: "design" } });
  assert.ok(r.error);
  assert.ok((await raw("team.roster", { project: project.slug })).error);
});

// --- step 2: notes-changed enforcement and compaction re-injection ------------------------------

test("team.done refuses to close a request when the notes have not changed since it started; writing them lets it through", async t => {
  const { tool, root, project } = await boot(t);
  const tm = await tool("team.add", { project: project.slug, role: "design" });
  // Every "vyre <tool> <json>" line found after the first, not only at the very start, is its own
  // call, run in order (fake-claude): a teammate trying team.done, seeing the refusal, writing
  // its notes, and trying again, all in the one turn a real model would.
  const script = [
    'vyre team.done {"result":"trying without notes"}',
    `vyre team.notes {"action":"set","agent":"${tm.agent}","text":"wrote something down"}`,
    'vyre team.done {"result":"now it should work"}',
  ].join("\n");
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: script });
  assert.equal(ask.state, "done"); // the first, refused call never closed it; the third one did
  assert.equal(ask.result, "now it should work");
  const notes = await tool("team.notes", { agent: tm.agent });
  assert.equal(notes.versions.length, 1);
  // The refusal is also a line in the transcript (a "vyre" notice), not only an error the
  // teammate's own turn read (cohesion review, item 3): a person watching would see why it paused.
  const db = openStore(paths(root).db);
  const thread = /** @type {any} */ (db.prepare("SELECT thread FROM team_teammates WHERE agent = ?").get(tm.agent)).thread;
  db.close();
  const got = await tool("threads.get", { thread });
  const notice = got.events.find(e => e.type === "thread.text" && e.payload.notice && /notes have not changed/.test(e.payload.text));
  assert.ok(notice, "expected a paused notice in the transcript");
});

test("team.done: notes: \"unchanged\" with a reason lets a request close with nothing written down", async t => {
  const { tool, project } = await boot(t);
  await tool("team.add", { project: project.slug, role: "design" });
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true,
    text: 'vyre team.done {"result":"nothing to note here","notes":"unchanged","reason":"a status check, nothing learned"}' });
  assert.equal(ask.state, "done");
});

test("compaction: a teammate's own SessionStart (source compact) gets its notes and current request back", async t => {
  const { tool, root, project, launches } = await boot(t);
  const tm = await tool("team.add", { project: project.slug, role: "design", brief: "visual design" });
  await tool("team.notes", { action: "set", agent: tm.agent, text: "Scope: keep the form to one page." });
  // "subagent-slow" holds the turn open long enough to fire the compaction event mid-request, the
  // way a real compaction would land while a teammate is still working an item; not awaited here,
  // so the request stays running while this test drives the SessionStart hook by hand.
  tool("team.ask", { to: "design", project: project.slug, text: "subagent-slow hold this turn open" }).catch(() => {});
  await until(async () => (await tool("team.list", { project: project.slug }))[0].current_request, "the request to start running");
  const launch = await until(() => launches()[0], "the teammate's own launch to log");
  const db = openStore(paths(root).db);
  const thread = /** @type {any} */ (db.prepare("SELECT thread FROM team_teammates WHERE agent = ?").get(tm.agent)).thread;
  db.close();
  const bound = await tool("threads.bind", { session: thread, pid: launch.pid }, "harness");
  // The SessionStart hook itself, carrying the session's key as a real hook does, so vyred verifies whose it is (an unverified brief says nothing about a known thread).
  await tool("harness.brief", { session: thread, source: "compact" }, "harness", { session: { id: thread, key: bound.key } });
  const posted = await until(async () => {
    const got = await tool("threads.get", { thread });
    return got.events.find(e => (e.type === "thread.queued" || e.type === "thread.sent") && e.payload.kind === "compact-reinject");
  }, "the re-injected notes and request");
  assert.match(posted.payload.text, /Scope: keep the form to one page/);
  assert.match(posted.payload.text, /Compaction just cleared your context/);
});

// --- step 4, slice A (2026-09-28): worktree lifecycle, the integrator, merge-before-dispatch ----

test("isolation: worktree falls back to sharing the folder when the project's home is not a git repo, saying so", async t => {
  const { tool, project } = await boot(t);
  // projects.create now keeps a quiet local history in a new folder (acf46930); this test is about a folder that is not a repo.
  fs.rmSync(path.join(project.home, ".git"), { recursive: true, force: true });
  const tm = await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  assert.equal(tm.isolation, "folder"); // never git init'd on the person's behalf: shares the folder instead
  assert.match(tm.notice, /isn't a git repo/);
  assert.match(tm.notice, /share the folder/);
  const rows = await tool("team.list", { project: project.slug });
  assert.equal(rows.length, 1); // the teammate itself, folder-isolated; no integrator (nothing to merge)
  assert.equal(rows[0].agent, tm.agent);
});

test("isolation: worktree makes the teammate's own worktree and branch, and brings an integrator along", async t => {
  const { tool, project, repo } = await bootGit(t);
  const tm = await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  assert.equal(tm.isolation, "worktree");
  assert.match(tm.notice, /"integrator" teammate was added too/, "the answer says one add made two teammates");
  const dir = worktreePath(repo, "design");
  assert.ok(fs.existsSync(dir), "design's worktree should exist");
  assert.equal(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), branchOf("design"));
  const rows = await tool("team.list", { project: project.slug });
  const integrator = rows.find(r => r.role === "integrator");
  assert.ok(integrator, "an integrator should come along with the first worktree teammate");
  assert.ok(fs.existsSync(worktreePath(repo, "integrator")));
});

test("a tag named like the base branch never hijacks a worktree's fork point (reviewer, slice A, MEDIUM)", async t => {
  const { tool, project, repo } = await bootGit(t);
  // A planted tag "main", at the repo's first commit — then real main moves on. gitrevisions'
  // own disambiguation order checks refs/tags/<name> before refs/heads/<name>, so a bare "main"
  // would resolve to this tag, not the real branch tip, unless every ref is fully qualified.
  git(project.home, ["tag", "main"]);
  fs.writeFileSync(path.join(project.home, "CHANGES.md"), "real main moved on\n");
  git(project.home, ["add", "."]);
  git(project.home, ["commit", "-q", "-m", "second, on the real branch"]);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  const dir = worktreePath(repo, "design");
  assert.ok(fs.existsSync(path.join(dir, "CHANGES.md")),
    "the worktree should fork from refs/heads/main's real tip, not a same-named tag");
});

test("re-adding a worktree whose branch already exists (its folder gone) checks the branch out, not a detached HEAD, even beside a same-named tag (reviewer, slice A, MEDIUM)", async t => {
  const { project, repo } = await bootGit(t);
  const role = "design", branch = branchOf(role);
  const first = await ensureWorktree(repo, role, "main");
  assert.ok(first.ok, first.stderr);
  // The folder is gone (a person cleaning up, or the integrator's own worktree being recreated),
  // but the branch it made lives on — the case that hits `worktree add <dir> <branch>` again.
  git(repo, ["worktree", "remove", "--force", first.dir]);
  // A tag sharing the branch's exact name: worktree add's own branch dwim must still win, since
  // a fully qualified refs/heads/<branch> (the tag-hijack fix's own qualifying) would instead
  // hand git a bare commit to check out, always detached, tag or no tag.
  git(repo, ["tag", branch]);
  const second = await ensureWorktree(repo, role, "main");
  assert.ok(second.ok, second.stderr);
  assert.equal(await currentBranch(second.dir), branch, "re-adding the worktree should check the branch out, not leave it detached");
});

test("a second worktree teammate does not get a second integrator", async t => {
  const { tool, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  await tool("team.add", { project: project.slug, role: "backend", isolation: "worktree" });
  const rows = await tool("team.list", { project: project.slug });
  assert.equal(rows.filter(r => r.role === "integrator").length, 1);
});

test("a worktree teammate's dispatch merges main in first, and runs in its own worktree, not the project's", async t => {
  const { tool, project, repo, launches } = await bootGit(t);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  // Advance main after the teammate (and its worktree) already exist, the way real work would.
  fs.writeFileSync(path.join(project.home, "CHANGES.md"), "a later change on main\n");
  git(project.home, ["add", "."]);
  git(project.home, ["commit", "-q", "-m", "later, on main"]);
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: 'vyre team.done {"result":"ok","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  const dir = worktreePath(repo, "design");
  assert.ok(fs.existsSync(path.join(dir, "CHANGES.md")), "main's later commit should have been merged in before dispatch");
  const launch = launches().find(l => l.cwd === dir);
  assert.ok(launch, "the teammate's own session should run with its worktree as cwd, not the project's home");
});

test("a repo forcing signing on cannot deny vyred's own merges (reviewer LOW)", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  // A commit of design's own, so it is genuinely ahead of main and a merge back is actually
  // queued to the integrator below (mergeBranchIn) — not only mergeBaseIn's own merge-main-in.
  // Setup commits (this and main's, below) are the person's own, made before the repo is set to
  // force signing, so they need no override themselves — only vyred's own merges, after, do.
  await commitOnDesign(repo);
  fs.writeFileSync(path.join(project.home, "CHANGES.md"), "a later change on main\n");
  git(project.home, ["add", "."]);
  git(project.home, ["commit", "-q", "-m", "later, on main"]);
  // A teammate can write the shared .git same as any other config here: commit.gpgSign and
  // merge.verifySignatures are both real git settings, not a filter/diff/merge driver name, so
  // unsafeConfig's own refusal never catches them — only the command line forcing them back off
  // (VYRE_IDENTITY) does. Without that, lib/git-safe.js's gpg.program=false alone would turn this
  // into a denial of service: every vyred merge failing outright ("gpg failed to sign", or a
  // signature check with nothing that can ever pass), not merely a neutered signature.
  git(project.home, ["config", "commit.gpgSign", "true"]);
  git(project.home, ["config", "merge.verifySignatures", "true"]);
  // mergeBaseIn: the per-dispatch merge of main into a worktree teammate's own branch.
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: 'vyre team.done {"result":"ok","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done", "mergeBaseIn should not be denied by the repo's own forced signing");
  // mergeBranchIn: the integrator's own automatic merge back into main, from that same request.
  const integratorAgent = /** @type {any} */ (openStore(paths(root).db).prepare("SELECT agent FROM team_teammates WHERE project = ? AND role = 'integrator'").get(project.slug)).agent;
  const merge = await until(async () => {
    const db = openStore(paths(root).db);
    const row = /** @type {any} */ (db.prepare("SELECT * FROM team_requests WHERE teammate = ? ORDER BY created_at DESC LIMIT 1").get(integratorAgent));
    db.close();
    return row && row.state !== "queued" && row.state !== "running" ? row : null;
  }, "the merge to finish");
  assert.equal(merge.state, "done", "mergeBranchIn should not be denied by the repo's own forced signing either");
});

test("a merge conflict fails the request cleanly, and leaves the worktree ready for the next one", async t => {
  const { tool, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  const dir = worktreePath(repo, "design");
  // A conflicting change already sitting in the worktree's branch (as an earlier request's real
  // work would leave it), and a different one on main: the next dispatch's merge collides.
  fs.writeFileSync(path.join(dir, "README.md"), "changed by design\n");
  git(dir, ["commit", "-q", "-am", "design's own change"]);
  fs.writeFileSync(path.join(project.home, "README.md"), "changed by main\n");
  git(project.home, ["commit", "-q", "-am", "main's own change"]);
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: 'vyre team.done {"result":"should never run"}' });
  assert.equal(ask.state, "failed");
  assert.match(ask.result, /could not merge/);
  assert.equal(git(dir, ["status", "--porcelain=v1"]).trim(), ""); // merge --abort left it clean
  assert.ok(!fs.existsSync(path.join(dir, ".git", "MERGE_HEAD")));
});

test("a worktree teammate's request that finishes with new commits queues a merge to the integrator", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  const tm = await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  const dir = worktreePath(repo, "design");
  // The real work a teammate's own turn would have committed via Bash; seeded directly here
  // since scripting file edits through the fake driver's own tool-use protocol is a much heavier
  // way to test the same thing (detecting and queueing new commits), which is what this covers.
  fs.writeFileSync(path.join(dir, "form.md"), "a calmer form\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "calmer form"]);
  const ask = await tool("team.ask", { to: "design", project: project.slug, wait: true, text: 'vyre team.done {"result":"done","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  // Read as it lands, not only while "queued": with nothing else to do, the integrator's own
  // fake-driver turn dispatches almost at once and (having no "vyre team.done" line of its own)
  // auto-fails just as fast — this test is only about the request having been made at all.
  const merge = await until(async () => {
    const db = openStore(paths(root).db);
    const integrator = /** @type {any} */ (db.prepare("SELECT agent FROM team_teammates WHERE project = ? AND role = 'integrator'").get(project.slug));
    const row = integrator && /** @type {any} */ (db.prepare("SELECT text FROM team_requests WHERE teammate = ? ORDER BY created_at DESC LIMIT 1").get(integrator.agent));
    db.close();
    return row && /^merge team\/design /.test(row.text) ? row : null;
  }, "a merge request queued to the integrator");
  assert.match(merge.text, new RegExp(`from request ${ask.request}`));
});

test("stopping the daemon right after a worktree teammate's merge was queued leaves no job running against a closed store", async t => {
  const { tool, stop, logs, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.slug, role: "design", isolation: "worktree" });
  const dir = worktreePath(repo, "design");
  fs.writeFileSync(path.join(dir, "form.md"), "a calmer form\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "calmer form"]);
  const rejections = [];
  const onRej = e => rejections.push(String(e && e.message || e));
  process.on("unhandledRejection", onRej);
  t.after(() => process.off("unhandledRejection", onRej));
  // No wait: the merge request is queued and the integrator's dispatch starts as the ask closes.
  await tool("team.ask", { to: "design", project: project.slug, text: 'vyre team.done {"result":"done","notes":"unchanged","reason":"test"}' });
  await new Promise(r => setTimeout(r, 400));
  await stop();
  await new Promise(r => setTimeout(r, 600)); // anything left running would hit the closed store by now
  assert.deepEqual(rejections.filter(m => /not open/.test(m)), []);
  assert.deepEqual(logs.filter(m => /not open/.test(m)), []);
});

// --- slice A review (e2e and reviewer, 8eb1a785): nothing the repo says to run ------------------
// A teammate writes the shared .git to commit, so it can plant hooks or config naming programs;
// vyred's own git must never run them (they would run as vyred, outside every permission check).

