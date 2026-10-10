import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Radix's dropdown Portal slots onto ONE child (asChild). Two siblings blank the page on the web ("Primitive.div failed to slot onto its children"). The browser walk
// (scripts/ux-shots.mjs, "Rail menus that did not open cleanly") opens each rail menu for real; this keeps the shape from coming back.
const src = fs.readFileSync(new URL("./Menu.tsx", import.meta.url), "utf8");
const portal = src.slice(src.indexOf("<P.Portal>"), src.indexOf("</P.Portal>"));

test("the menu's portal has one child on the web: the content, with no overlay beside it", () => {
  assert.ok(portal.includes('Platform.OS === "web" ? content :'), "the web branch is the content alone");
  const web = portal.slice(portal.indexOf('Platform.OS === "web"'), portal.indexOf("<>"));
  assert.ok(!web.includes("P.Overlay"), "no overlay in the web branch");
  assert.equal((portal.match(/<P\.Overlay/g) || []).length, 1, "the overlay is only in the phone branch");
});

// A Menu trigger is cloned with Radix's pointer handlers, aria props and ref. A Button or IconButton that drops them never opens the menu on the web: the Vault's Add button was dead until they passed them on.
test("Button and IconButton pass what they are not given on to the pressable, so either can be a Menu trigger", () => {
  const button = fs.readFileSync(new URL("./Button.tsx", import.meta.url), "utf8");
  assert.equal((button.match(/\.\.\.slot\b/g) || []).length, 2, "both components collect the rest");
  assert.equal((button.match(/\{\.\.\.\(slot as object\)\}/g) || []).length, 2, "and spread it onto their pressable");
  assert.ok(/\{\.\.\.\(slot as object\)\}\s+depth=/.test(button), "Button spreads it onto its PressableScale");
});
