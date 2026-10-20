// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sidePanelBox, sidePanelMode } from "./side-panel.js";

test("a side panel is closed, a sheet on a phone, and a panel over the view otherwise", () => {
  assert.equal(sidePanelMode({ open: false, phone: false }), "closed");
  assert.equal(sidePanelMode({ open: false, phone: true }), "closed");
  assert.equal(sidePanelMode({ open: true, phone: true }), "sheet");
  assert.equal(sidePanelMode({ open: true, phone: false }), "panel");
});

test("the panel is a box in the row beside the view, never laid over it", () => {
  const box = /** @type {any} */ (sidePanelBox());
  assert.equal(box.position, undefined, "no absolute position: it would cover the list's header and toolbar");
  assert.equal(box.width, 520);
  assert.equal(box.maxWidth, "50%");
  assert.equal(box.flexShrink, 0);
  assert.equal(/** @type {any} */ (sidePanelBox(400)).width, 400);
});
