// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { reap, processesWith } from "./reap.mjs";

test("reap: kills a detached process group that carries the marker, and nothing else", async () => {
  const marker = path.join(os.tmpdir(), `vyre-mac-reaptest-${crypto.randomBytes(6).toString("hex")}`, "x");
  const other = path.join(os.tmpdir(), `vyre-mac-other-${crypto.randomBytes(6).toString("hex")}`, "x");
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

test("reap: an empty, short, relative or out-of-tmp marker is refused, never matched", () => {
  for (const bad of ["", "x", "vyre-mac-", "/", "/usr", os.tmpdir(), "/vyre-mac-not-under-tmp/x"]) {
    assert.throws(() => processesWith(bad), /refusing the marker/, JSON.stringify(bad));
    assert.throws(() => reap(bad), /refusing the marker/, JSON.stringify(bad));
  }
});
