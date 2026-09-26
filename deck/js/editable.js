// @ts-check
// Held content, edited in place. There is no Edit button anywhere in the Deck: every field of a
// held draft or approval (To, Subject, the body, a URL, an amount) is a real input that looks
// like text until it is focused, then shows a subtle underline. Send passes `edited` with only
// the fields that changed; nothing changed means no `edited` at all.

import { h } from "./dom.js";

/**
 * @typedef {{ key: string, label: string, value: string, multiline?: boolean, json?: boolean, mono?: boolean }} Field
 * @typedef {{ el: HTMLElement, edited: () => Record<string, any> | null, changed: () => boolean, error: () => string | null, focus: () => void }} Form
 */

/**
 * Fields for one Gate item, in the order a person reads them: where it goes first, then the
 * content's own keys as the sender names them. Strings stay strings; anything else is edited as
 * JSON and parsed back on Send.
 * @param {{ to?: string|string[], draft?: Record<string, any> }} item
 * @returns {Field[]}
 */
export function gateFields(item) {
  const to = Array.isArray(item.to) ? item.to.join(", ") : String(item.to || "");
  const draft = item.draft || {};
  const LABEL = { subject: "Subject", body: "Body", cc: "Cc", bcc: "Bcc", method: "Method", url: "URL", headers: "Headers", in_reply_to: "In reply to" };
  const ORDER = ["subject", "cc", "bcc", "method", "url", "headers", "body"];
  const keys = Object.keys(draft).sort((a, b) => rank(a) - rank(b));
  function rank(k) { const i = ORDER.indexOf(k); return i < 0 ? ORDER.length - 1 : i; }
  /** @type {Field[]} */
  const out = [{ key: "to", label: "To", value: to }];
  for (const k of keys) {
    const v = draft[k];
    const json = typeof v !== "string";
    out.push({ key: k, label: LABEL[k] || k.replace(/_/g, " "), value: json ? JSON.stringify(v, null, 2) : v,
      multiline: k === "body" || json || String(v).includes("\n"), json, mono: json || k === "url" || k === "method" });
  }
  return out;
}

/**
 * The form. Labels on the left as on the boards; each value is an input with no chrome.
 * @param {Field[]} fields
 * @param {{ onchange?: (changed: boolean) => void, cls?: string }} [opts]
 * @returns {Form}
 */
export function form(fields, opts = {}) {
  const inputs = new Map();
  const rows = fields.map(f => {
    const id = "ed-" + Math.random().toString(36).slice(2, 8);
    const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (f.multiline
      ? h("textarea", { id, class: "ed-in" + (f.mono ? " ed-mono" : ""), rows: "1", spellcheck: f.json ? "false" : "true" })
      : h("input", { id, class: "ed-in" + (f.mono ? " ed-mono" : ""), type: "text", spellcheck: f.mono ? "false" : "true", autocomplete: "off" }));
    el.value = f.value;
    const grow = () => { if (el instanceof HTMLTextAreaElement) { el.style.height = "auto"; el.style.height = el.scrollHeight + "px"; } };
    el.addEventListener("input", () => { grow(); el.closest(".ed-row")?.classList.toggle("ed-dirty", el.value !== f.value); opts.onchange?.(changed()); });
    // The height is only known once the page has laid it out.
    requestAnimationFrame(grow);
    inputs.set(f.key, { f, el });
    return h("div", { class: "ed-row" + (f.multiline && f.key === "body" ? " ed-body" : "") },
      h("label", { class: "lbl ed-lbl", for: id }, f.label), el);
  });
  const changed = () => [...inputs.values()].some(({ f, el }) => el.value !== f.value);
  const error = () => {
    for (const { f, el } of inputs.values()) {
      if (f.json && el.value !== f.value) { try { JSON.parse(el.value); } catch { return `${f.label} is not valid JSON.`; } }
    }
    return null;
  };
  const edited = () => {
    /** @type {Record<string, any>} */
    const out = {};
    for (const { f, el } of inputs.values()) {
      if (el.value === f.value) continue;
      if (f.key === "to") out.to = el.value.split(",").map(s => s.trim()).filter(Boolean);
      else out[f.key] = f.json ? JSON.parse(el.value) : el.value;
    }
    return Object.keys(out).length ? out : null;
  };
  return { el: h("div", { class: "ed " + (opts.cls || "") }, rows), edited, changed, error,
    focus: () => { const first = [...inputs.values()].find(x => x.f.key === "body") || [...inputs.values()][0]; first?.el.focus(); } };
}
