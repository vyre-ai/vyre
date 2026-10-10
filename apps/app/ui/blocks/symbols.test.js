// A module describes a row with a system symbol; the app draws its own icon family. Every symbol a module may use has a family icon, and every family icon the table names exists.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ICONS } from "../../../../packages/module-sdk/capsule-view.js";
import { FAMILY_OF_SYMBOL, iconFor } from "./symbols.js";

const family = [...fs.readFileSync(new URL("../../src/ui/icons.generated.ts", import.meta.url), "utf8").matchAll(/^\s*\|\s*"([a-z0-9-]+)"/gm)].map((m) => m[1]);

test("every symbol a module may use has an icon in the app's family, and the table names no icon the family lacks", () => {
  assert.ok(family.length > 80, "the family list was read");
  const missing = [...ICONS].filter((s) => !FAMILY_OF_SYMBOL[s]);
  assert.deepEqual(missing, [], "add each to FAMILY_OF_SYMBOL in ui/blocks/symbols.js");
  const bad = Object.entries(FAMILY_OF_SYMBOL).filter(([, f]) => !family.includes(f));
  assert.deepEqual(bad, [], "these map to an icon the family does not have");
  assert.deepEqual(Object.keys(FAMILY_OF_SYMBOL).filter((s) => !ICONS.has(s)), [], "a symbol in the table that modules may not use");
});

test("a symbol is translated, a family name stays, anything else is no icon", () => {
  assert.equal(iconFor("gear", family), "settings");
  assert.equal(iconFor("creditcard", family), "card");
  assert.equal(iconFor("vault", family), "vault");
  assert.equal(iconFor("not-an-icon", family), undefined);
  assert.equal(iconFor(undefined, family), undefined);
});
