// @ts-check
import "../../scripts/mac-test-guard.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ASKS } from "./asks.js";
import { routeComposerLine } from "../../lib/thread-composer-route.js";

const NATIVE_LINES = [
  "/compact keep dates",
  "/remember prefer tabs",
  "/later at 5pm check filing",
  "/find notes about the lease",
  "/model sonnet",
  "/effort high",
  "/rewind",
  "/export",
  "/memory",
  "/status",
  "!git status",
];

test("threads_slash harness asks cover native composer lines and map to kernel tools", () => {
  const row = ASKS.threads_slash;
  assert.ok(row && row.asks.length >= 4);
  assert.ok(row.example && typeof row.example.line === "string");
  for (const line of NATIVE_LINES) {
    const r = routeComposerLine(line);
    assert.ok(r.tool, line);
    if (line.startsWith("!")) assert.equal(r.tool, "threads.shell");
    else if (line.startsWith("/later")) assert.equal(r.tool, "planner.add");
    else if (line.startsWith("/find")) assert.equal(r.tool, "recall.search");
    else if (line.startsWith("/remember")) assert.equal(r.tool, "threads.remember");
  }
  const covered = NATIVE_LINES.some((l) => row.asks.some((a) => a.includes(l.split(/\s/)[0].replace("!", "/"))));
  assert.ok(covered, "asks mention representative slash families");
});
