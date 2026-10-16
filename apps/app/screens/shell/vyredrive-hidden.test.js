// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (/** @type {string} */ rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");

test("VyreDrive's box-share section is off in Settings (RC.vyreDrive false) and the section is drawn only when it is on", () => {
  assert.match(read("./rc.ts"), /vyreDrive: false,/);
  const screen = read("../settings/SystemScreen.tsx");
  assert.match(screen, /\{RC\.vyreDrive \? <Drive \/> : null\}/);
  assert.doesNotMatch(screen, /^\s*<Drive \/>\s*$/m, "an unconditional <Drive /> brings the section back");
});
