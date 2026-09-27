// @ts-check
// Opt-in, Mac only: compile every AppleScript the adapters ship with `osacompile`, which checks
// the syntax against each app's dictionary without running anything. The fakes in the other tests
// prove what reaches argv; only this proves the scripts themselves parse. It is skipped unless a
// person at the Mac sets VYRE_MAC_REAL=1, because compiling loads Notes' and Reminders'
// dictionaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { tempHome } from "../../test/helpers.js";
import * as notes from "./adapters/notes.js";
import * as reminders from "./adapters/reminders.js";

const on = process.platform === "darwin" && process.env.VYRE_MAC_REAL === "1";
const SCRIPTS = { "notes CREATE": notes.CREATE, "notes APPEND": notes.APPEND, "notes LIST": notes.LIST,
  "reminders CREATE": reminders.CREATE, "reminders LISTS": reminders.LISTS };

for (const [name, script] of Object.entries(SCRIPTS)) {
  test(`mac: ${name} compiles`, { skip: on ? false : "set VYRE_MAC_REAL=1 on a Mac to compile the real scripts" }, t => {
    const out = path.join(tempHome(t), "script.scpt");
    assert.doesNotThrow(() => execFileSync("osacompile", ["-o", out, "-e", script], { stdio: "pipe", timeout: 30000 }));
  });
}
