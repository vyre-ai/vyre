// @ts-check
// LIVE, opt-in only: the one test in this module that touches the real network and clones a real
// repo, proving github.project and github.project.add-repo end to end - the actual clone step
// (gitWithAskpass over real https to real github.com) is otherwise untested, since it can't be
// faked: git-safe's protocol.allow=never correctly refuses a local file:// stand-in (git.test.js
// proves that refusal), so index.test.js's own github.project/.add-repo tests only ever cover the
// validation that runs before a clone is attempted.
//
// Off by default; set VYRE_LIVE_GITHUB=1 to run it, on testbox only, never on the Mac (RULES.md:
// no git network experiments on the Mac). No real GitHub credential anywhere - a dummy, made-up
// account row and a dummy, non-empty token value the whole way through:
// - github.repos/GitHub's repo-metadata read (getRepo, index.js) retries once with no credential
//   at all when a token 401s, so a placeholder token doesn't stop it reading a PUBLIC repo (the
//   fix this live test drove - a broken/placeholder token used to 401 outright, even though the
//   same request with no Authorization header at all succeeds for a public repo).
// - The actual clone (gitWithAskpass) still needs a non-empty string (it errors on an empty one,
//   by design - a real call always has a real token), so the dummy token is a random, obviously
//   fake string. It should never actually reach askpass at all for a public repo: git only asks
//   for credentials when the server first answers 401, and GitHub serves a public repo's
//   git-http endpoints anonymously.
// octocat/Hello-World is GitHub's own tiny public demo repo (two files, no history to speak of),
// chosen so a real clone costs nothing meaningful in a testbox run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import github from "./index.js";
import { store as accountStore } from "./accounts.js";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";

const RUN = process.env.VYRE_LIVE_GITHUB === "1";
const REPO = "octocat/Hello-World";
const DUMMY_TOKEN = "not-a-real-github-token-just-a-placeholder-000111";

/** Same shape as index.test.js's world(), inlined to keep this file's dependency on real network self-contained and easy to skip-compile-away. `failCreate`/`failAddWorkspace` inject a failure AFTER a real clone has already happened, to prove the orphan-clone cleanup. */
async function world(t, { failCreate = false, failAddWorkspace = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const tools = new Map(), events = [], calls = [];
  const rows = [];
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-live-projdir-"));
  t.after(() => fs.rmSync(projectsDir, { recursive: true, force: true }));
  const ctx = {
    config: { projectsDir },
    store: { db, migrate: steps => { for (const s of steps) db.exec(s); } },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }) },
    vault: { fetch: async () => DUMMY_TOKEN },
    tool: (name, def) => tools.set(name, def),
    call: async (toolName, input) => {
      calls.push({ tool: toolName, input });
      if (toolName === "projects.list") return { data: { projects: rows } };
      if (toolName === "projects.add-workspace") {
        if (failAddWorkspace) return { error: { code: "boom", message: "injected failure, after a real clone" } };
        const p = rows.find(x => x.slug === input.project);
        if (p) p.workspaces = [...p.workspaces, input.folder];
        return { data: { slug: input.project } };
      }
      if (toolName === "projects.create") {
        if (failCreate) return { error: { code: "boom", message: "injected failure, after a real clone" } };
        rows.push({ slug: input.name, name: input.name, home: input.home, workspaces: [] });
        return { data: { slug: input.name } };
      }
      return { error: { code: "no_such_tool", message: `no fake for ${toolName}` } };
    },
  };
  const mod = await github.start(ctx);
  t.after(() => mod.stop());
  const as = caller => async (name, input = {}) => {
    const def = tools.get(name);
    if (!def) return { error: { code: "no_such_tool" } };
    if (def.callers && !def.callers.some(c => caller === c || caller.startsWith(c + ":"))) return { error: { code: "denied" } };
    try { return { data: await def.run(input, { caller }) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {any} */ (e).message } }; }
  };
  return { db, events, calls, as, ctx };
}

/** No `credential.helper` was left configured on the clone - the actual proof gitWithAskpass's `-c credential.helper=` did its job, not just that nothing crashed. */
function hasNoCredentialHelper(dir) {
  try {
    execFileSync("git", ["-C", dir, "config", "--get", "credential.helper"], { stdio: "pipe" });
    return false; // a value came back: something set one
  } catch {
    return true; // `git config --get` exits non-zero when the key is unset - the expected case
  }
}

