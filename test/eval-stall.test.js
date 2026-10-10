// @ts-check
// A stalled eval harness is asked where it is from outside: a process spinning in a busy loop answers a pause over its inspector, and the frame names the line it spins on.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { whereIsIt, inspectorUrl } from "../scripts/eval-honest/stall.mjs";

test("a process in a busy loop is paused over its inspector and the top frame is its own function", async (t) => {
  const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", "-e", "function spinningHere() { for (;;) { /* busy */ } } spinningHere();"], { stdio: ["ignore", "ignore", "pipe"] });
  t.after(() => child.kill("SIGKILL"));
  const url = await new Promise((resolve, reject) => {
    child.stderr.on("data", (b) => { const u = inspectorUrl(String(b)); if (u) resolve(u); });
    child.on("exit", () => reject(new Error("the child exited")));
  });
  assert.match(String(url), /^ws:\/\/127\.0\.0\.1:\d+\//);
  const frames = await whereIsIt(/** @type {string} */ (url));
  assert.ok(frames.length > 0, "it answered");
  assert.match(frames[0], /^spinningHere \(.+:\d+\)$/, frames.join("\n"));
});

test("a chunk of stderr without the inspector line gives no address", () => {
  assert.equal(inspectorUrl("some other line"), "");
  assert.equal(inspectorUrl("Debugger listening on ws://127.0.0.1:9229/abc-123\nFor help"), "ws://127.0.0.1:9229/abc-123");
});
