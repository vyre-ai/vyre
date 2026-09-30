// @ts-check
// Stub: replaced by the real component (docs/design/system/components).
import { h } from "../../js/dom.js";
import { shell } from "./kit.js";

export function calendarEvent(/** @type {any} */ data, /** @type {any} */ ctx = {}) {
  const el = shell("cv-calendar-event", "calendar-event");
  el.update = /** @type {any} */ (d => { data = d; el.replaceChildren(h("div", null, "calendar-event")); });
  el.update(data);
  return el;
}
