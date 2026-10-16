// @ts-check
import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { browseMode } from "../core/computers/shared-browser.js";

test("shared browser: computer.default-browser selects browser mode on a fake driver", () => {
  assert.equal(browseMode({ driver: "fake", defaultBrowser: true }), "browser");
  assert.equal(browseMode({ driver: "fake" }), "desktop");
});
