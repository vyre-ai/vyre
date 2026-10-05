// @ts-check
// Shared fixtures for core/team's tests (team.test.js, team-worktree.test.js, team-merge.test.js): a vyred in a temp home on the fake claude, a git project, a real bound session.
// The one file was split in three so each stays well inside the per-file time limit on a loaded box; no assertion changed.


import "../../scripts/mac-test-guard.mjs";
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

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "switchboard", "testing", "fake-claude.js");
fs.chmodSync(FAKE, 0o755);

export const until = async (fn, what, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
};

/** A vyred in a temp home, on the fake claude, with a project already made. */
export async function boot(t) {
  const root = tempHome(t);
  const log = path.join(root, "claude.log");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG };
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_LOG: log });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // projectsDir must live under root: its default (~/Vyre/projects) is the user's real home,
  // never a temp one (RULES: temp homes only).
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", sessions: { install: false }, projectsDir: path.join(root, "projects") }));
  const logs = [];
  const d = await start({ root, presence: present, log: m => logs.push(String(m)) });
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  t.after(stop);
  const tool = async (name, input, caller = "cli", extra = {}) => {
    const r = await call(name, input, { root, caller, timeout: 20_000, ...extra });
    if (r.error) throw Object.assign(new Error(r.error.message || r.error.code), { code: r.error.code });
    return r.data;
  };
  const project = await tool("projects.create", { name: "Harlow Legal" });
  const raw = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  const launches = () => { try { return fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  return { root, d, stop, logs, tool, raw, project, launches };
}

export const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.com" };
export const git = (dir, args) => execFileSync("git", args, { cwd: dir, env: GIT_ENV, stdio: "pipe" }).toString();

/**
 * A project whose home is a real, local-only git repo on "main", one commit in. `repo` is the
 * repo root the way git.js itself resolves it (`git rev-parse --show-toplevel`), which can differ
 * in literal spelling from `project.home` under a symlinked temp dir (macOS's /var, say) — team's
 * own worktree paths are always built from this, so tests must use the same one to check them.
 */
export async function bootGit(t) {
  const b = await boot(t);
  git(b.project.home, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(b.project.home, "README.md"), "Harlow Legal\n");
  git(b.project.home, ["add", "."]);
  git(b.project.home, ["commit", "-q", "-m", "first"]);
  const repo = /** @type {string} */ (await repoRoot(b.project.home));
  return { ...b, repo };
}

/**
 * A real (non-agent) thread in a project, bound the way a session's own SessionStart hook binds
 * it: threads.bind with the fake claude child's own pid, which is how a plain project session
 * (not a teammate) is meant to reach team.* — the summon path step 3 is about. Returns headers
 * (`session`) for daemon/client.js's call()/request(), so team.* sees meta.thread, never a label.
 */
export async function realSession(root, tool, launches, project, name = "a real session") {
  const started = await tool("threads.start", { project, name, prompt: "hello there" });
  const launch = await until(() => launches().find(l => l.argv.includes(started.id)), "the session's own launch to log");
  const bound = await tool("threads.bind", { session: started.id, pid: launch.pid }, "harness");
  return { thread: started.id, session: { id: started.id, key: bound.key } };
}

export const plantHook = (repo, name, marker) => {
  const f = path.join(repo, ".git", "hooks", name);
  fs.writeFileSync(f, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(f, 0o755);
};


export async function commitOnDesign(repo, name = "form.md", text = "a calmer form\n") {
  const dir = worktreePath(repo, "design");
  fs.writeFileSync(path.join(dir, name), text);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", name]);
}

export const setTestCommand = (root, agent, command) => {
  const db = openStore(paths(root).db);
  db.prepare("UPDATE team_teammates SET test_command = ? WHERE agent = ?").run(command, agent);
  db.close();
};
