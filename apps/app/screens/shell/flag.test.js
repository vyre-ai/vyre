// @ts-check
// The short typed code ships ON in release (the user's ruling, 5 Oct): a release web build leaves EXPO_PUBLIC_VYRE_TYPED_CODE unset, so it is on in the app's own page and in the one the Windows (and Mac) shell hosts,
// which is the same export. Only an exact "0" switches it off (a kill switch), and nothing that builds a release export sets that.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { flagNotOff } from "./flag.js";

const read = (/** @type {string} */ rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("typed code: unset, empty, 1, true and anything else leave it on; only an exact 0 turns it off", () => {
  for (const v of [undefined, "", "1", "true", "yes", " 0", "0 ", "00", "false"]) assert.equal(flagNotOff(v), true, JSON.stringify(v));
  assert.equal(flagNotOff("0"), false);
});

test("typed code: rc.ts reads the variable by its exact name (so Expo inlines it) and everything typed is gated on RC.typedCode", () => {
  const rc = read("./rc.ts");
  assert.match(rc, /typedCode: flagNotOff\(process\.env\.EXPO_PUBLIC_VYRE_TYPED_CODE\)/);
  for (const f of ["../devices/TypeCode.tsx", "../install/MacServer.tsx"]) assert.match(read(f), /RC\.typedCode/, `${f} is gated on RC.typedCode`);
});

test("typed code: nothing that builds a release export switches it off (the CI workflows, the app's export scripts)", () => {
  const root = new URL("../../../../", import.meta.url);
  const files = [new URL("apps/app/package.json", root)];
  const wf = new URL(".github/workflows/", root);
  try { for (const n of readdirSync(wf)) if (/\.ya?ml$/.test(n)) files.push(new URL(n, wf)); } catch { /* no workflows here */ }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /EXPO_PUBLIC_VYRE_TYPED_CODE\s*[:=]\s*["']?0/, `${f.pathname.replace(root.pathname, "")} must not switch the typed code off`);
  }
});

test("typed code: the screen shows the code's own end only when the server sent one (no invented 10 minutes)", () => {
  const src = read("../devices/TypeCode.tsx");
  assert.doesNotMatch(src, /10 \* 60_000/, "no hard-coded lifetime");
  assert.match(src, /typeof expires === "number" \? expires : null/, "the end comes with the ack");
});
