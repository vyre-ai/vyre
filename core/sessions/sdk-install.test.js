// @ts-check
// Installing the Agent SDK on first use (core/sessions/sdk.js): only in the person's own home, and
// an install in flight ends with vyred, leaving nothing half written.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { install, autoInstallAllowed, abortInstalls } from "./sdk.js";
import { realHome } from "../config/dialogs.js";
import { SCRATCH } from "../../test/scratch.mjs";

test("sdk: vyred installs the SDK on its own only in ~/.vyre, never under a test or in a temp home", () => {
  const temp = path.join(os.tmpdir(), "vy-sdk");
  assert.equal(autoInstallAllowed(realHome(), {}), true);
  assert.equal(autoInstallAllowed(temp, {}), false, "a temp or dev home");
  assert.equal(autoInstallAllowed(realHome(), { NODE_TEST_CONTEXT: "child" }), false, "node --test");
  assert.equal(autoInstallAllowed(realHome(), { NODE_ENV: "test" }), false, "NODE_ENV=test");
  assert.equal(autoInstallAllowed(temp, { VYRE_SESSIONS_SDK_INSTALL: "1" }), true, "asked for");
});

test("sdk: an install in flight ends when vyred stops, with its children, and leaves no node_modules", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-sdk-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A stand-in npm that starts writing node_modules and a cache, keeps a child of its own, and
  // would go on for a minute.
  const npm = path.join(dir, "fake-npm");
  const cache = path.join(dir, "cache");
  fs.writeFileSync(npm, `#!/bin/sh
mkdir -p node_modules/@anthropic-ai "${cache}"
( while true; do date >> "${cache}/child.log"; sleep 0.1; done ) &
while true; do date >> "${cache}/npm.log"; sleep 0.1; done
`, { mode: 0o755 });
  const target = path.join(dir, "sdk");
  const p = install(target, { npm, timeout: 60_000 });
  // Wait for it to be writing.
  for (let i = 0; i < 50 && !fs.existsSync(path.join(cache, "child.log")); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(fs.existsSync(path.join(cache, "child.log")), "the fake install started");
  await abortInstalls();
  const r = await p;
  assert.match(String(r.why), /did not install/);
  assert.ok(!fs.existsSync(path.join(target, "node_modules")), "nothing half installed is left");
  const size = f => fs.statSync(path.join(cache, f)).size;
  const before = [size("npm.log"), size("child.log")];
  await new Promise(r2 => setTimeout(r2, 500));
  assert.deepEqual([size("npm.log"), size("child.log")], before, "nothing writes after the stop, npm's own children included");
});

test("sdk: the box image reads the pin from one file copied alone, as box/Dockerfile does", async t => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const docker = fs.readFileSync(path.join(here, "../../box/Dockerfile"), "utf8");
  const copy = docker.match(/^COPY (core\/sessions\/\S+) \/tmp\/vyre-sdk\.mjs$/m);
  assert.ok(copy, "box/Dockerfile copies the pin to /tmp/vyre-sdk.mjs");
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-sdk-pin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const alone = path.join(dir, "vyre-sdk.mjs");
  fs.copyFileSync(path.join(here, "../..", copy[1]), alone);
  const pin = await import(alone);
  const sdk = await import("./sdk.js");
  assert.equal(`${pin.PACKAGE}@${pin.VERSION}`, `${sdk.PACKAGE}@${sdk.VERSION}`);
});
