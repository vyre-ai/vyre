import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { templateLabel, keepTemplateNames, wordsFromId, isTemplateField, onTemplateNames } from "./template-names.js";

test("a template id reads as words until its name is known, then as its name", () => {
  assert.equal(wordsFromId("tpl_ad-campaign"), "Ad campaign");
  assert.equal(templateLabel("tpl_launch-plan"), "Launch plan");
  let told = 0; const off = onTemplateNames(() => { told++; });
  keepTemplateNames([{ data: { template: "tpl_launch-plan", name: "Launch plan v2" } }, { data: { template: "tpl_launch-plan", name: "Launch plan v2" } }]);
  assert.equal(templateLabel("tpl_launch-plan"), "Launch plan v2");
  assert.equal(told, 1, "told once, not per version");
  off();
  assert.equal(templateLabel(""), "");
  assert.equal(templateLabel(null), null);
});

test("only a project's template field is mapped", () => {
  assert.equal(isTemplateField({ type: "project" }, { name: "template" }), true);
  assert.equal(isTemplateField({ type: "contact" }, { name: "template" }), false);
});
