// @ts-check
// The Vyre components a tool result becomes (DESIGN-native-assistant.md, idea 5). Plain data only: no HTML, no functions, JSON-serialisable.
// native-core's Deck renders one component per kind; there is no raw-JSON fallback, so an unknown result is a `text` component.
// The kinds are closed. A component never holds a sealed value or reference, and free text written by a model or a doer is stripped of control
// and bidirectional characters, capped, and shown only in a separate quoted block with no links or buttons.

import { isSealedValue } from "../../../lib/sealed.js";

export const KINDS = Object.freeze(["record_card", "task_card", "draft", "flow_diff", "memory_answer", "held_for_approval", "group", "text"]);

/** Length caps (characters). A renderer may truncate further; it may never show more. */
export const CAPS = Object.freeze({ short: 200, text: 2000, body: 8000, quote: 600, items: 50 });

/**
 * @typedef {{ trust: "system"|"member"|"external"|"untrusted", red: string, source_spaces: readonly string[] }} Labels
 * @typedef {{ name: string, label: string, kind: string, display: string, sealed?: true }} FieldLine
 *   a sealed field has display "on file, sealed" (or "empty") and no value of any kind
 * @typedef {{ label: string, quoted: true, interactive: false, text: string }} QuotedBlock  free text of a doer or model: no links, no buttons
 * @typedef {{ kind: "record_card", type: string, title: string, urn: string, stage: string|null, fields: FieldLine[], hidden: number, source: Labels }} RecordCard
 * @typedef {{ kind: "task_card", id: string|null, title: string, record: string|null, doer: string, checker: string|null, state: string, output: string, tap: { label: string, what: string }|null, payload_summary: string|null, from_doer: QuotedBlock|null }} TaskCard
 * @typedef {{ kind: "draft", title: string, body: string, editable: true, template: { name: string, version: number|null }|null, to: string|null, merge_fields: { name: string, value: string }[], sealed_slots: { slot: string, label: string }[], edit_voids_approval: true }} Draft
 *   body keeps `{{slot:name}}` tokens as they are; a sealed slot is filled by the kernel at send time
 * @typedef {{ kind: "flow_diff", title: string, hash: string, authorship: string, changes: string[], simulation: { ok: boolean, text: string }, outward: { text: string }[], names: { name: string, shown: string, flags: string[] }[], from_author: QuotedBlock|null }} FlowDiff
 * @typedef {{ kind: "memory_answer", text: string, citations: { address: string, label: string|null }[], labels: Labels|null }} MemoryAnswer
 * @typedef {{ kind: "held_for_approval", task: string|null, title: string, summary: string, approver: string, what: string }} HeldForApproval
 * @typedef {{ kind: "group", title: string, items: Component[] }} Group
 * @typedef {{ kind: "text", text: string }} Text
 * @typedef {RecordCard|TaskCard|Draft|FlowDiff|MemoryAnswer|HeldForApproval|Group|Text} Component
 */

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BIDI = /[‎‏‪-‮⁦-⁩؜]/g;
const INVISIBLE = /[​-‍⁠﻿­]/g;

/** Plain words: control, bidirectional and invisible characters out, capped. @param {unknown} s @param {number} [max] */
export function clean(s, max = CAPS.short) {
  const t = String(s ?? "").replace(CONTROL, "").replace(BIDI, "").replace(INVISIBLE, "");
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Free text from a doer or a model as a quote: no markdown links, no HTML, no URLs. @param {unknown} s @param {string} label @returns {QuotedBlock|null} */
export function quoted(s, label) {
  const t = clean(s, CAPS.quote * 2)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]*>/g, "").replace(/\b(?:https?|ftp|javascript|data|vyre):[^\s)]*/gi, "[link removed]").slice(0, CAPS.quote);
  return t.trim() ? { label: clean(label, 60), quoted: true, interactive: false, text: t } : null;
}

/**
 * Throw if `c` is not a closed, plain, safe component. Used by the producer on every result and by the Deck's tests.
 * @param {unknown} c @returns {Component}
 */
export function assertComponent(c) {
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new Error("a component is an object");
  const kind = /** @type {any} */ (c).kind;
  if (!KINDS.includes(kind)) throw new Error(`unknown component kind ${String(kind)}`);
  walk(c, "$", 0);
  if (kind === "group") for (const it of /** @type {any} */ (c).items) assertComponent(it);
  return /** @type {Component} */ (c);
}

/** @param {any} v @param {string} at @param {number} depth */
function walk(v, at, depth) {
  if (depth > 8) throw new Error(`${at}: too deep`);
  if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") throw new Error(`${at}: a component is data, not a ${typeof v}`);
  if (v === null || v === undefined || typeof v === "boolean" || typeof v === "number") return;
  if (typeof v === "string") {
    if (CONTROL.test(v) || BIDI.test(v) || INVISIBLE.test(v)) { CONTROL.lastIndex = BIDI.lastIndex = INVISIBLE.lastIndex = 0; throw new Error(`${at}: control or bidirectional characters`); }
    CONTROL.lastIndex = BIDI.lastIndex = INVISIBLE.lastIndex = 0;
    if (v.length > CAPS.body) throw new Error(`${at}: string over the cap`);
    return;
  }
  if (Array.isArray(v)) {
    if (v.length > CAPS.items) throw new Error(`${at}: list over the cap`);
    v.forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1));
    return;
  }
  if (typeof v === "object") {
    if (isSealedValue(v) || "ref" in v && typeof v.sealed === "string") throw new Error(`${at}: a sealed value or reference in a component`);
    if (Object.getPrototypeOf(v) !== Object.prototype) throw new Error(`${at}: not plain data`);
    for (const [k, x] of Object.entries(v)) {
      if (k === "ref" && typeof x === "string" && /^seal/i.test(x)) throw new Error(`${at}.ref: a sealed reference`);
      walk(x, `${at}.${k}`, depth + 1);
    }
  }
}
