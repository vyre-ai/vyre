// @ts-check
// Stub: replaced by the real component (docs/design/system/components).
import { h } from "../../js/dom.js";
import { shell } from "./kit.js";

export function prReview(/** @type {any} */ data, /** @type {any} */ ctx = {}) {
  const el = shell("cv-pr-review", "pr-review");
  el.update = /** @type {any} */ (d => { data = d; el.replaceChildren(h("div", null, "pr-review")); });
  el.update(data);
  return el;
}
