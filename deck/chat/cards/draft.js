// @ts-check
// Stub: replaced by the real component (docs/design/system/components).
import { h } from "../../js/dom.js";
import { shell } from "./kit.js";

export function draftCard(/** @type {any} */ data, /** @type {any} */ ctx = {}) {
  const el = shell("cv-draft", "draft");
  el.update = /** @type {any} */ (d => { data = d; el.replaceChildren(h("div", null, "draft")); });
  el.update(data);
  return el;
}
