// @ts-check
// Stub: replaced by the real component (docs/design/system/components).
import { h } from "../../js/dom.js";
import { shell } from "./kit.js";

export function emailThread(/** @type {any} */ data, /** @type {any} */ ctx = {}) {
  const el = shell("cv-email-thread", "email-thread");
  el.update = /** @type {any} */ (d => { data = d; el.replaceChildren(h("div", null, "email-thread")); });
  el.update(data);
  return el;
}
