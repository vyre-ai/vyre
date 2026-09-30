// @ts-check
// An error nothing caught takes vyred down loudly: the stack is logged and the exit is non-zero,
// so the supervisor restarts it. It is never swallowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";
import { installCrashHandler } from "./crash.js";

const CRASH = path.join(path.dirname(fileURLToPath(import.meta.url)), "crash.js");

for (const [name, body] of [
  ["an uncaught exception", `setTimeout(() => { throw new Error("boom-sync"); }, 10);`],
  ["an unhandled rejection", `Promise.reject(new Error("boom-async"));`],
  ["a thrown non-error", `setTimeout(() => { throw "just a string"; }, 10);`],
]) {
  test(`crash: ${name} logs the stack and exits non-zero`, () => {
    const src = `import { installCrashHandler } from ${JSON.stringify(CRASH)}; installCrashHandler({ flushMs: 20 }); ${body} setTimeout(() => process.exit(0), 5000);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", src], { encoding: "utf8", timeout: 15_000 });
    assert.notEqual(r.status, 0, "exited non-zero, not swallowed");
    assert.notEqual(r.status, null, "exited on its own");
    assert.match(r.stderr, /vyred: (uncaughtException|unhandledRejection): /);
    if (/sync|async/.test(body)) assert.match(r.stderr, /boom-(sync|async)[\s\S]*\n\s+at /, "the stack is in the log");
    else assert.match(r.stderr, /just a string/);
  });
}

test("crash: a second error while dying is not logged twice, and the handlers come off", async () => {
  const proc = /** @type {any} */ (new EventEmitter());
  const logs = [], exits = [];
  const off = installCrashHandler({ proc, log: s => logs.push(s), exit: c => exits.push(c), flushMs: 10 });
  proc.emit("uncaughtException", new Error("one"));
  proc.emit("unhandledRejection", new Error("two"));
  await new Promise(r => setTimeout(r, 60));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /one/);
  assert.deepEqual(exits, [70]);
  off();
  assert.equal(proc.listenerCount("uncaughtException") + proc.listenerCount("unhandledRejection"), 0);
});
