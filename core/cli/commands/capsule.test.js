// @ts-check
// `vyre capsule`: the native app is the Capsule. Where it can run, and what the command accepts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tempHome } from "../../../test/helpers.js";
import capsule, { nativeAvailable, NATIVE } from "./capsule.js";

test("nativeAvailable: a Mac with the native source runs it; vyre up counts it as installed", () => {
  const has = fs.existsSync(path.join(NATIVE, "build.sh"));
  assert.equal(nativeAvailable({ platform: "darwin" }), has);
  assert.equal(nativeAvailable({ platform: "linux" }), false);
  assert.equal(nativeAvailable({ platform: "darwin", dir: "/nonexistent" }), false);
});

test("capsule: the usage names only the native app's commands", () => {
  assert.equal(capsule.usage, "vyre capsule [--hidden] | install");
  assert.doesNotMatch(capsule.usage, /electron|--dev|--app/i);
});

test("capsule install: builds here and downloads nothing; off a Mac it says the Capsule runs on macOS", { skip: process.platform === "darwin" }, t => {
  const root = tempHome(t);
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "bin", "vyre");
  const r = spawnSync(process.execPath, [bin, "capsule", "install"], { encoding: "utf8", env: { ...process.env, VYRE_HOME: root, VYRE_DOWNLOAD_BASE: "http://127.0.0.1:9/never" } });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /The Capsule runs on macOS/);
  assert.doesNotMatch(r.stdout + r.stderr, /Vyre-mac\.zip|download/i);
  assert.doesNotMatch(fs.readFileSync(new URL("./capsule.js", import.meta.url), "utf8"), /Vyre-mac\.zip|capsule-install\.js/);
});
