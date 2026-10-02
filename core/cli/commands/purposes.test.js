// The kinds of session a model can be set for are one list: the config's, the CLI's, and threads.start's own enum.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PURPOSES as CLI } from "./sessions.js";
import { PURPOSES as CONFIG } from "../../sessions/config.js";

test("session purposes: the CLI, the config and threads.start name the same ten kinds", () => {
  assert.deepEqual([...CLI].sort(), [...CONFIG].sort());
  assert.equal(CONFIG.length, 10);
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "switchboard", "index.js"), "utf8");
  const m = /purpose: \{ type: "string", enum: \[([^\]]+)\]/.exec(src);
  assert.ok(m, "threads.start declares its purposes");
  const start = m[1].split(",").map(x => x.trim().replace(/"/g, "")).sort();
  assert.deepEqual(start, [...CONFIG].sort());
});
