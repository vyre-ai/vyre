// @ts-check
// core/team (docs/adr/0031-teammates.md): vyre's own git never runs what a repo says, and the integrator's merge.
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
import { until, boot, git, GIT_ENV, bootGit, realSession, plantHook, commitOnDesign, setTestCommand, recordOf } from "./team-fixture.js";

test("planted hooks never run: not on vyred's worktree add, not on its merge before a dispatch", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  const marker = path.join(root, "hook-ran");
  plantHook(repo, "post-checkout", marker);
  plantHook(repo, "post-merge", marker);
  plantHook(repo, "pre-merge-commit", marker);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  fs.writeFileSync(path.join(project.home, "CHANGES.md"), "later\n");
  git(project.home, ["add", "."]);
  git(project.home, ["commit", "-q", "--no-verify", "-m", "later, on main"]);
  const ask = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"ok","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  assert.ok(fs.existsSync(path.join(worktreePath(repo, "design"), "CHANGES.md")), "the merge itself still happened");
  assert.ok(!fs.existsSync(marker), "no planted hook may run under vyred's own git");
});

test("a filter named in repo config refuses the merge before a dispatch, and never runs", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  const marker = path.join(root, "filter-ran");
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  fs.writeFileSync(path.join(project.home, ".gitattributes"), "* filter=evil\n");
  git(project.home, ["add", "."]);
  git(project.home, ["commit", "-q", "--no-verify", "-m", "attributes"]);
  git(project.home, ["config", "filter.evil.smudge", `touch '${marker}'; cat`]);
  const ask = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"should never run"}' });
  assert.equal(ask.state, "failed");
  assert.match(ask.result, /filter\.evil\.smudge/);
  assert.ok(!fs.existsSync(marker), "the filter must never run");
});

test("isolation: worktree is refused while repo config names a filter or merge driver", async t => {
  const { tool, root, project } = await bootGit(t);
  git(project.home, ["config", "merge.evil.driver", `touch '${path.join(root, "driver-ran")}'`]);
  await assert.rejects(() => tool("team.add", { project: project.record, role: "design", isolation: "worktree" }),
    e => { assert.match(e.message, /merge\.evil\.driver/); return true; });
});

test("a folder already at <repo>-<role> that is not this repo's own worktree is refused, not adopted", async t => {
  const { tool, project, repo } = await bootGit(t);
  const other = worktreePath(repo, "design");
  git(path.dirname(other), ["init", "-q", "-b", "main", path.basename(other)]); // an unrelated repo beside this one
  await assert.rejects(() => tool("team.add", { project: project.record, role: "design", isolation: "worktree" }),
    e => { assert.match(e.message, /not this repo's own team\/design worktree/); return true; });
});

// --- step 4, slice B (2026-09-28): the integrator's own merge, mechanical then, if it must, model-driven

/** A teammate's own request text that produces a real commit on its branch, no conflict with main. */


test("the integrator's own merge is automatic and spends no session, when there is nothing to test", async t => {
  const { tool, root, project, repo, launches } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  await commitOnDesign(repo);
  const ask = await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"done","notes":"unchanged","reason":"test"}' });
  assert.equal(ask.state, "done");
  const integratorAgent = /** @type {any} */ (openStore(paths(root).db).prepare("SELECT agent FROM team_teammates WHERE project = ? AND role = 'integrator'").get(project.record)).agent;
  const merge = await until(async () => {
    const db = openStore(paths(root).db);
    const row = /** @type {any} */ (db.prepare("SELECT * FROM team_requests WHERE teammate = ? ORDER BY created_at DESC LIMIT 1").get(integratorAgent));
    db.close();
    return row && row.state !== "queued" && row.state !== "running" ? row : null;
  }, "the merge to finish");
  assert.equal(merge.state, "done");
  assert.match(merge.result, /^Merged team\/design into main/);
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "merge team/design"); // main really moved
  assert.ok(!launches().some(l => l.agent === integratorAgent), "no session should have been needed");
});

test("vyred's own mechanical merge never runs the project's test command itself, even one planted to prove exactly that (reviewer, slice B, HIGH)", async t => {
  const { tool, root, project, repo, launches } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  const integrator = (await tool("team.list", { project: project.record })).find(r => r.role === "integrator");
  // A real, runnable command that would leave unmistakable evidence if anything ever ran it —
  // exactly the shape a teammate's own package.json scripts.test could be.
  const marker = path.join(root, "test-ran");
  setTestCommand(root, integrator.agent, `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')"`);
  await commitOnDesign(repo);
  await tool("team.ask", { to: "design", project: project.record, wait: true, text: 'vyre team.done {"result":"done","notes":"unchanged","reason":"test"}' });
  const merge = await until(async () => {
    const db = openStore(paths(root).db);
    const row = /** @type {any} */ (db.prepare("SELECT * FROM team_requests WHERE teammate = ? ORDER BY created_at DESC LIMIT 1").get(integrator.agent));
    db.close();
    return row && row.state !== "queued" ? row : null;
  }, "the merge request to be picked up");
  assert.equal(merge.state, "running"); // held for the integrator's own session — vyred does not run the command and finish this itself
  await until(() => launches().some(l => l.agent === integrator.agent), "the integrator's own session should have been started, to run the test itself");
  // The fake driver's default turn (nothing scripted in the wrapped prompt matches "vyre <tool>")
  // does not call team.merge, so nothing here ever attests a passing test either: this asserts
  // vyred's own mechanical path (attemptMerge) specifically, not merely "nobody got around to it".
  await until(async () => (await tool("team.status", { request: merge.id })).state === "failed", "the held turn to end (nothing attested) and auto-fail");
  assert.ok(!fs.existsSync(marker), "vyred itself must never run the project's own test command");
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "first"); // never moved past the original commit
});

