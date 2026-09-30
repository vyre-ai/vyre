// @ts-check
// Stub: replaced by the real component (docs/design/system/components).
import { h } from "../../js/dom.js";
import { shell } from "./kit.js";

export function filePreview(/** @type {any} */ data, /** @type {any} */ ctx = {}) {
  const el = shell("cv-file-preview", "file-preview");
  el.update = /** @type {any} */ (d => { data = d; el.replaceChildren(h("div", null, "file-preview")); });
  el.update(data);
  return el;
}