test(`LIVE (real network, testbox only): github.project and .add-repo really clone ${REPO}`, { skip: RUN ? false : "set VYRE_LIVE_GITHUB=1 to run this on testbox (real network, no real token)" }, async t => {
  const w = await world(t);
  accountStore(w.db).put({ name: "dummy", login: "dummy", avatar_url: null, item: "github-dummy" }, Date.now());

  // 1. github.project: resolves the repo (getRepo's anonymous-retry makes this work with a
  //    placeholder token), clones it for real, makes a new project, records the primary repo.
  //    from_thread rides straight through to projects.create untouched - github.project doesn't
  //    validate it itself (projects.create/native-core does); this only proves it's passed.
  const FROM_THREAD = "11111111-1111-4111-8111-111111111111";
  const created = await w.as("cli")("github.project", { repo: REPO, from_thread: FROM_THREAD });
  assert.equal(created.error, undefined, `github.project failed: ${JSON.stringify(created)}`);
  assert.equal(created.data.full_name, REPO);
  assert.ok(fs.existsSync(path.join(created.data.home, ".git")), "a real clone exists at .home");
  assert.ok(fs.existsSync(path.join(created.data.home, "README")) || fs.existsSync(path.join(created.data.home, "README.md")), "the clone has real file content, not an empty shell");
  assert.ok(hasNoCredentialHelper(created.data.home), "no credential helper got configured on the clone");
  const createCall = w.calls.find(c => c.tool === "projects.create");
  assert.equal(createCall.input.from_thread, FROM_THREAD, "from_thread reached projects.create");
  // DUMMY_TOKEN is not a real GitHub credential, so the real API 401s it for real, and the
  // anonymous-fallback fix must still flag it (team-lead/reviewer, 119ef290 review, LOW): the
  // fallback succeeding for a public repo must never quietly hide a broken token.
  assert.ok(w.events.some(e => e.type === "github.token-invalid" && e.payload.name === "dummy"), "the placeholder token is flagged as broken, not silently accepted");

  const of = await w.as("cli")("github.project.of", { project: created.data.project });
  assert.equal(of.data.full_name, REPO, "the primary-repo row was recorded");

  // 2. github.project.add-repo: a second, independent clone of the same public repo, registered
  //    as a workspace of the project github.project just made - proves add-repo's own clone path
  //    (not just that github.project's works) and that it never touches the first folder.
  const added = await w.as("cli")("github.project.add-repo", { project: created.data.project, repo: REPO, folder: "hello-world-again" });
  assert.equal(added.error, undefined, `github.project.add-repo failed: ${JSON.stringify(added)}`);
  assert.notEqual(added.data.folder, created.data.home, "a brand-new folder, not the primary repo's");
  assert.ok(fs.existsSync(path.join(added.data.folder, ".git")), "add-repo's clone is real too");
  assert.ok(hasNoCredentialHelper(added.data.folder));
  // add-repo never sets the primary repo: github.project.of still answers with the first clone.
  assert.equal((await w.as("cli")("github.project.of", { project: created.data.project })).data.full_name, REPO);

  // 3. github.project.detect: sees BOTH real clones as real GitHub repos, correctly parsed -
  //    but `match` is null for both: the only connected account's token is the same real-broken
  //    DUMMY_TOKEN, and accountFor never credits a broken token with reaching anything, even a
  //    public repo it could read anonymously (the LOW this same live test drove the fix for).
  //    Proving a real, working match end to end needs a real GitHub token, which this file never
  //    has; index.test.js's fakes already prove the match-when-working branch on its own.
  const detected = await w.as("cli")("github.project.detect", { project: created.data.project });
  assert.equal(detected.error, undefined, JSON.stringify(detected));
  assert.equal(detected.data.workspaces.length, 2);
  for (const ws of detected.data.workspaces) {
    assert.equal(ws.isRepo, true, ws.folder);
    assert.equal(ws.remotes.length, 1, ws.folder);
    assert.equal(ws.remotes[0].full_name, REPO, ws.folder);
    assert.equal(ws.remotes[0].match, null, `a broken token must never be credited: ${JSON.stringify(ws.remotes[0])}`);
  }
  // detect's own token-invalid emissions (one per remote checked) land on top of github.project's
  // one from earlier - at least one is enough to prove the flag, not an exact count.
  assert.ok(w.events.filter(e => e.type === "github.token-invalid").length >= 1);
});

test(`LIVE (real network, testbox only): a projects.create/.add-workspace failure after a real clone removes the orphan folder, never leaves it behind (reviewer's LOW on 9cf93817)`, { skip: RUN ? false : "set VYRE_LIVE_GITHUB=1 to run this on testbox (real network, no real token)" }, async t => {
  const wCreate = await world(t, { failCreate: true });
  accountStore(wCreate.db).put({ name: "dummy", login: "dummy", avatar_url: null, item: "github-dummy" }, Date.now());
  const projectsDirBefore = fs.readdirSync(wCreate.ctx.config.projectsDir);
  const failed = await wCreate.as("cli")("github.project", { repo: REPO });
  assert.equal(failed.error && failed.error.code, "boom", "the injected failure is what actually surfaced, proving the clone really ran first");
  const projectsDirAfter = fs.readdirSync(wCreate.ctx.config.projectsDir);
  assert.deepEqual(projectsDirAfter, projectsDirBefore, "no orphan folder left behind after projects.create failed");

  // Same proof for add-repo/.add-workspace, against a project that already exists.
  const wAdd = await world(t, { failAddWorkspace: true });
  accountStore(wAdd.db).put({ name: "dummy", login: "dummy", avatar_url: null, item: "github-dummy" }, Date.now());
  const created = await wAdd.as("cli")("github.project", { repo: REPO });
  assert.equal(created.error, undefined, `setup clone failed: ${JSON.stringify(created)}`);
  const projectsDirBefore2 = fs.readdirSync(wAdd.ctx.config.projectsDir);
  const failedAdd = await wAdd.as("cli")("github.project.add-repo", { project: created.data.project, repo: REPO, folder: "second-clone" });
  assert.equal(failedAdd.error && failedAdd.error.code, "boom");
  const projectsDirAfter2 = fs.readdirSync(wAdd.ctx.config.projectsDir);
  assert.deepEqual(projectsDirAfter2, projectsDirBefore2, "no orphan folder left behind after projects.add-workspace failed");
});
