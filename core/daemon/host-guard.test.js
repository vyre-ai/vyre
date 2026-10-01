// @ts-check
// The guard that keeps test daemons off the person's Mac. Pure: nothing here boots a vyred.

import { test } from "node:test";
import assert from "node:assert/strict";
import { daemonHost, assertDaemonHost, REFUSAL } from "./host-guard.js";

const MAC = { platform: "darwin", hostname: "alex-macbook.local", tmpdir: "/var/folders/xx/T", env: {} };
const TEMP = "/var/folders/xx/T/vt-abc123/vyre-test-1";

test("a test daemon on a Mac is refused, with the words teams see", () => {
  assert.equal(REFUSAL, "daemon tests run on a runner or the test box, not on this Mac");
  for (const env of [{ NODE_TEST_CONTEXT: "child-v8" }, { VYRE_TEST_HOSTED: "1" }, {}]) {
    const r = daemonHost({ ...MAC, root: TEMP, env });
    assert.deepEqual(r, { ok: false, why: REFUSAL }, JSON.stringify(env));
  }
  assert.throws(() => assertDaemonHost({ ...MAC, root: TEMP, env: { NODE_TEST_CONTEXT: "x" } }), e => e.message === REFUSAL && e.code === "test_host");
  // a real-looking root under a test is still a test
  assert.equal(daemonHost({ ...MAC, root: "/Users/alex/proj/home", env: { NODE_TEST_CONTEXT: "x" } }).ok, false);
});

test("a runner, the test box, CI and any other OS are let through", () => {
  const t = { NODE_TEST_CONTEXT: "x" };
  assert.equal(daemonHost({ ...MAC, root: TEMP, env: { ...t, CI: "true" } }).ok, true);
  assert.equal(daemonHost({ ...MAC, root: TEMP, env: { ...t, VYRE_TEST_HOST: "testbox" } }).ok, true);
  assert.equal(daemonHost({ ...MAC, hostname: "runner-x1", root: TEMP, env: t }).ok, true);
  assert.equal(daemonHost({ ...MAC, hostname: "fv-az123-4", root: TEMP, env: t }).ok, true);
  assert.equal(daemonHost({ ...MAC, platform: "linux", root: TEMP, env: t }).ok, true);
  assert.equal(daemonHost({ ...MAC, platform: "win32", root: TEMP, env: t }).ok, true);
  assert.equal(daemonHost({ ...MAC, root: TEMP, env: { ...t, VYRE_TEST_HOST: "my-mac" } }).ok, false, "only testbox");
});

test("a person's own vyred is never touched", () => {
  assert.equal(daemonHost({ ...MAC, root: "/Users/alex/.vyre", real: true, env: { NODE_TEST_CONTEXT: "x" } }).ok, true);
  assert.equal(daemonHost({ ...MAC, root: "/Users/alex/.vyre", env: {} }).ok, true, "a normal home outside the temp folder, no test marker");
  assert.equal(daemonHost({ ...MAC, root: "/Users/alex/vyre-home", env: {} }).ok, true);
});
