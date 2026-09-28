// @ts-check
// The github module's tools wired up for real: its own table, its own git.js against real local
// repos on disk (readOrigin/remoteAdd/remoteUrl are local-only, never network), and a small fake
// for `projects` (ctx.call) and GitHub's REST API (global fetch, restored after each test - no
// real network, ever). Device flow itself (connect.js) is exercised in connect.test.js; this file
// seeds an account directly into the module's own table, the way an earlier github.connect would
// have left it, and focuses on github.repos' paging and the project.detect/.link/.unlink flow
// (ADR 0041, added for "link an existing project to a repo").

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

/** A minimal module context: real sqlite table, a fake `projects`, tokens in a plain map (never fetched over the wire in a test). */
async function world(t, { projectsRows = [], tokens = {} } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const tools = new Map(), events = [], calls = [];
  const ctx = {
    config: { projectsDir: fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-projdir-")) },
    store: { db, migrate: steps => { for (const s of steps) db.exec(s); } },
    log: () => {},
    events: { emit: (type, payload) => events.push({ type, payload }) },
    vault: { fetch: async name => (tokens[name] !== undefined ? tokens[name] : "test-token") },
    tool: (name, def) => tools.set(name, def),
    call: async (toolName, input) => {
      calls.push({ tool: toolName, input });
      if (toolName === "projects.list") return { data: { projects: projectsRows } };
      if (toolName === "projects.add-workspace") return { data: { slug: input.project } };
      if (toolName === "projects.create") return { data: { slug: input.name } };
      return { error: { code: "no_such_tool", message: `no fake for ${toolName}` } };
    },
  };
  const mod = await github.start(ctx);
  t.after(() => mod.stop());
  const as = (caller) => async (name, input = {}) => {
    const def = tools.get(name);
    if (!def) return { error: { code: "no_such_tool" } };
    if (def.callers && !def.callers.some(c => caller === c || caller.startsWith(c + ":"))) return { error: { code: "denied" } };
    if (def.internal && !caller.startsWith("module:")) return { error: { code: "no_such_tool" } };
    try { return { data: await def.run(input, { caller }) }; } catch (e) { return { error: { code: /** @type {any} */ (e).code, message: /** @type {any} */ (e).message } }; }
  };
  return { db, events, calls, as, ctx };
}

/** Seed an account row directly, the way a prior github.connect would have left it. */
function seedAccount(db, { name = "home", login = "alex", item = `github-${name}` } = {}) {
  accountStore(db).put({ name, login, avatar_url: null, item }, Date.now());
  return { name, login, item };
}

/** A fake `fetch` standing in for the GitHub REST API: /user/repos (paged) and /repos/:full_name. */
function fakeFetch({ repos = [], reachable = new Set(repos.map(r => r.full_name)) } = {}) {
  return async (url) => {
    const u = new URL(String(url));
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
});

test("github.project.detect: no folder is isRepo:false; a matching origin finds the account; a foreign origin finds nothing", async t => {
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home: makeRepo(t) }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal" }] }));

  const bare = await w.as("cli")("github.project.detect", { project: "harlow" });
  assert.deepEqual(bare.data, { linked: false, isRepo: true, origin: null, full_name: null, match: null });

  const matched = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home: makeRepo(t, "https://github.com/alex/harlow-legal.git") }] });
  seedAccount(matched.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal" }] }));
  const found = await matched.as("cli")("github.project.detect", { project: "harlow" });
  assert.deepEqual(found.data, { linked: false, isRepo: true, origin: "https://github.com/alex/harlow-legal.git", full_name: "alex/harlow-legal", match: { account: "home", full_name: "alex/harlow-legal", default_branch: "main" } });

  const foreign = await world(t, { projectsRows: [{ slug: "other", name: "Other", home: makeRepo(t, "https://gitlab.com/alex/somewhere.git") }] });
  seedAccount(foreign.db);
  withFetch(t, fakeFetch({ repos: [] }));
  const noMatch = await foreign.as("cli")("github.project.detect", { project: "other" });
  assert.deepEqual(noMatch.data, { linked: false, isRepo: true, origin: "https://gitlab.com/alex/somewhere.git", full_name: null, match: null });
});

