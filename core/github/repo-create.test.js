// @ts-check
// R032-06, the GitHub part: a connected account makes a new repo for a folder (its own, or an organisation's; private unless public is asked) and the folder goes there as the first commit. GitHub's REST
// API is a stand-in on global fetch, the remote is a bare repo on disk behind the push base, and the token only ever reaches git through its askpass channel. No network.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import github, { seam } from "./index.js";
import { store as accountStore } from "./accounts.js";
import { createRepo, ownersOf, REPO_NAME } from "./repo-create.js";

// built at run time so no scanner mistakes a fixture for a real token
const TOKEN = ["gh", "o_", "fixturetoken0123456789abcdefghijkl"].join("");
const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull } });
const tmp = (/** @type {import("node:test").TestContext} */ t, /** @type {string} */ what) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `vyre-gh-${what}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

/** GitHub's stand-in: orgs, repo creation (a bare repo appears on disk under `remotes`), and the answers a real one gives for a taken name or a stranger's org. */
function fakeGitHub(t, remotes, o = {}) {
  const made = /** @type {any[]} */ ([]), real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ (async (url, init = {}) => {
    const u = new URL(String(url)), method = String(init.method || "GET");
    const json = (/** @type {number} */ status, /** @type {any} */ body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init.headers && String(init.headers.authorization) !== `Bearer ${TOKEN}`) return json(401, {});
    if (u.pathname === "/user/orgs") return json(200, (o.orgs || ["harlow-legal"]).map((/** @type {string} */ login) => ({ login })));
    const m = /^\/(?:user|orgs\/([^/]+))\/repos$/.exec(u.pathname);
    if (m && method === "POST") {
      const owner = m[1] || "alex", body = JSON.parse(init.body);
      if (m[1] && !(o.orgs || ["harlow-legal"]).includes(m[1])) return json(404, {});
      if (made.some(r => r.full_name === `${owner}/${body.name}`) || body.name === "taken") return json(422, {});
      fs.mkdirSync(path.join(remotes, owner), { recursive: true });
      git(remotes, ["init", "-q", "--bare", "-b", "main", path.join(remotes, owner, `${body.name}.git`)]);
      const r = { full_name: `${owner}/${body.name}`, name: body.name, owner: { login: owner }, private: body.private, html_url: `https://github.com/${owner}/${body.name}`, clone_url: `https://github.com/${owner}/${body.name}.git` };
      made.push({ ...r, body });
      return json(201, r);
    }
    throw new Error(`fake github: unexpected ${method} ${u.pathname}`);
  });
  t.after(() => { globalThis.fetch = real; });
  return made;
}

async function world(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const root = tmp(t, "home"), remotes = tmp(t, "remotes");
  // git here speaks https only (lib/git-safe.js, covered by git.test.js); this world sends over a plain local push to the bare repo the stand-in made, so the tool's own steps are what is tested
  seam.push = async ({ dir, branch, fullName }) => { git(dir, ["push", "-q", path.join(remotes, `${fullName}.git`), `refs/heads/${branch}:refs/heads/${branch}`]); return { pushed: true, branch, commit: git(dir, ["rev-parse", branch]).trim() }; };
  t.after(() => { seam.push = null; });
  const tools = new Map(), events = /** @type {any[]} */ ([]);
  const ctx = { config: {}, paths: { root }, store: { db, migrate: (/** @type {string[]} */ s) => { for (const x of s) db.exec(x); } }, log() {}, events: { emit: (/** @type {string} */ type, /** @type {any} */ payload) => events.push({ type, payload }) },
    vault: { fetch: async () => TOKEN }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({ data: {} }) };
  const mod = await github.start(ctx);
  t.after(() => mod.stop());
  accountStore(db).put({ name: "home", login: "alex", avatar_url: null, item: "github-home" }, Date.now());
  const as = (/** @type {string} */ caller, firstParty = true) => async (/** @type {string} */ name, input = {}) => {
    const def = tools.get(name);
    if (def.callers && !def.callers.some((/** @type {string} */ c) => caller === c || caller.startsWith(c + ":"))) return { error: { code: "denied" } };
    try { return { data: await def.run(input, { caller, firstParty }) }; } catch (e) { const x = /** @type {any} */ (e); return { error: { code: x.code, message: x.message } }; }
  };
  const folder = (/** @type {Record<string, string>} */ files) => { const d = path.join(root, "sites", `f${Math.random().toString(36).slice(2, 8)}`); for (const [n, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true }); fs.writeFileSync(path.join(d, n), c); } return d; };
  return { tools, events, as, root, remotes, folder, ctx };
}

