// @ts-check
import "../../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { refused } from "./check-export-names.mjs";

test("the names a web export makes pass, including bracket and plus chunk names; a name the manifest would refuse is found", () => {
  assert.deepEqual(refused(["index.html", "_expo/static/js/web/entry-3f2a.js", "assets/fonts/Inter.woff2", "[flow]-9a8b.js", "+not-found-77aa.js", "u/now/index.html"]), []);
  assert.deepEqual(refused(["a b.js", "/abs.js", "../up.js", "x/../y.js", "tilde~.js", "q?x.js", "café.js"]).length, 7);
});
