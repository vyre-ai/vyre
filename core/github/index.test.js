// @ts-check
// The github module's tools wired up for real: its own table, its own git.js against real local
// repos on disk (listRemotes/folderGitState/remoteUrl are local-only, never network), and a small
// fake for `projects` (ctx.call) and GitHub's REST API (global fetch, restored after each test -
// no real network, ever). Device flow itself (connect.js) is exercised in connect.test.js; this
// file seeds an account directly into the module's own table, the way an earlier github.connect
// would have left it, and focuses on github.repos' paging, github.project.detect (per workspace)
// and github.project.add-repo (ADR 0041: there is no explicit "link" - a project's repos are
// either its primary one, set once by github.project, or added workspaces via add-repo; detect
// only ever reads what's already on disk).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import github from "./index.js";
import { store as accountStore } from "./accounts.js";

const plainGit = (dir, args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });

/** A folder that is a real git repo with one commit on `main`, optionally with an `origin`. */
function makeRepo(t, origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-idx-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  plainGit(dir, ["init", "-q", "-b", "main"]);
  plainGit(dir, ["config", "user.email", "a@example.com"]);
  plainGit(dir, ["config", "user.name", "a"]);
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n");
  plainGit(dir, ["add", "README.md"]);
  plainGit(dir, ["commit", "-q", "-m", "first"]);
  if (origin) plainGit(dir, ["remote", "add", "origin", origin]);
  return dir;
}

/**
 * A minimal module context: real sqlite table, a fake `projects` (stateful - `projects.create`
 * and `.add-workspace` actually update the rows a later `projects.list` sees, since detect and
 * add-repo both round-trip through it), tokens in a plain map (never fetched over the wire in a
 * test; a name with no entry gets a fixed placeholder token, never used for real credentials).
 */
async function world(t, { projectsRows = [], tokens = {}, projectsDir } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const tools = new Map(), events = [], calls = [];
  const rows = projectsRows.map(r => ({ workspaces: [], ...r }));
  const ctx = {
    config: { projectsDir: projectsDir || fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-projdir-")) },
    store: { db, migrate: steps => { for (const s of steps) db.exec(s); } },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }) },
    vault: { fetch: async name => (tokens[name] !== undefined ? tokens[name] : "test-token") },
    tool: (name, def) => tools.set(name, def),
    call: async (toolName, input) => {
      calls.push({ tool: toolName, input });
      if (toolName === "projects.list") return { data: { projects: rows } };
      if (toolName === "projects.add-workspace") {
        const p = rows.find(x => x.slug === input.project);
        if (p) p.workspaces = [...p.workspaces, input.folder];
        return { data: { slug: input.project } };
      }
      if (toolName === "projects.create") {
        const slug = input.name;
        rows.push({ slug, name: input.name, home: input.home, workspaces: [] });
        return { data: { slug } };
      }
      return { error: { code: "no_such_tool", message: `no fake for ${toolName}` } };
    },
  };
  const mod = await github.start(ctx);
  t.after(() => mod.stop());
  const as = (caller, { firstParty = false } = {}) => async (name, input = {}) => {
    const def = tools.get(name);
    if (!def) return { error: { code: "no_such_tool" } };
    if (def.callers && !def.callers.some(c => caller === c || caller.startsWith(c + ":"))) return { error: { code: "denied" } };
    if (def.internal && !caller.startsWith("module:")) return { error: { code: "no_such_tool" } };
    try { return { data: await def.run(input, { caller, firstParty }) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {any} */ (e).message } }; }
  };
  return { db, events, calls, as, ctx };
}

/** Seed an account row directly, the way a prior github.connect would have left it. */
function seedAccount(db, { name = "home", login = "alex", item = `github-${name}` } = {}) {
  accountStore(db).put({ name, login, avatar_url: null, item }, Date.now());
  return { name, login, item };
}

/**
 * A fake `fetch` standing in for the GitHub REST API: /user/repos (paged) and /repos/:full_name.
 * `brokenToken`, when given, makes a credentialed request using exactly that token 401 (GitHub's
 * own "bad credentials" behavior), the same as connect.test.js's fakes model one specific failure
 * mode rather than a whole server. An anonymous request (no Authorization header at all) still
 * succeeds for anything in `reachable`, matching real GitHub serving a public repo's metadata
 * with no credential required.
 */
