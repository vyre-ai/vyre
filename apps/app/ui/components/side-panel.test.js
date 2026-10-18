// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sidePanelMode } from "./side-panel.js";

test("a side panel is closed, a sheet on a phone, and a panel over the view otherwise", () => {
  assert.equal(sidePanelMode({ open: false, phone: false }), "closed");
  assert.equal(sidePanelMode({ open: false, phone: true }), "closed");
  assert.equal(sidePanelMode({ open: true, phone: true }), "sheet");
  assert.equal(sidePanelMode({ open: true, phone: false }), "panel");
});
