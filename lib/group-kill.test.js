// @ts-check
// lib/group-kill: a process group is signalled only for a real child's pid. kill(-1) would end every process of the user (it ended all six CI runners of a host on 18 Oct 2026); kill(0) the caller's own group.
// process.kill is replaced for every refusal case, so this test cannot signal anything by itself.
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { groupPid, killGroup } from "./group-kill.js";

test("only an integer above 1 is a group worth signalling", () => {
  for (const ok of [2, 3, 4242, 4194303]) assert.equal(groupPid(ok), true, String(ok));
  for (const bad of [1, 0, -1, -2, 1.5, NaN, Infinity, "5", "1", null, undefined, {}, [], 2n]) assert.equal(groupPid(bad), false, String(bad));
});

test("a pid that is not a group sends no signal at all: not -1, not 0, not the pid itself", (t) => {
  const calls = /** @type {any[][]} */ ([]);
  t.mock.method(process, "kill", (/** @type {any[]} */ ...a) => { calls.push(a); return true; });
  for (const bad of [1, 0, -1, NaN, undefined, null, "1", 1.5]) assert.equal(killGroup(bad, "SIGTERM"), false, String(bad));
  assert.deepEqual(calls, [], "process.kill was not called");
});

test("a real child's group is signalled, and a group that is gone answers false", async () => {
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  const gone = new Promise((r) => child.once("exit", (code, sig) => r(sig)));
  assert.equal(killGroup(child.pid, "SIGTERM"), true);
  assert.equal(await gone, "SIGTERM");
  assert.equal(killGroup(child.pid, "SIGTERM"), false, "the group no longer exists");
});
