// @ts-check
// The native Capsule's own tests (local/capsule/native/Tests), compiled with swiftc and run here
// so `npm test` covers them. Skipped where there is no swiftc: they need macOS.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const swift = process.platform === "darwin" && spawnSync("sh", ["-c", "command -v swiftc"]).status === 0;

test("native Capsule: Swift tests pass", { skip: !swift && "needs macOS and swiftc", timeout: 600_000 }, () => {
  const r = spawnSync("nice", ["-n", "10", path.join(HERE, "native", "build.sh"), "test"], { encoding: "utf8" });
  assert.equal(r.status, 0, (r.stdout || "") + (r.stderr || ""));
  assert.match(r.stdout, /0 failed/);
});
