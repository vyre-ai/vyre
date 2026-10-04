// @ts-check
// The search model's library is installed on first use, not by npm i -g. These run a fake npm
// that writes a fake library, so nothing is downloaded.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempHome } from "../../test/helpers.js";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { writeTranscripts } from "../../test/fixtures/corpus.js";
import { install, installed, load, PACKAGE, RANGE, DIM } from "./embed.js";
import { fakeNpm } from "./testing.js";

const calls = dir => fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");

test("embed: load installs the library into the runtime folder on first use, then never again", async t => {
  const home = tempHome(t);
  const runtime = path.join(home, "embedder");
  const npm = fakeNpm(home);
  assert.equal(installed(runtime), false);
  const r = await load({ cacheDir: path.join(home, "models"), runtime, npm });
  assert.ok(r.embedder, r.why);
  assert.equal((await r.embedder.embed("hello")).length, DIM);
  assert.equal(installed(runtime), true);
  assert.deepEqual(calls(home).length, 1);
  assert.match(calls(home)[0], new RegExp(`^install .*${PACKAGE}@${RANGE.replace(/\./g, "\\.")}$`));
  assert.ok(fs.existsSync(path.join(runtime, "package.json")), "the folder is its own npm project");
  // Only this platform's native library is kept.
  const bin = path.join(runtime, "node_modules", "onnxruntime-node", "bin", "napi-v6");
  assert.deepEqual(fs.readdirSync(bin), [process.platform]);
  assert.deepEqual(fs.readdirSync(path.join(bin, process.platform)), [process.arch]);
  assert.deepEqual(fs.readdirSync(path.join(bin, process.platform, process.arch)).sort(), ["libonnxruntime.so.1", "libonnxruntime_providers_shared.so"], "no GPU providers");
  assert.deepEqual(fs.readdirSync(path.join(runtime, "node_modules", "onnxruntime-web", "dist")), ["ort.node.min.js"], "only the node entry, no WebAssembly or source maps");
  const again = await load({ cacheDir: path.join(home, "models"), runtime, npm });
  assert.ok(again.embedder);
  assert.equal(calls(home).length, 1, "a second load reuses the install");
});

test("embed: with download off, a missing library is keyword search, and nothing is installed", async t => {
  const home = tempHome(t);
  const runtime = path.join(home, "embedder");
  const npm = fakeNpm(home);
  const r = await load({ cacheDir: path.join(home, "models"), runtime, npm, download: false });
  // A dev checkout may have the library in node_modules; then it loads from there instead.
  if (!r.embedder) assert.match(String(r.why), /by keyword/);
  assert.equal(fs.existsSync(path.join(home, "calls")), false, "npm never ran");
});

test("embed: a failed install says why, leaves no half-installed tree, and can be tried again", async t => {
  const home = tempHome(t);
  const runtime = path.join(home, "embedder");
  const bad = await install(runtime, { npm: fakeNpm(home, { fail: true }) });
  assert.match(String(bad.why), /did not download \(npm error network ETIMEDOUT\)/);
  assert.equal(fs.existsSync(path.join(runtime, "node_modules")), false);
  const good = await install(runtime, { npm: fakeNpm(home) });
  assert.equal(good.why, undefined);
  assert.equal(installed(runtime), true);
});

test("embed: two installs at once into one folder run npm once", async t => {
  const home = tempHome(t);
  const runtime = path.join(home, "embedder");
  const npm = fakeNpm(home);
  const [a, b] = await Promise.all([install(runtime, { npm }), install(runtime, { npm })]);
  assert.deepEqual([a.why, b.why], [undefined, undefined]);
  assert.equal(calls(home).length, 1);
});

test("embed: recall.setup installs through a real vyred, says so in status, then vectors fill in", async t => {
  const root = tempHome(t);
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir);
  const npm = fakeNpm(root, { fail: true });
  // `models` named, so the module's test guard lets the (fake) model load.
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0, models: path.join(root, "models"), npm } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  const failed = (await call("recall.setup", {}, { root })).data;
  assert.equal(failed.ready, false);
  assert.match(failed.why, /did not download.*by keyword/);
  const st = (await call("recall.status", {}, { root })).data.vectors;
  assert.deepEqual([st.on, st.ready], [false, false]);
  // The network came back: setup tries again rather than remembering the failure.
  fakeNpm(root);
  const ok = (await call("recall.setup", {}, { root })).data;
  assert.deepEqual([ok.ready, ok.model], [true, "Xenova/all-MiniLM-L6-v2"]);
  assert.ok(installed(path.join(root, "embedder")), "installed under the home");
  const deadline = Date.now() + 10_000;
  let v;
  do { v = (await call("recall.status", {}, { root })).data.vectors; } while (v.pending && Date.now() < deadline && await new Promise(r => setTimeout(r, 50, true)));
  assert.equal(v.ready, true);
  assert.equal(v.pending, 0, "every turn got a vector");
});
