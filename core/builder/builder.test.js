// @ts-check
// The builder module answers Publish's builder.build for a folder of ready files, and says in plain words what it cannot build.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import builder, { planOf } from "./index.js";

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
    ["a repo", dep({ source: { kind: "repo", ref: "https://git.example.test/x.git#main" } }), /container builder, which is not installed/],
    ["a Drive folder", dep({ source: { kind: "drive", ref: "abc" } }), /container builder/],
    ["a build command", dep({ source: { kind: "folder", ref: "/x" }, build: { command: "npm run build", output_dir: "dist", image: "static" } }), /build command \(npm run build\) needs the container builder/],
    ["a node image", dep({ source: { kind: "folder", ref: "/x" }, build: { command: "", output_dir: ".", image: "node-22" } }), /node-22 image needs the container builder/],
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