function fakeFetch({ repos = [], reachable = new Set(repos.map(r => r.full_name)), brokenToken = null } = {}) {
  return async (url, opts) => {
    const u = new URL(String(url));
    const auth = opts && opts.headers && opts.headers.authorization;
    if (u.pathname === "/user/repos") {
      const page = Number(u.searchParams.get("page")) || 1;
      const perPage = Number(u.searchParams.get("per_page")) || 30;
      const start = (page - 1) * perPage;
      const slice = repos.slice(start, start + perPage);
      return { ok: true, status: 200, json: async () => slice.map(r => ({ full_name: r.full_name, name: r.full_name.split("/")[1], owner: { login: r.full_name.split("/")[0] }, private: Boolean(r.private), default_branch: r.default_branch || "main", description: r.description || null, updated_at: r.updated_at || "2026-01-01T00:00:00Z", html_url: `https://github.com/${r.full_name}`, clone_url: `https://github.com/${r.full_name}.git` })) };
    }
    const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const full_name = `${m[1]}/${m[2]}`;
      if (brokenToken && auth === `Bearer ${brokenToken}`) return { ok: false, status: 401, json: async () => ({ message: "Bad credentials" }) };
      if (!reachable.has(full_name)) return { ok: false, status: 404, json: async () => ({}) };
      const r = repos.find(x => x.full_name === full_name) || { full_name, default_branch: "main" };
      return { ok: true, status: 200, json: async () => ({ full_name: r.full_name, name: full_name.split("/")[1], default_branch: r.default_branch || "main", clone_url: `https://github.com/${full_name}.git`, html_url: `https://github.com/${full_name}`, private: Boolean(r.private) }) };
    }
    throw new Error(`fake github: unexpected url ${url}`);
  };
}

/** Swap global fetch for the duration of one test, restored after - no real network, ever. */
function withFetch(t, fake) {
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (fake);
  t.after(() => { globalThis.fetch = real; });
}

test("github.repos: pages without q using GitHub's own paging, and paginates in-memory matches when q is given", async t => {
  const repos = Array.from({ length: 5 }, (_, i) => ({ full_name: `alex/repo-${i}`, description: i === 2 ? "the harlow intake tool" : null }));
  withFetch(t, fakeFetch({ repos }));
  const w = await world(t);
  seedAccount(w.db);

  const page1 = await w.as("cli")("github.repos", { limit: 2, page: 1 });
  assert.equal(page1.data.repos.length, 2);
  assert.deepEqual(page1.data.repos.map(r => r.full_name), ["alex/repo-0", "alex/repo-1"]);
  assert.equal(page1.data.more, true);

  const page3 = await w.as("cli")("github.repos", { limit: 2, page: 3 });
  assert.deepEqual(page3.data.repos.map(r => r.full_name), ["alex/repo-4"]);
  assert.equal(page3.data.more, false);

  const searched = await w.as("cli")("github.repos", { q: "harlow", limit: 10 });
  assert.deepEqual(searched.data.repos.map(r => r.full_name), ["alex/repo-2"]);

  const denied = await w.as("module:someone-else")("github.repos", {});
  assert.equal(denied.error.code, "denied");

  // github.repos names module:threads - but a module claiming that name isn't enough on its own
  // (reviewer's LOW: a module's name is self-declared in its own manifest, never proof of where
  // its code actually lives). Without the registry's own firstParty flag, it's refused exactly
  // like an unnamed module; with it, it's let through.
  const notFirstParty = await w.as("module:threads")("github.repos", {});
  assert.equal(notFirstParty.error.code, "denied", "a module named threads that the registry didn't mark first-party is still refused");
  const firstParty = await w.as("module:threads", { firstParty: true })("github.repos", {});
  assert.equal(firstParty.error, undefined, JSON.stringify(firstParty));
});

