// @ts-check
// A tool result becomes a Vyre component (DESIGN-native-assistant.md, idea 5): a found record is a record card, a created task a task card, a
// draft an editable draft, a Flow proposal the canvas diff, a memory answer its citations, a held outward act "waiting for your approval".
// The model's words stay short and connect these. There is no raw-JSON fallback: what is not recognised becomes a plain `text` component.

import { isSealedValue } from "../../../lib/sealed.js";
import { joinLabels, memberLabels } from "../../../lib/labels.js";
import { CAPS, assertComponent, clean, quoted } from "./component-kinds.js";

export { KINDS, assertComponent } from "./component-kinds.js";

const SEALED_TEXT = "on file, sealed";

/** @param {any} a an actor as { kind, id } or a string */
const who = a => (a && typeof a === "object" ? clean(a.name || a.id || a.role && `role:${a.role}` || "unknown", 80) : clean(a ?? "", 80));

/** A field value as a person reads it, by kind. Never a sealed value: that reads "on file, sealed" or "empty". @param {any} v @param {string} kind */
function show(v, kind) {
  if (isSealedValue(v)) return { display: v.present ? SEALED_TEXT : "empty", sealed: /** @type {true} */ (true) };
  if (v === null || v === undefined || v === "") return { display: "empty" };
  if (kind === "money" || (v && typeof v === "object" && "amount" in v && "currency" in v)) return { display: clean(`${v.amount} ${v.currency}`, 60) };
  if (typeof v === "boolean") return { display: v ? "Yes" : "No" };
  if (Array.isArray(v)) return { display: clean(v.map(x => (x && typeof x === "object" ? Object.values(x).filter(y => typeof y === "string").join(" ") : String(x))).join(", "), CAPS.short) };
  if (typeof v === "object") {
    if (typeof v.urn === "string") return { display: clean(v.urn.split("/").slice(-2).join("/"), 80) };
    if (v.actor) return { display: who(v.actor) };
    if (typeof v.file === "string") return { display: clean(v.name || v.file, 80) };
    if (v.line1 || v.city) return { display: clean([v.line1, v.line2, v.city, v.region, v.postal, v.country].filter(Boolean).join(", "), CAPS.short) };
    return { display: "set" };
  }
  return { display: clean(v, CAPS.short) };
}

/**
 * @param {any} rec a gateway record: { type, id, urn, data, labels } @param {{ types?: Record<string, any> }} [ctx]
 * @returns {import("./component-kinds.js").RecordCard}
 */
function recordCard(rec, ctx = {}) {
  const def = ctx.types && ctx.types[rec.type];
  const defs = new Map((def && def.fields || []).map((/** @type {any} */ f) => [f.name, f]));
  const names = [...(def ? def.fields.map((/** @type {any} */ f) => f.name) : []), ...Object.keys(rec.data || {}).filter(k => !defs.has(k))].filter(k => k in (rec.data || {}) || defs.has(k));
  const lines = names.slice(0, 8).map(name => {
    const d = defs.get(name), kind = d && d.kind || (isSealedValue(rec.data[name]) ? "sealed" : "text");
    return { name: clean(name, 60), label: clean(d && d.label || name, 80), kind, ...show(rec.data[name], kind) };
  });
  const stageField = def && (def.fields.find((/** @type {any} */ f) => f.kind === "stage")?.name || (def.stages && "stage"));
  const stage = stageField && typeof rec.data[stageField] === "string" ? clean(rec.data[stageField], 60) : typeof rec.data?.stage === "string" ? clean(rec.data.stage, 60) : null;
  const titleKey = ["name", "title", "label"].find(k => typeof rec.data?.[k] === "string");
  return { kind: "record_card", type: clean(rec.type, 60), title: clean(titleKey ? rec.data[titleKey] : `${rec.type}`, 120), urn: clean(rec.urn || "", 200), stage, fields: lines, hidden: Math.max(0, names.length - 8), source: labelsOf(rec.labels) };
}

