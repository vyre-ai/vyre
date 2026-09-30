// @ts-check
// The parts every chat component (docs/design/system/components, app-design.md section 10)
// shares, so they look and behave the same: the stylesheet loader, the header, a status chip,
// untrusted text, and the two ways a card reaches the person's box (a queued call, or a plain one).
// Colours come from the theme variables in css/tokens.css (--panel, --rule, --text, --beacon-dot
// ...) and nowhere else: a card never writes a hex value.

import { h } from "../../js/dom.js";
import { icon } from "../../js/icons.js";
import { clock } from "../../js/fmt.js";

/** Load cards/<name>.css once. No document (a test) does nothing. @param {string} name */
export function ensureCss(name) {
  if (typeof document === "undefined" || !document.head?.append) return;
  const href = new URL(`./${name}.css`, import.meta.url).href;
  if (document.querySelector?.(`link[data-card-css="${href}"]`)) return;
  document.head.append(h("link", { rel: "stylesheet", href, "data-card-css": href }));
}

/** The card shell: a neutral panel section, tagged as a card row for the header rule. @param {string} cls @param {string} label */
export function shell(cls, label) {
  const el = /** @type {any} */ (h("section", { class: `cv-card ${cls}`, "aria-label": label }));
  el._kind = "card";
  el._ts = null;
  return el;
}

/** The 44 px header line: an icon, a title, and quiet meta on the right. @param {{ icon?: string, title: any, meta?: any, at?: any }} o */
export function head(o) {
  return h("div", { class: "cv-card-head" },
    o.icon ? h("span", { class: "cv-card-ico", "aria-hidden": "true" }, icon(o.icon, 16)) : null,
    h("span", { class: "cv-card-title ellipsis" }, o.title),
    h("span", { class: "cv-card-sp" }),
    o.meta ? h("span", { class: "cv-card-meta" }, o.meta) : null,
    o.at != null && Number.isFinite(new Date(o.at).getTime()) ? h("span", { class: "cv-card-meta" }, clock(o.at)) : null);
}

/**
 * A status chip: the mark and the word, never colour alone (status-mark.md).
 * @param {"running"|"done"|"failed"|"needs"|"neutral"} state @param {string} word @param {{ onclick?: any, title?: string }} [o]
 */
export function chip(state, word, o = {}) {
  const tag = o.onclick ? "button" : "span";
  return h(tag, { class: `tag cv-chip cv-chip-${state}`, ...(o.onclick ? { type: "button", onclick: o.onclick } : {}), title: o.title || null },
    h("span", { class: `cv-mark cv-mark-${state}`, "aria-hidden": "true" }), word);
}

/** Text that came from outside the person's own agents (a collaborator's comment, an email body):
 * always a text node, clipped, never markup, and marked so a card can fold it. @param {any} s @param {number} [max] */
export function untrusted(s, max = 4000) {
  const t = String(s ?? "");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** A single-line problem in plain words (never raw JSON). @param {any} e */
export function problemText(e) {
  if (!e) return "";
  const m = typeof e === "string" ? e : e.message || e.error || e.code || "";
  return /^[\[{]/.test(String(m).trim()) ? "That did not go through." : String(m) || "That did not go through.";
}
