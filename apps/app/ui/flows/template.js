// @ts-check
// The pure half of the template composer: the {object.field} tokens in a message, the list a person inserts from, the preview and the text-message count.
// A token is stored as written ("Hello {client.first_name}") and read when the step runs; the engine's own half is kernel/flows/expr.js, not touched here.
import { flat } from "./tree.js";
import { isRecordTrigger } from "./logic.js";

/** @typedef {import("./logic.js").Draft} Draft */
/** @typedef {import("./logic.js").Options} Options */
/** @typedef {{ token: string, label: string, sealed?: boolean, known: boolean, note?: string, address?: boolean }} Item  `address`: the field holds an email address, so it suits To, From, CC and Reply-To */
/** @typedef {{ title: string, items: Item[], object?: string }} Group  `object`: the object's own label, shown before a field in a chip */

export const TOKEN_RE = /\{([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)\}/gi;

/** The text as pieces: plain words and tokens. @param {string} text @returns {({ text: string } | { token: string, path: string })[]} */
export function parseTemplate(text) {
  const s = String(text ?? "");
  /** @type {any[]} */ const out = [];
  let at = 0;
  for (const m of s.matchAll(TOKEN_RE)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    out.push({ token: m[0], path: m[1] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

/** Just the tokens, in order. @param {string} text */
export const tokensOf = (text) => /** @type {{ token: string, path: string }[]} */ (parseTemplate(text).filter((p) => "token" in p));

/** Helper values a message can use, by token. `engine` is true only for those the Flow engine resolves today; the rest are listed and marked. */
export const HELPERS = /** @type {{ token: string, label: string, engine: boolean }[]} */ ([
  { token: "{now.date}", label: "Today's date", engine: false },
  { token: "{now.time}", label: "The current time", engine: false },
  { token: "{now.plus_1_days}", label: "Tomorrow", engine: false },
  { token: "{now.plus_7_days}", label: "A week from now", engine: false },
  { token: "{run.number}", label: "The run number", engine: false },
  { token: "{flow.name}", label: "The Flow's name", engine: false },
  { token: "{approver.name}", label: "The approver's name", engine: false },
  { token: "{space.name}", label: "The Space's name", engine: false },
  { token: "{me.name}", label: "Your name", engine: false },
]);

/** Sealed field names come as `sealed: true` on a field. @param {{ name: string, label: string, sealed?: boolean }} f */
const sealedOf = (f) => f.sealed === true;
/** Whether a field holds an email address: its type says so, or its name ends in email. @param {{ name: string, type?: string }} f */
const isAddress = (f) => f.type === "email" || /(^|_)email$/i.test(f.name);

/**
 * What a box can insert, in the order a person looks for it: each object in this Flow's context with its fields (the record that started the Flow, then the records earlier steps made),
 * the earlier steps' outputs, then the helper values. `engineHas` lists the helper tokens the engine resolves; others are marked "Not available yet".
 * @param {Draft} d @param {string} stepId @param {Options} o @param {{ engineHas?: string[] }} [opt] @returns {Group[]}
 */
export function insertList(d, stepId, o, opt = {}) {
  /** @type {Group[]} */ const out = [];
  const t = d.trigger;
  const fieldsOf = (/** @type {string} */ type) => o.types.find((x) => x.name === type)?.fields || [];
  const labelOf = (/** @type {string} */ type) => o.types.find((x) => x.name === type)?.label || type;
  const item = (/** @type {string} */ token, /** @type {string} */ label, /** @type {any} */ f) => /** @type {Item} */ ({ token, label, known: true, ...(f && sealedOf(f) ? { sealed: true, note: "Sent only where the step allows sealed values" } : {}), ...(f && isAddress(f) ? { address: true } : {}) });
  if (isRecordTrigger(t) && t.type) out.push({ object: labelOf(t.type), title: `${labelOf(t.type)} (the record that started the Flow)`, items: fieldsOf(t.type).map((f) => item(`{after.${f.name}}`, f.label, f)) });
  else if (t.kind === "form" || t.kind === "signup") out.push({ title: "The form", items: ["name", "email", "phone", "message"].map((f) => item(`{${f}}`, `${f[0].toUpperCase()}${f.slice(1)}`, { name: f })) });
  /** @type {Item[]} */ const steps = [];
  for (const s of flat(d.steps)) {
    if (s.id === stepId) break;
    if (s.kind === "create" || s.kind === "upsert") {
      out.push({ object: labelOf(s.type), title: `${labelOf(s.type)} made by ${s.id}`, items: [item(`{steps.${s.id}.record.id}`, "The record itself", null), ...fieldsOf(s.type).map((f) => item(`{steps.${s.id}.record.data.${f.name}}`, f.label, f))] });
    }
    if (s.kind === "find") steps.push(item(`{steps.${s.id}.rows}`, `The records found by ${s.id}`, null));
    if (s.kind === "formula") steps.push(item(`{steps.${s.id}.value}`, `The value worked out by ${s.id}`, null));
    if (s.kind === "classify") steps.push(item(`{steps.${s.id}.label}`, `The group picked by ${s.id}`, null));
  }
  if (steps.length) out.push({ title: "Earlier steps", items: steps });
  const has = new Set(opt.engineHas || []);
  out.push({ title: "Helpful values", items: HELPERS.map((h) => ({ token: h.token, label: h.label, known: h.engine || has.has(h.token), ...(h.engine || has.has(h.token) ? {} : { note: "Not available yet" }) })) });
  return out;
}

/** The words for one token path, from the insert list. @param {string} path @param {Group[]} groups */
export function tokenLabel(path, groups) {
  const tok = `{${path}}`;
  for (const g of groups) { const it = g.items.find((x) => x.token === tok); if (it) return g.object ? `${g.object} \u00b7 ${it.label}` : it.label; }
  return path;
}

/** Whether a token is on the insert list and can be resolved. @param {string} path @param {Group[]} groups */
export const tokenKnown = (path, groups) => groups.some((g) => g.items.some((x) => x.token === `{${path}}` && x.known));

/** Tokens in the text that nothing on the list explains, so the person sees a mistake before it runs. @param {string} text @param {Group[]} groups */
export const unknownTokens = (text, groups) => tokensOf(text).filter((t) => !tokenKnown(t.path, groups)).map((t) => t.token);

/** The text with every token swapped for a sample value; one with no sample shows its label in brackets. @param {string} text @param {Record<string, string>} sample @param {Group[]} groups */
export function renderPreview(text, sample, groups = []) {
  return parseTemplate(text).map((p) => ("token" in p ? (p.path in sample ? String(sample[p.path]) : `[${tokenLabel(p.path, groups)}]`) : p.text)).join("");
}

/** When the text ends inside an open brace ("Hello {cl"), the part typed after it; otherwise null. This is what opens the autocomplete. @param {string} text @returns {string | null} */
export function openBrace(text) {
  const s = String(text ?? "");
  const i = s.lastIndexOf("{");
  if (i < 0 || s.indexOf("}", i) >= 0) return null;
  const q = s.slice(i + 1);
  return /^[a-z0-9_.]*$/i.test(q) ? q : null;
}

/** The text with the open brace finished as the chosen token. @param {string} text @param {string} token */
export function completeBrace(text, token) {
  const s = String(text ?? "");
  const i = s.lastIndexOf("{");
  return i < 0 || s.indexOf("}", i) >= 0 ? `${s}${token}` : `${s.slice(0, i)}${token}`;
}

/** What matches a typed start, over the whole list. @param {Group[]} groups @param {string} q */
export function suggest(groups, q) {
  const n = q.toLowerCase();
  return groups.flatMap((g) => g.items).filter((i) => !n || i.token.toLowerCase().includes(n) || i.label.toLowerCase().includes(n)).slice(0, 8);
}

/** Add a token where the text ends, with a space before it when one is needed. @param {string} text @param {string} token */
export const appendToken = (text, token) => `${text}${text && !/\s$/.test(text) ? " " : ""}${token}`;

/** Characters and how many text-message segments they make (160 for plain text, 70 for any other character; longer ones are split into 153 and 67). @param {string} text */
export function smsCount(text) {
  const s = String(text ?? "");
  const chars = [...s].length;
  const plain = /^[\x20-\x7e\n\r£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ\u00a7¿äöñüà]*$/.test(s);
  const one = plain ? 160 : 70, many = plain ? 153 : 67;
  return { chars, segments: chars === 0 ? 0 : chars <= one ? 1 : Math.ceil(chars / many), unicode: !plain };
}

/** A small history for Undo: push each change, step back with undo. @param {string} first */
export function history(first) {
  /** @type {string[]} */ const past = [];
  let now = first;
  return {
    get value() { return now; },
    get canUndo() { return past.length > 0; },
    push(/** @type {string} */ v) { if (v === now) return now; past.push(now); if (past.length > 100) past.shift(); now = v; return now; },
    undo() { if (past.length) now = /** @type {string} */ (past.pop()); return now; },
  };
}

/** Addresses a To, From, CC or Reply-To box can offer first: every email-type field of the objects in context, by its own label and object. @param {Group[]} groups @returns {Item[]} */
export const addressPicks = (groups) => groups.flatMap((g) => g.items.filter((i) => i.address).map((i) => ({ ...i, label: `${i.label} (${g.title.replace(/ \(the record that started the Flow\)$/, "")})` })));
