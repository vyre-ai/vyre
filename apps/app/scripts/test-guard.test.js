import "./test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-guard.mjs", import.meta.url));

test("the guard lets a Linux box or a hosted runner through and refuses a bare Mac", () => {
  const run = (/** @type {Record<string,string>} */ env) => spawnSync(process.execPath, ["-e", `Object.defineProperty(process,"platform",{value:"darwin"});import(${JSON.stringify(guard)})`], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  assert.equal(run({}).status, 1);
  assert.match(run({}).stderr, /Refusing to run tests on a Mac/);
  assert.equal(run({ VYRE_TEST_HOSTED: "1" }).status, 0);
  assert.equal(run({ GITHUB_ACTIONS: "true" }).status, 0);
});
