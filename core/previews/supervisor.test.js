// @ts-check
// A preview's own command runs under shell limits (core files off, file size, processes and open files capped), set before the command and without changing it; a command with several parts still runs whole.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSupervisor, LIMITS } from "./supervisor.js";

test("the command is started through the limits, unchanged after them", () => {
  /** @type {any[]} */ const started = [];
  const spawn = /** @type {any} */ ((cmd, args, opts) => { started.push({ cmd, args, opts }); const h = { stdout: null, stderr: null, on() {}, kill() {}, pid: 1 }; return h; });
  const sup = createSupervisor({ spawn, log: () => {}, now: () => 0, pollMs: 1_000_000, giveUpMs: 1_000_000 });
  sup.start("p1", { command: "cd app && npm run dev", cwd: "/tmp", port: 4100, env: { MODE: "x" } });
  assert.equal(started.length, 1);
  assert.equal(started[0].cmd, "/bin/sh");
  assert.equal(started[0].args[0], "-c");
  assert.ok(started[0].args[1].startsWith(LIMITS), "the limits come first");
  assert.ok(started[0].args[1].endsWith("cd app && npm run dev"), "then the command exactly as written");
  assert.match(LIMITS, /ulimit -c 0/); assert.match(LIMITS, /ulimit -u 1024/); assert.match(LIMITS, /ulimit -n 4096/); assert.match(LIMITS, /ulimit -f /);
  assert.equal(started[0].opts.env.PORT, "4100");
  sup.stop("p1");
});