test("team.merge finishes the merge once the integrator's own session attests a passing exit code", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  const integrator = (await tool("team.list", { project: project.record })).find(r => r.role === "integrator");
  setTestCommand(root, integrator.agent, "npm test"); // never run by vyred; documentation only here
  await commitOnDesign(repo);
  // A hand-made merge request (not the automatic one queueMergeIfNeeded would send) whose own
  // text scripts the integrator's turn to call team.merge itself, the way it would once it had
  // actually run the test command with its own Bash and seen it pass: attemptMerge's own detail
  // is appended after this by the dispatch, so the line this test cares about is found and run
  // before that detail ever is.
  const range = `${git(repo, ["rev-parse", "--short", "main"]).trim()}..${git(worktreePath(repo, "design"), ["rev-parse", "--short", "team/design"]).trim()}`;
  const ask = await tool("team.ask", { to: "integrator", project: project.record, wait: true,
    text: `merge team/design ${range}, from request r_test\nvyre team.merge {"tests":{"exit_code":0}}` });
  assert.equal(ask.state, "done");
  assert.match(ask.result, /Tests passed \(checked by the integrator/);
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "merge team/design"); // main really moved
});

test("team.merge refuses an attested failing exit code, and never moves main", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  const integrator = (await tool("team.list", { project: project.record })).find(r => r.role === "integrator");
  setTestCommand(root, integrator.agent, "npm test");
  await commitOnDesign(repo);
  const range = `${git(repo, ["rev-parse", "--short", "main"]).trim()}..${git(worktreePath(repo, "design"), ["rev-parse", "--short", "team/design"]).trim()}`;
  const ask = await tool("team.ask", { to: "integrator", project: project.record, wait: true,
    text: `merge team/design ${range}, from request r_test\nvyre team.merge {"tests":{"exit_code":1}}` });
  // team.merge itself throws on refusal rather than closing the request (finish() is never
  // called from inside it), so the result here is the generic auto-fail from onTurnEnded once
  // the turn ends with nothing having actually fixed it — the same shape as the two tests below.
  assert.equal(ask.state, "failed");
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "first");
});

test("team.merge refuses while a test command is set but nothing was reported yet", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  const integrator = (await tool("team.list", { project: project.record })).find(r => r.role === "integrator");
  setTestCommand(root, integrator.agent, "npm test");
  await commitOnDesign(repo);
  const range = `${git(repo, ["rev-parse", "--short", "main"]).trim()}..${git(worktreePath(repo, "design"), ["rev-parse", "--short", "team/design"]).trim()}`;
  const ask = await tool("team.ask", { to: "integrator", project: project.record, wait: true,
    text: `merge team/design ${range}, from request r_test\nvyre team.merge {}` });
  assert.equal(ask.state, "failed"); // team.merge's own refusal: no tests.exit_code given at all
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "first");
});

test("a real merge conflict is left for the integrator, not cleaned up, and team.merge refuses while it remains", async t => {
  const { tool, root, project, repo } = await bootGit(t);
  await tool("team.add", { project: project.record, role: "design", isolation: "worktree" });
  const integrator = (await tool("team.list", { project: project.record })).find(r => r.role === "integrator");
  const dir = worktreePath(repo, "design");
  fs.writeFileSync(path.join(dir, "README.md"), "changed by design\n");
  git(dir, ["commit", "-q", "-am", "design's own change"]);
  fs.writeFileSync(path.join(repo, "README.md"), "changed by main\n");
  git(repo, ["commit", "-q", "-am", "main's own change"]);
  const range = `${git(repo, ["rev-parse", "--short", "main"]).trim()}..${git(dir, ["rev-parse", "--short", "team/design"]).trim()}`;
  const ask = await tool("team.ask", { to: "integrator", project: project.record, wait: true,
    text: `merge team/design ${range}, from request r_test\nvyre team.merge {}` });
  assert.equal(ask.state, "failed"); // team.merge refused: the conflict is still there
  const integratorDir = worktreePath(repo, "integrator");
  const conflicted = git(integratorDir, ["diff", "--name-only", "--diff-filter=U"]).trim();
  assert.equal(conflicted, "README.md", "the conflict must still be there for the integrator to work on, not aborted");
  assert.equal(git(repo, ["log", "--format=%s", "-1", "main"]).trim(), "main's own change"); // never moved
});

// docs/design/teammates.md section 1: the default-policy append and its per-project off switch.

