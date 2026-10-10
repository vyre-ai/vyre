// @ts-check
// Contract test for team/contracts/builder.md (v2, the container path): what builder.build answers for a Dockerfile folder is exactly what appmods.publish.install takes and what Publish's plan names; the
// tools are declared with the reach the contract says; nothing about the static path moved.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import builder, { seam } from "../../core/builder/index.js";
import { publishedManifest, checkPublished } from "../../core/appmods/published.js";
import { normalizeDraft } from "../../lib/publish/deployment.js";
// the Dockerfile path is switched off in the test release unless this is set (core/builder/index.js planOf); these tests are about that path
process.env.VYRE_PUBLISH_SERVERS = "1";

const manifest = (/** @type {string} */ rel) => JSON.parse(fs.readFileSync(new URL(`../../core/${rel}/module.json`, import.meta.url), "utf8"));
const IMG = "sha256:" + "e".repeat(64);

test("builder v2: a Dockerfile folder builds to { digest, files: [], logs, runtime: image } and that runtime is what a published server is made from", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-contract-"));
  t.after(() => { seam.buildImage = null; fs.rmSync(dir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM node:22-alpine\nEXPOSE 3000\n"); fs.writeFileSync(path.join(dir, "app.js"), "x");
  seam.buildImage = async () => ({ image: IMG, logs: "ok" });
  const tools = new Map();
  await builder.start({ config: {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) });
  const draft = normalizeDraft({ name: "northwind", source: { kind: "folder", ref: dir }, build: { image: "dockerfile" } });
  const out = await tools.get("builder.build").run({ deployment: { id: "dep_0123456789abcdef", ...draft }, secretArgs: [] });
  assert.deepEqual(Object.keys(out).sort(), ["digest", "files", "logs", "runtime"]);
  assert.deepEqual(out.files, []);
  assert.match(out.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(out.runtime, { kind: "image", image: IMG, port: 3000, health: { path: "/", ok: [200, 301, 302, 401, 403, 404] } });
  const m = publishedManifest({ id: "dep_0123456789abcdef", name: "northwind", version: 1, runtime: out.runtime, secrets: [] }, { catalogNames: [], public: true });
  assert.deepEqual(checkPublished(m), []);
  assert.deepEqual([m.app.image, m.app.port], [IMG, 3000]);
});

test("builder v2: the tools are Publish's alone (module callers) and the draft vocabulary is the contract's", () => {
  const b = manifest("builder").does.tools.find((/** @type {any} */ x) => x.name === "builder.build");
  assert.equal(b.reach, "modules");
  const a = manifest("appmods").does.tools.filter((/** @type {any} */ x) => /^appmods\.publish\./.test(x.name));
  assert.deepEqual(a.map((/** @type {any} */ x) => x.name).sort(), ["appmods.publish.install", "appmods.publish.remove", "appmods.publish.stop"]);
  assert.ok(a.every((/** @type {any} */ x) => x.reach === "modules"), "no person, no model reaches them");
  assert.equal(normalizeDraft({ name: "a1", source: { kind: "folder", ref: "/x" }, build: { image: "dockerfile", port: 80 } }).build.port, 80);
  assert.throws(() => normalizeDraft({ name: "a1", source: { kind: "folder", ref: "/x" }, build: { image: "dockerfile", command: "make" } }));
});

test("builder v2: the static path is as v1 said", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-contract-s-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<p>hi</p>");
  const tools = new Map();
  await builder.start({ config: {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d) });
  const out = await tools.get("builder.build").run({ deployment: { id: "dep_a", source: { kind: "folder", ref: dir }, build: { command: "", output_dir: ".", image: "static" } }, secretArgs: [] });
  assert.deepEqual(out.runtime, { kind: "static" });
  assert.deepEqual(out.files.map((/** @type {any} */ f) => f.path), ["index.html"]);
});