test("github.project.detect: per workspace - a bare folder, a folder with no matching account, and a folder whose remote matches one", async t => {
  const home1 = makeRepo(t);
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home: home1 }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal" }] }));

  const bare = await w.as("cli")("github.project.detect", { project: "harlow" });
  assert.deepEqual(bare.data, { project: "harlow", workspaces: [{ folder: home1, isRepo: true, remotes: [] }] });

  const home2 = makeRepo(t, "https://github.com/alex/harlow-legal.git");
  const matched = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home: home2 }] });
  seedAccount(matched.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));
  const found = await matched.as("cli")("github.project.detect", { project: "harlow" });
  assert.deepEqual(found.data, { project: "harlow", workspaces: [{ folder: home2, isRepo: true,
    remotes: [{ name: "origin", url: "https://github.com/alex/harlow-legal.git", full_name: "alex/harlow-legal",
      match: { account: "home", full_name: "alex/harlow-legal", default_branch: "main" } }] }] });

  const home3 = makeRepo(t, "https://gitlab.com/alex/somewhere.git");
  const foreign = await world(t, { projectsRows: [{ slug: "other", name: "Other", home: home3 }] });
  seedAccount(foreign.db);
  withFetch(t, fakeFetch({ repos: [] }));
  const noMatch = await foreign.as("cli")("github.project.detect", { project: "other" });
  assert.deepEqual(noMatch.data, { project: "other", workspaces: [{ folder: home3, isRepo: true,
    remotes: [{ name: "origin", url: "https://gitlab.com/alex/somewhere.git", full_name: null, match: null }] }] });
});

test("github.project.detect: covers every workspace a project owns, not just its home, and a folder that isn't a git repo says so", async t => {
  const home = makeRepo(t, "https://github.com/alex/harlow-legal.git");
  const workspace = makeRepo(t, "https://github.com/alex/harlow-docs.git");
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-idx-plain-"));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home, workspaces: [workspace, plain] }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }, { full_name: "alex/harlow-docs", default_branch: "main" }] }));

  const r = await w.as("cli")("github.project.detect", { project: "harlow" });
  assert.equal(r.data.workspaces.length, 3);
  assert.deepEqual(r.data.workspaces.map(x => [x.folder, x.isRepo]), [[home, true], [workspace, true], [plain, false]]);
  assert.equal(r.data.workspaces[0].remotes[0].match.full_name, "alex/harlow-legal");
  assert.equal(r.data.workspaces[1].remotes[0].match.full_name, "alex/harlow-docs");
  assert.deepEqual(r.data.workspaces[2].remotes, []);
});

test("github.project.detect: a remote cloned with a credential embedded in the URL never sends that credential back out (reviewer's MEDIUM on e5a612c0)", async t => {
  const SECRET = "ghp_reallysecrettoken0000000000";
  const home = makeRepo(t, `https://x-access-token:${SECRET}@github.com/alex/harlow-legal.git`);
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));

  const r = await w.as("cli")("github.project.detect", { project: "harlow" });
  const url = r.data.workspaces[0].remotes[0].url;
  assert.equal(url, "https://github.com/alex/harlow-legal.git");
  assert.ok(!url.includes(SECRET), "the token never appears in the returned url");
  assert.ok(!JSON.stringify(r.data).includes(SECRET), "the token never appears anywhere in the response");
  // full_name/match still resolve correctly - sanitizing the displayed url doesn't break parsing
  assert.equal(r.data.workspaces[0].remotes[0].full_name, "alex/harlow-legal");
  assert.equal(r.data.workspaces[0].remotes[0].match.full_name, "alex/harlow-legal");
});

test("github.project.detect: a broken token never gets credited as able to reach a repo, even one that's public and readable anonymously - and it's flagged, not silently swallowed (reviewer's LOW on 119ef290)", async t => {
  const BROKEN = "gho_thisisdeadorrevoked000000000";
  const home = makeRepo(t, "https://github.com/alex/harlow-legal.git");
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }], tokens: { "github-home": BROKEN } });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }], brokenToken: BROKEN }));

  const r = await w.as("cli")("github.project.detect", { project: "harlow" });
  assert.equal(r.data.workspaces[0].remotes[0].full_name, "alex/harlow-legal", "the repo is real and public");
  assert.equal(r.data.workspaces[0].remotes[0].match, null, "but the only connected account's broken token is never credited with reaching it");
  assert.ok(w.events.some(e => e.type === "github.token-invalid" && e.payload.name === "home"), "the broken token is flagged, not swallowed");
});

