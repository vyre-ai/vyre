// @ts-check
// The builder module answers Publish's builder.build for a folder of ready files, and says in plain words what it cannot build.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import builder, { planOf, seam, takeToken } from "./index.js";
import { repoOf, cloneArgs, cloneEnv } from "../../lib/publish/repo-source.js";

const tmp = (/** @type {import("node:test").TestContext} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-builder-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
async function tool(/** @type {import("node:test").TestContext} */ t) {
  const tools = new Map();
  const mod = await builder.start({ tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) });
  t.after(() => mod.stop());
  return (/** @type {any} */ deployment) => tools.get("builder.build").run({ deployment, secretArgs: [] });
}
const dep = (/** @type {any} */ over = {}) => ({ id: "dep_a", source: { kind: "folder", ref: "/nowhere" }, build: { command: "", output_dir: ".", image: "static" }, ...over });

test("a folder of ready files builds: files, digest, a static runtime, and a log that names the folder and what was left out", async t => {
  const d = tmp(t);
  fs.writeFileSync(path.join(d, "index.html"), "<h1>Northwind Bakery</h1>");
  fs.writeFileSync(path.join(d, ".env"), "SECRET=not-in-the-site");
  const build = await tool(t);
  const r = await build(dep({ source: { kind: "folder", ref: d } }));
  assert.deepEqual(r.files.map((/** @type {any} */ f) => f.path), ["index.html"]);
  assert.match(r.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(r.runtime, { kind: "static" });
  assert.match(r.logs, new RegExp(`Read 1 file \\(1 KB\\) from ${path.basename(d)}; left out: \\.env\\.`));
  assert.ok(!r.logs.includes(d), "the log names the folder, not its path on the disk");
});

test("what it cannot build is refused in words that name what is missing, never skipped", async t => {
  const build = await tool(t);
  for (const [why, deployment, words] of /** @type {[string, any, RegExp][]} */ ([
    ["a repo that is not on GitHub", dep({ source: { kind: "repo", ref: "https://git.example.test/x.git#main" } }), /only GitHub repos are cloned/],
    ["a Drive folder", dep({ source: { kind: "drive", ref: "abc" } }), /container builder/],
    ["a build command with servers off", dep({ source: { kind: "folder", ref: "/x" }, build: { command: "npm run build", output_dir: "dist", image: "static" } }), /turned off in this test release/],
    ["a node image with servers off", dep({ source: { kind: "folder", ref: "/x" }, build: { command: "", output_dir: ".", image: "node-22" } }), /turned off in this test release/],
  ])) await assert.rejects(() => build(deployment), (/** @type {any} */ e) => { assert.equal(e.code, "refused", why); assert.match(e.message, words, why); return true; });
  assert.deepEqual(planOf({ source: { kind: "folder", ref: "/x" }, build: {} }), { dir: "/x", outputDir: ".", dockerfile: false }, "no command and no image asks for the folder as it is");
});

test("a folder that is missing or empty answers with the folder reader's own words", async t => {
  const build = await tool(t), d = tmp(t);
  await assert.rejects(() => build(dep({ source: { kind: "folder", ref: path.join(d, "gone") } })), { code: "not_found", message: /not there/ });
  await assert.rejects(() => build(dep({ source: { kind: "folder", ref: d } })), { message: /no files to publish/ });
});

test("publishing an app with its own server is switched off in the test release (setting publish.servers, off by default): a Dockerfile build is refused in words, a folder of ready files still publishes, and the setting turns it on", () => {
  assert.throws(() => planOf({ source: { kind: "folder", ref: "/x" }, build: { image: "dockerfile" } }), /Publishing apps with their own server is turned off in this test release/);
  assert.throws(() => planOf({ source: { kind: "folder", ref: "/x" }, build: { image: "dockerfile" } }, { servers: false }), /turned off/);
  assert.deepEqual(planOf({ source: { kind: "folder", ref: "/x" }, build: {} }), { dir: "/x", outputDir: ".", dockerfile: false }, "a folder of ready files is untouched");
  assert.equal(planOf({ source: { kind: "folder", ref: "/x" }, build: { image: "static" } }).dockerfile, false);
  assert.equal(planOf({ source: { kind: "folder", ref: "/x" }, build: { image: "dockerfile" } }, { servers: true }).dockerfile, true, "the setting turns it on");
});

test("a public GitHub repo is cloned, built like a folder, and its clone is removed; a repo that cannot be cloned is refused in words", async t => {
  /** @type {any[]} */ const cloned = [];
  seam.clone = async (url, branch, dir) => { cloned.push({ url, branch, dir }); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "index.html"), "<h1>From the repo</h1>"); fs.mkdirSync(path.join(dir, ".git")); fs.writeFileSync(path.join(dir, ".git", "config"), "x"); };
  t.after(() => { seam.clone = null; });
  const build = await tool(t);
  const r = await build(dep({ source: { kind: "repo", ref: "northwind/site#release" } }));
  assert.deepEqual(r.files.map((/** @type {any} */ f) => f.path), ["index.html"], ".git is not in the site");
  assert.deepEqual([cloned[0].url, cloned[0].branch], ["https://github.com/northwind/site.git", "release"]);
  assert.ok(!fs.existsSync(path.dirname(cloned[0].dir)), "the clone is removed after the build");
  assert.match(r.logs, /from site/);
  seam.clone = async () => { throw Object.assign(new Error("could not get the repo: the repo is not there, or it is private (only public repos are cloned for now)"), { code: "refused" }); };
  await assert.rejects(() => build(dep({ source: { kind: "repo", ref: "northwind/private" } })), /private/);
});

