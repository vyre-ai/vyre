// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NARROW, closesPanel, sidePanelBox, sidePanelMode } from "./side-panel.js";

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

test("Escape closes the panel, but not while a field has the key; a press outside closes it, a press inside or on a menu above it does not", () => {
  assert.equal(closesPanel({ type: "key", key: "Escape" }), true);
  assert.equal(closesPanel({ type: "key", key: "Escape", inField: true }), false);
  assert.equal(closesPanel({ type: "key", key: "a" }), false);
  assert.equal(closesPanel({ type: "press", inside: false, onTop: false }), true);
  assert.equal(closesPanel({ type: "press", inside: true }), false);
  assert.equal(closesPanel({ type: "press", inside: false, onTop: true }), false);
});

test("a narrow window gets a solid sheet over the list, a wide one a box beside it", () => {
  const n = /** @type {any} */ (sidePanelBox(520, true));
  assert.equal(n.position, "absolute");
  assert.equal(n.maxWidth, "92%");
  assert.equal(/** @type {any} */ (sidePanelBox(520, false)).position, undefined);
  assert.ok(NARROW > 700 && NARROW < 1280);
});
