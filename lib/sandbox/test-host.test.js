import test from "node:test";
import assert from "node:assert/strict";
import { skipOffRunner, OFF_MAC } from "./test-host.js";

test("on a Mac the guard skips unless this is a GitHub-hosted runner, and CI=1 alone is not enough", () => {
  assert.equal(skipOffRunner({ platform: "darwin", env: {} }), OFF_MAC);
  assert.equal(skipOffRunner({ platform: "darwin", env: { CI: "1" } }), OFF_MAC);
  assert.equal(skipOffRunner({ platform: "darwin", env: { CI: "true", GITHUB_ACTIONS: "false" } }), OFF_MAC);
  assert.equal(skipOffRunner({ platform: "darwin", env: { GITHUB_ACTIONS: "true" } }), false);
});

test("other systems run it", () => {
  assert.equal(skipOffRunner({ platform: "linux", env: {} }), false);
  assert.equal(skipOffRunner({ platform: "win32", env: {} }), false);
});

test("the tests that spawn children or listen use this guard, so none runs on a Mac outside a hosted runner", async () => {
  const fs = await import("node:fs");
  for (const f of ["core/watchers/runtime.test.js", "core/watchers/spawner-wall.test.js", "core/watchers/isolation.test.js", "lib/sandbox/wall.test.js", "core/watchers/module.test.js"]) {
    assert.match(fs.readFileSync(new URL("../../" + f, import.meta.url), "utf8"), /skipOffRunner/, `${f} does not use the host guard`);
  }
});
