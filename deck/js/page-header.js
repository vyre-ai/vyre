// @ts-check
// The page header (design-system.md section 4): the title (page, 24), one meta line, and the page's actions at the right. No address chip. Every page
// opens with the same one, so a person always knows where they are.
import { h } from "./dom.js";

/**
 * @param {{ title: string, meta?: string|Node|null, actions?: (Node|null)[]|Node|null }} o
 * @returns {HTMLElement}
 */
export function pageHeader({ title, meta, actions }) {
  return h("header", { class: "page-head" },
    h("div", { class: "page-head-t" }, h("h1", null, title), meta ? h("p", { class: "page-head-meta" }, meta) : null),
    actions ? h("div", { class: "page-head-acts" }, actions) : null);
}