test("names and owners are checked before anything is asked of GitHub", async () => {
  assert.ok(REPO_NAME.test("northwind-bakery") && REPO_NAME.test("a.b_c"));
  for (const bad of ["", ".", "..", "a b", "a/b", "x".repeat(101)]) assert.equal(REPO_NAME.test(bad), false, JSON.stringify(bad));
  await assert.rejects(() => createRepo({ token: TOKEN, login: "alex", name: "ok", visibility: /** @type {any} */ ("secret") }), { code: "bad_input" });
  await assert.rejects(() => createRepo({ token: TOKEN, login: "alex", owner: "../user", name: "ok" }), { code: "bad_input" });
});

test("the owners are the account and its organisations", async t => {
  fakeGitHub(t, tmp(t, "r"));
  assert.deepEqual(await ownersOf({ token: TOKEN, login: "alex" }), [{ login: "alex", kind: "user" }, { login: "harlow-legal", kind: "org" }]);
});

test("github.repo.create: a private repo under the account, the folder goes as the first commit, a secret-looking file stays out, and the answer carries no token", async t => {
  const w = await world(t), made = fakeGitHub(t, w.remotes);
  const dir = w.folder({ "index.html": "<h1>Northwind Bakery</h1>", "css/site.css": "body{margin:0}", ".env": "STRIPE_KEY=not-in-the-repo-0123456789" });
  const r = await w.as("cli")("github.repo.create", { name: "northwind-bakery", dir });
  assert.ok(r.data, JSON.stringify(r));
  assert.deepEqual([r.data.full_name, r.data.visibility, r.data.branch, r.data.url], ["alex/northwind-bakery", "private", "main", "https://github.com/alex/northwind-bakery"]);
  assert.equal(made[0].body.private, true, "private unless public is asked");
  assert.ok(!JSON.stringify(r).includes(TOKEN), "no token in the answer");
  const remote = path.join(w.remotes, "alex", "northwind-bakery.git");
  assert.equal(git(remote, ["rev-parse", "main"]).trim(), r.data.commit);
  assert.deepEqual(git(remote, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n").sort(), ["css/site.css", "index.html"], "the .env stayed out");
  assert.ok(r.data.left_out.includes(".env"));
  assert.deepEqual(w.events.map(e => e.type), ["github.repo-created"]);
  assert.deepEqual(w.events[0].payload, { account: "home", full_name: "alex/northwind-bakery", visibility: "private" });
});

test("public when asked, under an organisation the account belongs to; one it does not belong to, and a taken name, say what to do", async t => {
  const w = await world(t), made = fakeGitHub(t, w.remotes);
  const run = (/** @type {any} */ i) => w.as("cli")("github.repo.create", i);
  const dir = w.folder({ "index.html": "<p>hi</p>" });
  const r = await run({ name: "site", owner: "harlow-legal", visibility: "public", dir });
  assert.deepEqual([r.data.full_name, r.data.visibility], ["harlow-legal/site", "public"]);
  assert.equal(made[0].body.private, false);
  assert.match((await run({ name: "site", owner: "someone-else", dir: w.folder({ "a.txt": "x" }) })).error.message, /not an organisation this account belongs to/);
  const taken = await run({ name: "taken", dir: w.folder({ "a.txt": "x" }) });
  assert.equal(taken.error.code, "conflict");
  assert.match(taken.error.message, /pick another/);
});

test("a secret in the folder stops it before anything is made on GitHub", async t => {
  const w = await world(t), made = fakeGitHub(t, w.remotes);
  const dir = w.folder({ "index.html": "<p>hi</p>", "config.js": 'const key = "' + ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("") + '";' });
  const r = await w.as("cli")("github.repo.create", { name: "leaky", dir });
  assert.equal(r.error.code, "secret_found");
  assert.match(r.error.message, /nothing was made on GitHub/);
  assert.equal(made.length, 0, "no repo exists for it");
});

test("only a person, or the Publish module acting inside Vyre's home, makes a repo; a model and a stranger's module do not", async t => {
  const w = await world(t);
  fakeGitHub(t, w.remotes);
  const dir = w.folder({ "index.html": "<p>hi</p>" });
  for (const who of ["mcp", "harness", "module:notes"]) assert.equal((await w.as(who, who.startsWith("module:"))("github.repo.create", { name: "x1", dir })).error.code, "denied", who);
  assert.equal((await w.as("module:publish")("github.repo.create", { name: "from-publish", dir })).data.full_name, "alex/from-publish");
  const outside = tmp(t, "outside"); fs.writeFileSync(path.join(outside, "a.txt"), "x");
  assert.match((await w.as("module:publish")("github.repo.create", { name: "elsewhere", dir: outside })).error.message, /only a folder kept under Vyre's home/);
  assert.equal((await w.as("module:publish")("github.owners", {})).error.code, "denied", "the owner list is the person's");
});