test("github.project: a repo a broken token can't see even anonymously (private, or genuinely gone) fails with token_invalid and a clear \"reconnect\" message - never the vague refusal a real not-found gets - and still flags the account", async t => {
  const BROKEN = "gho_thisisdeadorrevoked000000000";
  const w = await world(t, { tokens: { "github-home": BROKEN } });
  seedAccount(w.db);
  // reachable: [] - nothing is readable anonymously either, standing in for a private repo (or
  // one truly gone); brokenToken makes the credentialed attempt 401 regardless.
  withFetch(t, fakeFetch({ repos: [], reachable: new Set(), brokenToken: BROKEN }));

  const r = await w.as("cli")("github.project", { repo: "alex/private-repo" });
  assert.equal(r.error.code, "token_invalid");
  assert.match(r.error.message, /reconnect/i);
  assert.ok(w.events.some(e => e.type === "github.token-invalid" && e.payload.name === "home"));
});

test("github.project.add-repo: the project check still runs first (not_found), but once past it a broken token that can't see the repo even anonymously is token_invalid too", async t => {
  const BROKEN = "gho_thisisdeadorrevoked000000000";
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home: "/tmp/vyre-gh-doesnt-need-to-exist" }], tokens: { "github-home": BROKEN } });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [], reachable: new Set(), brokenToken: BROKEN }));

  const noProject = await w.as("cli")("github.project.add-repo", { project: "nope", repo: "alex/private-repo" });
  assert.equal(noProject.error.code, "not_found", "the project check runs before the repo is ever resolved");

  const r = await w.as("cli")("github.project.add-repo", { project: "harlow", repo: "alex/private-repo" });
  assert.equal(r.error.code, "token_invalid");
  assert.ok(w.events.some(e => e.type === "github.token-invalid" && e.payload.name === "home"));
});

// A public repo still resolving despite a broken token (the anonymous fallback actually working,
// end to end through a real clone) is proven live, not here - see index.live.test.js, which
// already runs with a placeholder token throughout and now also checks github.token-invalid
// fires for it.

// The actual clone step (cloneRepo/gitWithAskpass) needs a real https-reachable git server -
// git-safe.js's own protocol.allow=never blocks a local file:// stand-in on purpose (git.test.js
// proves exactly that refusal), so github.project and .add-repo's happy paths (a real successful
// clone) aren't exercised here, the same as github.project always was: only the validation that
// runs before a clone is ever attempted is testable without real network, which is what these
// prove.

test("github.project.add-repo: validates before ever cloning - no such project, a repo the account can't see, and a module caller are all refused", async t => {
  const home = makeRepo(t);
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-docs", default_branch: "main" }] }));

  const noProject = await w.as("cli")("github.project.add-repo", { project: "nope", repo: "alex/harlow-docs" });
  assert.equal(noProject.error.code, "not_found");
  assert.equal(w.calls.some(c => c.tool === "projects.add-workspace"), false, "never got as far as cloning or registering a workspace");

  const noRepo = await w.as("cli")("github.project.add-repo", { project: "harlow", repo: "alex/does-not-exist" });
  assert.equal(noRepo.error.code, "refused");

  // person-only: a module caller is refused, before any of the above even runs
  const denied = await w.as("module:sessions")("github.project.add-repo", { project: "harlow", repo: "alex/harlow-docs" });
  assert.equal(denied.error.code, "denied");

  // add-repo never touches the project's existing folder while failing
  assert.equal(execFileSync("git", ["-C", home, "remote"], { encoding: "utf8" }).trim(), "");
});

test("github.project: narrowed to making a brand-new project - no project param anymore; a repo the account can't see is refused before any clone", async t => {
  const w = await world(t);
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [] }));

  const r = await w.as("cli")("github.project", { repo: "alex/does-not-exist" });
  assert.equal(r.error.code, "refused");
  assert.equal(w.calls.some(c => c.tool === "projects.create"), false, "never got as far as creating a project");
});

test("github.project: repoName refuses a path-traversal owner or a bare '.'/'..' name before ever touching the GitHub API (reviewer's LOW on e5a612c0)", async t => {
  const w = await world(t);
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [] })); // any real fetch call here would be the bug

  const traversal = await w.as("cli")("github.project", { repo: "../user/harlow-legal" });
  assert.equal(traversal.error.code, "bad_input");
  const dotName = await w.as("cli")("github.project", { repo: "alex/.." });
  assert.equal(dotName.error.code, "bad_input");
  assert.equal(w.calls.length, 0, "repoName's own validation runs before any tool call at all");
});
