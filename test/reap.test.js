// @ts-check
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { reap, processesWith } from "./reap.mjs";

test("reap: kills a detached process group that carries the marker, and nothing else", async () => {
  const marker = `/vyre-mac-reaptest-${crypto.randomBytes(6).toString("hex")}/x`;
  const other = `/vyre-mac-other-${crypto.randomBytes(6).toString("hex")}/x`;
  const mk = (/** @type {string} */ m) => spawn("/bin/sh", ["-c", 'sleep 30; true', m], { detached: true, stdio: "ignore" });
  const a = mk(marker), b = mk(other);
  a.unref(); b.unref();
  await new Promise(r => setTimeout(r, 400));
  assert.ok(processesWith(marker).length >= 1, "it is running");
  assert.ok(reap(marker) >= 1);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(processesWith(marker).length, 0, "gone");
  assert.ok(processesWith(other).length >= 1, "a process with another marker is untouched");
  reap(other);
});