/** @param {any} l */
function labelsOf(l) {
  const j = joinLabels([l && l.trust ? l : memberLabels("")]);
  return { trust: j.trust, red: j.red, source_spaces: l && l.source_spaces ? [...l.source_spaces].map(s => clean(s, 40)) : [] };
}

/** What one tap does, by state (the kernel's table decides who may; this is the label). @param {any} t */
function tapFor(t) {
  if (t.state === "needs_check") return { label: t.output?.kind === "sent" ? "Send with Face ID" : "Approve with Face ID", what: "Your approval is the kernel's approval, bound to exactly what is shown." };
  if (t.state === "ready") return { label: "Open", what: "Opens the task where the doer should act." };
  if (t.state === "stuck") return { label: "See why", what: "Shows what is blocking it and the fix, which you approve like any act." };
  if (t.state === "waiting") return { label: "See what it waits on", what: "Shows the tasks this one depends on." };
  return null;
}

/** @param {any} t a task or { task, summary } @param {string} [summary] @returns {import("./component-kinds.js").TaskCard} */
function taskCard(t, summary) {
  const doer = who(t.doer);
  const free = t.stuck?.reason ?? t.note ?? t.notes ?? t.reason ?? "";
  return { kind: "task_card", id: t.id ? clean(t.id, 80) : null, title: clean(t.title, 120), record: t.record ? clean(t.record, 200) : null, doer,
    checker: t.checker ? who(t.checker) : null, state: clean(t.state || "ready", 20), output: clean(t.output?.kind || "decision", 20), tap: tapFor(t),
    payload_summary: summary ? clean(summary, 400) : null, from_doer: quoted(free, `from ${doer}`) };
}

/** @param {any} d @returns {import("./component-kinds.js").Draft} */
function draft(d) {
  const body = String(d.body ?? d.text ?? "");
  const slots = [...new Set([...body.matchAll(/\{\{\s*slot:([a-z0-9_.-]+)\s*\}\}/gi)].map(m => m[1]))].slice(0, 20);
  return { kind: "draft", title: clean(d.title || d.subject || "Draft", 120), body: clean(body, CAPS.body), editable: true,
    template: d.template ? { name: clean(d.template.name ?? d.template, 80), version: Number.isFinite(d.template.version) ? d.template.version : null } : null,
    to: d.to ? clean(d.to, 120) : null,
    merge_fields: Object.entries(d.merge || d.merge_fields || {}).slice(0, 20).map(([name, value]) => ({ name: clean(name, 60), value: isSealedValue(value) ? SEALED_TEXT : clean(value, 120) })),
    sealed_slots: slots.map(slot => ({ slot: clean(slot, 60), label: `${clean(slot, 60)}: filled by Vyre when sent, never shown` })), edit_voids_approval: true };
}

/** @param {any} c a diff card as core/engineer's diffCard shapes it @returns {import("./component-kinds.js").FlowDiff} */
function flowDiff(c) {
  return { kind: "flow_diff", title: clean(c.title || "A change to your definitions", 120), hash: clean(c.hash || "", 100), authorship: clean(c.authorship || "model-drafted", 40),
    changes: (c.changes || []).slice(0, 30).map((/** @type {any} */ x) => clean(x, 300)), simulation: { ok: Boolean(c.simulation?.ok), text: clean(c.simulation?.text || "Not simulated.", 300) },
    outward: (c.outward || []).slice(0, 10).map((/** @type {any} */ o) => ({ text: clean(o.text, 300) })),
    names: (c.names || []).slice(0, 10).map((/** @type {any} */ n) => ({ name: clean(n.name, 80), shown: clean(n.shown, 80), flags: (n.flags || []).map((/** @type {any} */ f) => clean(f, 20)) })),
    from_author: quoted(c.fromEngineer?.text ?? c.note, c.fromEngineer?.label || "from the author") };
}

