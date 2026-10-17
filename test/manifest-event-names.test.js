// @ts-check
// A module's events must look like noun.past-verb (two segments, no more dots): the registry marks a module with any other name invalid and it never registers, which once took the vault and a hundred
// test files down with one event named vault.space.used. This reads every module.json and fails on a name the registry would refuse, before the daemon is asked to start it.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./source-files.js";

const NAME = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

test("every event a first-party module declares is a two-segment noun.past-verb name", () => {
  /** @type {string[]} */ const bad = [];
  for (const dir of fs.readdirSync(path.join(ROOT, "core"), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(ROOT, "core", dir.name, "module.json");
    if (!fs.existsSync(file)) continue;
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const e of (m.watches && m.watches.emits) || []) if (!NAME.test(String(e))) bad.push(`core/${dir.name}/module.json: event "${e}"`);
  }
  assert.deepEqual(bad, []);
});
