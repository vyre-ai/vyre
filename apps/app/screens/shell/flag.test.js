// @ts-check
// A release web build leaves EXPO_PUBLIC_VYRE_TYPED_CODE unset, so the short typed code is hidden in it: in the app's own page and in the one the Windows (and Mac) shell hosts, which is the same export.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { flagOn } from "./flag.js";

const read = (/** @type {string} */ rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("typed code: unset, empty, 0, true and a padded 1 are all off; only an exact 1 is on", () => {
  for (const v of [undefined, "", "0", "true", "yes", " 1", "1 ", "01"]) assert.equal(flagOn(v), false, JSON.stringify(v));
  assert.equal(flagOn("1"), true);
});

test("typed code: rc.ts reads the variable by its exact name (so Expo inlines it) and gates everything on RC.typedCode", () => {
  const rc = read("./rc.ts");
  assert.match(rc, /typedCode: flagOn\(process\.env\.EXPO_PUBLIC_VYRE_TYPED_CODE\)/);
  for (const f of ["../devices/TypeCode.tsx", "../install/MacServer.tsx"]) assert.match(read(f), /RC\.typedCode/, `${f} is gated on RC.typedCode`);
});

test("typed code: nothing that builds a release export sets the variable (the CI workflows, the app's export scripts, the shell's build)", () => {
  const root = new URL("../../../../", import.meta.url);
  const files = [new URL("apps/app/package.json", root)];
  const wf = new URL(".github/workflows/", root);
  try { for (const n of readdirSync(wf)) if (/\.ya?ml$/.test(n)) files.push(new URL(n, wf)); } catch { /* no workflows here */ }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    // the one allowed mention: the walk README's development line and the scripts that turn it on for a walk are not release builds
    assert.doesNotMatch(text, /EXPO_PUBLIC_VYRE_TYPED_CODE/, `${f.pathname.replace(root.pathname, "")} must not turn the typed code on`);
  }
});