test("github.project.link: an already-matching origin is just recorded, no confirm needed and nothing on disk changes", async t => {
  const home = makeRepo(t, "https://github.com/alex/harlow-legal.git");
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));

  const r = await w.as("cli")("github.project.link", { project: "harlow", repo: "alex/harlow-legal" });
  assert.deepEqual(r.data, { linked: true, recorded: true, matched: "origin", full_name: "alex/harlow-legal", default_branch: "main", home });
  assert.ok(w.events.some(e => e.type === "github.project.linked"));
  // recorded for real, readable back through github.project.of
  const of = await w.as("cli")("github.project.of", { project: "harlow" });
  assert.equal(of.data.full_name, "alex/harlow-legal");
});

test("github.project.link: a different or missing origin proposes adding a \"github\" remote and changes nothing until confirm: true", async t => {
  const home = makeRepo(t); // no origin at all
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));

  const proposed = await w.as("cli")("github.project.link", { project: "harlow", repo: "alex/harlow-legal" });
  assert.equal(proposed.data.linked, false);
  assert.equal(proposed.data.action, "add-remote");
  assert.equal(proposed.data.remote, "github");
  assert.equal(proposed.data.origin, null);
  // nothing on disk changed: still no remotes at all
  assert.equal(execFileSync("git", ["-C", home, "remote"], { encoding: "utf8" }).trim(), "");

  const confirmed = await w.as("cli")("github.project.link", { project: "harlow", repo: "alex/harlow-legal", confirm: true });
  assert.equal(confirmed.data.linked, true);
  assert.equal(confirmed.data.matched, "added-remote");
  const remoteCheck = execFileSync("git", ["-C", home, "remote", "get-url", "github"], { encoding: "utf8" }).trim();
  assert.equal(remoteCheck, "https://github.com/alex/harlow-legal.git");
});

test("github.project.link: never overwrites an existing \"github\" remote that points somewhere else", async t => {
  const home = makeRepo(t);
  plainGit(home, ["remote", "add", "github", "https://github.com/someone-else/other.git"]);
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));

  const r = await w.as("cli")("github.project.link", { project: "harlow", repo: "alex/harlow-legal", confirm: true });
  assert.equal(r.error.code, "remote_exists");
  const stillThere = execFileSync("git", ["-C", home, "remote", "get-url", "github"], { encoding: "utf8" }).trim();
  assert.equal(stillThere, "https://github.com/someone-else/other.git", "the existing remote is untouched");
});

test("github.project.link: a folder that isn't a git repo at all proposes no action", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-gh-notrepo-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const w = await world(t, { projectsRows: [{ slug: "plain", name: "Plain", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));

  const r = await w.as("cli")("github.project.link", { project: "plain", repo: "alex/harlow-legal" });
  assert.equal(r.data.linked, false);
  assert.equal(r.data.action, "none");
  assert.equal(r.data.reason, "not_a_repo");
});

test("github.project.unlink: forgets the link and never touches git; a person-only tool refuses a module caller", async t => {
  const home = makeRepo(t, "https://github.com/alex/harlow-legal.git");
  const w = await world(t, { projectsRows: [{ slug: "harlow", name: "Harlow", home }] });
  seedAccount(w.db);
  withFetch(t, fakeFetch({ repos: [{ full_name: "alex/harlow-legal", default_branch: "main" }] }));
  await w.as("cli")("github.project.link", { project: "harlow", repo: "alex/harlow-legal" });

  const denied = await w.as("module:sessions")("github.project.link", { project: "harlow", repo: "alex/harlow-legal" });
  assert.equal(denied.error.code, "denied");
  const deniedUnlink = await w.as("module:sessions")("github.project.unlink", { project: "harlow" });
  assert.equal(deniedUnlink.error.code, "denied");

  const r = await w.as("cli")("github.project.unlink", { project: "harlow" });
  assert.deepEqual(r.data, { unlinked: true, was: { full_name: "alex/harlow-legal", home } });
  const of = await w.as("cli")("github.project.of", { project: "harlow" });
  assert.equal(of.data, null);
  // the remote from an earlier confirm (none was added here, since origin already matched) and
  // the origin itself are both still exactly as they were - unlink is a bookkeeping-only op.
  const originStill = execFileSync("git", ["-C", home, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  assert.equal(originStill, "https://github.com/alex/harlow-legal.git");
});
