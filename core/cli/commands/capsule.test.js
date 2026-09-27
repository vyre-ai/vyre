// @ts-check
// `vyre capsule`: the native app is the Capsule. Where it can run, and what the command accepts.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
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