const ADDRESS = /^(vyre:\/\/[^\s]+|line:[^\s#]+#\d+)$/;

/** A memory answer keeps only what has a citation: with none, it is plain words saying so. @param {any} r */
function memoryAnswer(r) {
  const cites = (r.citations || []).map((/** @type {any} */ c) => (typeof c === "string" ? { address: c, label: null } : { address: String(c.source ?? c.address ?? ""), label: c.label ? clean(c.label, 60) : null }))
    .filter((/** @type {any} */ c) => ADDRESS.test(c.address)).slice(0, CAPS.items);
  if (!cites.length) return { kind: "text", text: "I could not find a source for that, so I will not answer it from memory." };
  return { kind: "memory_answer", text: clean(r.text, CAPS.text), citations: cites.map((/** @type {any} */ c) => ({ address: clean(c.address, 200), label: c.label })), labels: r.labels ? labelsOf(r.labels) : null };
}

/** A short plain summary of a result nobody mapped: the names of what it holds, never its values. @param {any} r */
function summary(r) {
  if (r === null || r === undefined) return "Done.";
  if (typeof r !== "object") return clean(r, CAPS.text);
  const keys = Object.keys(r).slice(0, 5);
  return keys.length ? `Done. The result has ${keys.map(k => clean(k, 30)).join(", ")}.` : "Done.";
}

/**
 * @param {string} toolName e.g. "matters.find" @param {any} result @param {{ types?: Record<string, any> }} [ctx] the Space's type definitions, for kind-aware fields
 * @returns {import("./component-kinds.js").Component}
 */
export function toComponent(toolName, result, ctx = {}) {
  const c = build(String(toolName), result, ctx);
  // A component that fails its own check is never shown: the person gets plain words and the producer's bug stays in its tests.
  try { return assertComponent(c); } catch { return { kind: "text", text: "Done." }; }
}

/** @param {string} tool @param {any} r @param {any} ctx @returns {import("./component-kinds.js").Component} */
function build(tool, r, ctx) {
  try {
    if (typeof r === "string") return { kind: "text", text: clean(r, CAPS.text) };
    if (!r || typeof r !== "object") return { kind: "text", text: summary(r) };
    if (r.held === true || r.status === "held" || r.held_for_approval) {
      const t = r.task && typeof r.task === "object" ? r.task : { id: r.task };
      return { kind: "held_for_approval", task: t.id ? clean(t.id, 80) : null, title: clean(t.title || r.title || "An outward act", 120), summary: clean(r.summary || r.payload_summary || "", 400),
        approver: who(r.approver || t.checker || "an approver"), what: "Drafted and waiting for your approval. Nothing has left the Space." };
    }
    if (r.kind === "flow_diff" || (r.changes && r.hash && r.simulation)) return flowDiff(r);
    if (Array.isArray(r.citations) && typeof r.text === "string") return memoryAnswer(r);
    if (r.draft || /(^|\.)draft$/.test(tool) && (r.body || r.text)) return draft(r.draft || r);
    if (r.task && typeof r.task === "object") return taskCard(r.task, r.summary);
    if (r.title && r.doer && r.state) return taskCard(r);
    if (r.record && typeof r.record === "object") return recordCard(r.record, ctx);
    if (Array.isArray(r.records)) {
      if (r.records.length === 1) return recordCard(r.records[0], ctx);
      return { kind: "group", title: r.records.length ? `${r.records.length} records` : "No matching records", items: r.records.slice(0, 10).map((/** @type {any} */ x) => recordCard(x, ctx)) };
    }
    if (r.type && r.data && typeof r.data === "object") return recordCard(r, ctx);
    if (typeof r.text === "string") return { kind: "text", text: clean(r.text, CAPS.text) };
    if (typeof r.error === "string" || r.ok === false) return { kind: "text", text: clean(r.reason || r.error || "That did not go through.", CAPS.text) };
    return { kind: "text", text: summary(r) };
  } catch {
    return { kind: "text", text: "Done." };
  }
}
