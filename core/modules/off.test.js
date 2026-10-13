// @ts-check
// The planner is off in this release (core/modules/off.js): the real vyred leaves it out, the code and its own tests stay.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODULES_OFF } from "./off.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the planner is on the list of modules left off, and its code is still in the repo", () => {
  assert.ok(MODULES_OFF.includes("planner"));
  assert.ok(fs.existsSync(path.join(here, "..", "planner", "module.json")), "the module stays so one line brings it back");
});

test("vyred's entry point passes the list to start(), and start() adds it to the registry's disable list", () => {
  const main = fs.readFileSync(path.join(here, "..", "daemon", "main.js"), "utf8");
  assert.match(main, /modulesOff: MODULES_OFF/);
  const daemon = fs.readFileSync(path.join(here, "..", "daemon", "index.js"), "utf8");
  assert.match(daemon, /\.\.\.\(opts\.modulesOff \|\| \[\]\)/);
});
