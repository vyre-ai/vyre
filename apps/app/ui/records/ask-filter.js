// @ts-check
// "Say what you want to see": a sentence turned into the filters a person could have built by hand: a word that is one of a choice or stage field's options ("clients", "lead"), "my" for the type's person field,
// a day range ("this month", "today", "this week", "last 7 days") on the date field the sentence names or the type's usual one. What it cannot place stays a search; what it understood is said back, so nothing
// is hidden. No model is asked: a sentence it cannot use costs nothing and changes nothing but the search.

import { normalizeKind } from "../fields/logic.js";
import { CREATED, datePreset } from "./listfilter.js";

const STOP = new Set(["show", "me", "all", "the", "of", "and", "with", "who", "that", "have", "has", "are", "is", "a", "an", "in", "for", "to", "list", "see", "find", "my", "mine", "this", "last"]);
const RANGES = /** @type {[string, RegExp][]} */ ([["last7", /\blast 7 days\b/], ["today", /\btoday\b/], ["week", /\bthis week\b/], ["month", /\bthis month\b/]]);
const DATE_FIRST = ["due", "close_date", "date", "starts_at", "start", "deadline"];
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** @param {any} def @param {string} text */
const dateFieldFor = (def, text) => {
  const dates = (def.fields || []).filter((/** @type {any} */ f) => ["date", "datetime"].includes(normalizeKind(f.kind)));
  const named = dates.find((/** @type {any} */ f) => new RegExp(`\\b${esc(String(f.label || f.name).toLowerCase())}\\b`).test(text));
  if (named) return named.name;
  if (/\b(created|added|new)\b/.test(text)) return CREATED.name;
  const usual = DATE_FIRST.map((n) => dates.find((/** @type {any} */ f) => f.name === n)).find(Boolean);
  return (usual || dates[0] || {}).name;
};

/**
 * @param {string} sentence @param {any} def the type @param {{ me?: string, now?: number }} [o]
 * @returns {{ chips: { field: string, op: string, operand?: any }[], query: string, said: string[], unused: string[] }}
 */
export function parseAsk(sentence, def, o = {}) {
  let text = ` ${String(sentence || "").toLowerCase().replace(/[?!.,]/g, " ")} `.replace(/\s+/g, " ");
  /** @type {{ field: string, op: string, operand?: any }[]} */ const chips = [];
  /** @type {string[]} */ const said = [];
  const take = (/** @type {RegExp} */ re) => { const m = re.exec(text); if (m) text = text.replace(re, " "); return m; };
  for (const [id, re] of RANGES) {
    if (!take(re)) continue;
    const field = dateFieldFor(def, text);
    if (field) { chips.push({ field, op: "between", operand: datePreset(id, o.now ?? Date.now()) }); said.push(id === "last7" ? "last 7 days" : id === "today" ? "today" : `this ${id}`); }
    break;
  }
  if (/\b(my|mine)\b/.test(text) && o.me) {
    const who = (def.fields || []).filter((/** @type {any} */ f) => normalizeKind(f.kind) === "actor");
    const f = who.find((/** @type {any} */ x) => x.name === "owner") || who[0];
    if (f) { chips.push({ field: f.name, op: "is", operand: o.me }); said.push(`${f.label || f.name} is you`); text = text.replace(/\b(my|mine)\b/, " "); }
  }
  const used = new Set();
  for (const f of def.fields || []) {
    if (!["choice", "stage"].includes(normalizeKind(f.kind)) || used.has(f.name)) continue;
    for (const opt of f.options || []) {
      const re = new RegExp(`\\b${esc(String(opt).toLowerCase())}(?:s|es)?\\b`);
      if (!take(re)) continue;
      chips.push({ field: f.name, op: "is", operand: opt }); said.push(`${f.label || f.name} is ${opt}`); used.add(f.name);
      break;
    }
  }
  /** @type {string[]} */ const unused = [];
  const neg = /\b(?:with no|without|no)\s+([a-z ]+?)(?=\s(?:this|last|in|on)\b|$)/.exec(text.trim());
  if (neg) { unused.push(`"no ${neg[1].trim()}" (a filter for what is empty is not offered yet)`); text = text.replace(neg[0], " "); }
  const query = text.split(" ").filter((w) => w && !STOP.has(w)).join(" ");
  return { chips, query, said, unused };
}

/** A sentence this type can answer, for the "Try" chip: its first choice or stage option and, when it has a date, "this month" ("lead this month"); "" when it has neither. @param {any} def */
export function askExample(def) {
  const fields = def.fields || [];
  const f = fields.find((/** @type {any} */ x) => ["choice", "stage"].includes(normalizeKind(x.kind)) && Array.isArray(x.options) && x.options.length);
  const hasDate = fields.some((/** @type {any} */ x) => ["date", "datetime"].includes(normalizeKind(x.kind)));
  return [f ? String(f.options[0]).toLowerCase() : "", hasDate ? "this month" : ""].filter(Boolean).join(" ");
}
