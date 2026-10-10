// The Spaces page's one way to add a space is a button that says so (a lone plus read as nothing on a phone, and the menu behind it did not open from an IconButton).
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Spaces opens its Create or Join menu from a button with the words Add a space", () => {
  const src = fs.readFileSync(new URL("./SpacesScreen.tsx", import.meta.url), "utf8");
  assert.ok(/<Menu trigger=\{<Button[^>]*label="Add a space"/.test(src), "the trigger is a labelled Button");
  assert.ok(!/<IconButton icon="plus"/.test(src), "no lone plus");
});
