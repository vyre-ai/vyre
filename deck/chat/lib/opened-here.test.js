// @ts-check
// deck/chat/lib/opened-here.js: a route acts on load only when this page opened it, once.

import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { markOpened, openedHere } from "./opened-here.js";

test("a link never counts; the page's own opening counts once", () => {
  assert.equal(openedHere("term:abc"), false, "reached by a link");
  markOpened("term:abc");
  assert.equal(openedHere("term:abc"), true);
  assert.equal(openedHere("term:abc"), false, "a second visit by link needs the click again");
});