test("which repos may be named, and the clone's git arguments: https GitHub only, shallow, no hooks, no prompt", () => {
  assert.deepEqual(repoOf("a-b/c.d"), { ok: true, url: "https://github.com/a-b/c.d.git", branch: null, owner: "a-b", name: "c.d" });
  assert.equal(/** @type {any} */ (repoOf("https://github.com/o/n.git#feat/x")).branch, "feat/x");
  for (const bad of ["", "o", "o/n/extra", "http://github.com/o/n", "https://evil.test/o/n", "file:///etc", "o/n#--upload-pack=x", "o/n#a/../b", "../x/y", "o/.."]) assert.equal(repoOf(bad).ok, false, bad);
  const a = cloneArgs("https://github.com/o/n.git", "main", "/tmp/x");
  assert.deepEqual(a.slice(-3), ["--", "https://github.com/o/n.git", "/tmp/x"]);
  for (const want of ["core.hooksPath=/dev/null", "protocol.allow=never", "--depth", "--single-branch"]) assert.ok(a.includes(want), want);
});

test("a clone past the size limit is refused and removed", async t => {
  /** @type {string} */ let where = "";
  seam.clone = async (_u, _b, dir) => { where = dir; fs.mkdirSync(dir, { recursive: true }); const fd = fs.openSync(path.join(dir, "big.bin"), "w"); fs.ftruncateSync(fd, 301 * 1024 * 1024); fs.closeSync(fd); };
  t.after(() => { seam.clone = null; });
  const build = await tool(t);
  await assert.rejects(() => build(dep({ source: { kind: "repo", ref: "northwind/huge" } })), /more than 300 MB/);
  assert.ok(!fs.existsSync(where) && !fs.existsSync(path.dirname(where)), "nothing is left on the disk");
});

test("a private repo: the granted GitHub token is read for the clone only, rides in git's environment, and is not in an argument, a file or what the image build is given", async t => {
  const TOKEN = "github_pat_" + "A1b2C3d4E5".repeat(4);
  const dir = tmp(t);
  const secretFile = path.join(dir, "GITHUB_TOKEN");
  fs.writeFileSync(secretFile, TOKEN + "\n", { mode: 0o400 });
  /** @type {any[]} */ const cloned = [];
  seam.clone = async (url, branch, to, token) => { cloned.push({ url, token }); fs.mkdirSync(to, { recursive: true }); fs.writeFileSync(path.join(to, "index.html"), "<h1>private</h1>"); };
  t.after(() => { seam.clone = null; });
  const tools = new Map();
  const mod = await builder.start({ tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) });
  t.after(() => mod.stop());
  const run = (/** @type {string[]} */ secretArgs) => tools.get("builder.build").run({ deployment: dep({ source: { kind: "repo", ref: "northwind/private" } }), secretArgs });
  const r = await run(["--secret", `id=GITHUB_TOKEN,src=${secretFile}`]);
  assert.deepEqual([cloned[0].url, cloned[0].token], ["https://github.com/northwind/private.git", TOKEN]);
  assert.ok(!JSON.stringify(r).includes(TOKEN), "the token is in no file and no log of the build");
  // without the grant, the clone is asked with no token
  await run([]);
  assert.equal(cloned[1].token, null);
  // the token never goes on to the image build, and a token that is not one is refused before anything is cloned
  assert.deepEqual(takeToken(["--secret", `id=GITHUB_TOKEN,src=${secretFile}`, "--secret", "id=OTHER,src=/x"]), { token: TOKEN, rest: ["--secret", "id=OTHER,src=/x"] });
  fs.writeFileSync(secretFile, "not a token!");
  await assert.rejects(() => run(["--secret", `id=GITHUB_TOKEN,src=${secretFile}`]), /not a GitHub token/);
  assert.equal(cloned.length, 2, "nothing was cloned for it");
  // git gets the token in its environment as one header for github.com, never in the arguments
  const env = cloneEnv(TOKEN);
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraheader");
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString("base64")}`);
  assert.ok(!cloneArgs("https://github.com/o/n.git", null, "/tmp/x").join(" ").includes(TOKEN));
  assert.equal(cloneEnv().GIT_CONFIG_COUNT, undefined, "no token, no header");
  assert.throws(() => cloneEnv("short"), /not a GitHub token/);
});
