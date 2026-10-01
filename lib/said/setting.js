// @ts-check
// setting: the person's own words "use Sonnet by default" or "turn off learning" as kind
// "setting" intents, for settings.request (an agent changes a setting only when the person asked
// for exactly that change).
//
// The intent's one `to` names the key, the canonical value and the level, so a yes for one value
// cannot be spent on another, nor a project's setting on the account's:
//   <key>=<JSON value>@account          <key>=<JSON value>@project/<slug>
// settingTo() builds it, and settings.request builds the call's string with the same function, so
// the two sides cannot drift.
//
// Deterministic, from the person's unquoted plain asks only (askClauses: no question, condition,
// standing permission or pasted text), 15 minutes, one use. Keys, types, choices and levels come
// from the settings manifest the caller passes (settings.schema's `keys`); a setting that is not
// in it, is secret, cannot be set at the level asked, is named ambiguously, or whose value does not
// parse and fit its type records nothing. A device or session level is never recorded here.

import { asks, numbers } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const VERBS = V("turn|enable|disable|switch|set|change|use|make|stop|start|deactivate|activate");
const ON = /\b(turn\s+on|switch\s+on|enable|activate)\b/i;
const OFF = /\b(turn\s+off|switch\s+off|disable|deactivate)\b/i;
const NOT_MODEL = new Set("it this that them the a an one another different default new old other something anything best better faster cheaper".split(" "));
const STOP = new Set("the and for with that this your our all any into from".split(" "));
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}_@-])${esc(word)}($|[^\\p{L}\\p{N}_@-])`, "iu").test(text);

/** @param {any} v */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * The one string a setting intent and the matching settings.request call share (platform's
 * format, one function for both sides):
 *   <key>=<canonical JSON value>@<level>[/<project|device|session id>]     a change
 *   <key>=reset@<level>[/<id>]                                              clearing it
 * The canonical value is JSON with object keys sorted. This recorder only ever writes the account
 * and project levels and never a reset; settings.request needs the rest.
 * @param {{ key: string, value?: any, reset?: boolean, level: string, target?: string | null }} c
 * @returns {string}
 */
export function settingTo(c) {
  const v = c.reset === true || c.value === undefined ? "reset" : canon(c.value);
  return `${c.key}=${v}@${c.level}${c.target ? `/${c.target}` : ""}`;
}

/**
 * A value as the setting's type holds it, from the person's words, or undefined.
 * @param {any} d @param {string} clause
 */
function valueOf(d, clause) {
  const low = clause.toLowerCase();
  switch (d.type) {
    case "bool": {
      const on = ON.test(clause), off = OFF.test(clause) || /\boff\b/i.test(clause);
      if (on !== off) return on;
      const m = /\bto\s+(on|off|true|false|yes|no)\b/i.exec(clause);
      return m ? ["on", "true", "yes"].includes(m[1].toLowerCase()) : undefined;
    }
    case "int": case "number": {
      const ns = numbers(clause);
      if (ns.length !== 1) return undefined;
      const n = ns[0];
      if (d.type === "int" && !Number.isInteger(n)) return undefined;
      if (typeof d.min === "number" && n < d.min) return undefined;
      if (typeof d.max === "number" && n > d.max) return undefined;
      if (Array.isArray(d.choices) && !d.choices.includes(n)) return undefined;
      return n;
    }
    case "enum": {
      const hit = (d.enum || []).filter(v => has(low, String(v).toLowerCase()) || (d.labels && d.labels[v] && has(low, String(d.labels[v]).toLowerCase())));
      return hit.length === 1 ? String(hit[0]) : undefined;
    }
    case "model": {
      const m = /\b(?:to|use)\s+([A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99})/i.exec(clause);
      return m && /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(m[1]) && !NOT_MODEL.has(m[1].toLowerCase()) ? m[1].toLowerCase() : undefined;
    }
  }
  return undefined; // strings, lists and objects are never recorded from a sentence
}

/**
 * @typedef {{ key: string, label?: string, type: string, enum?: string[], labels?: Record<string,string>, choices?: number[], min?: number, max?: number, levels?: string[], secret?: boolean }} Decl
 * @param {string} text the turn as typed
 * @param {Decl[]} manifest settings.schema's keys
 * @param {{ project?: string }} [where] the thread's project, for "in this project"
 * @returns {{ intents: any[], skipped: { reason: string }[] }}
 */
export function settingIntents(text, manifest, where = {}) {
  const intents = [], skipped = [];
  const decls = (Array.isArray(manifest) ? manifest : []).filter(d => d && typeof d.key === "string" && d.label && !d.secret);
  if (!decls.length) return { intents, skipped };
  // A setting is named by its label as a phrase ("lock when the Mac sleeps"). The labels are masked out of the words first,
  // so a label that holds a condition word ("when") or a verb is never mistaken for the person's own wording; longest first,
  // so "Helper model" is taken before "model".
  const order = [...decls].sort((p, q) => String(q.label).length - String(p.label).length);
  const names = new Map();
  let masked = String(text ?? "");
  for (const d of order) {
    const id = `\u27e6${names.size}\u27e7`;
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:(?:the|my)\\s+)?${esc(String(d.label).trim()).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}_])`, "giu");
    const next = masked.replace(re, id);
    if (next !== masked) { names.set(id, d); masked = next; }
  }
  const seen = new Set();
  for (const { clause } of askClauses(masked)) {
    if (!asks(clause.replace(/\u27e6\d+\u27e7/g, " "), VERBS)) continue;
    if (/\b(device|session|this\s+(?:chat|thread|conversation)|just\s+(?:this|now)|for\s+now|right\s+now)\b/i.test(clause)) { skipped.push({ reason: "level_unsupported" }); continue; }
    const project = /\b(?:in|for|on)\s+(?:this|the\s+current)\s+project\b/i.test(clause);
    if (project && !where.project) { skipped.push({ reason: "no_project" }); continue; }
    const level = project ? "project" : "account";
    const found = [...new Set(clause.match(/\u27e6\d+\u27e7/g) || [])].map(id => names.get(id)).filter(Boolean);
    let hits = found.filter(d => !Array.isArray(d.levels) || d.levels.includes(level));
    const plain = clause.replace(/\u27e6\d+\u27e7/g, " ").replace(/\s+/g, " ");
    // "use Sonnet by default": no label, so the one model setting that is the default.
    if (!found.length && /\buse\s+\S+\s+by\s+default\b/i.test(plain)) hits = decls.filter(d => d.type === "model" && /default/i.test(`${d.key} ${d.label}`) && (!Array.isArray(d.levels) || d.levels.includes(level)));
    if (hits.length !== 1 || found.length > 1) { skipped.push({ reason: hits.length > 1 || found.length > 1 ? "ambiguous_setting" : "no_setting" }); continue; }
    const d = hits[0];
    const value = valueOf(d, plain);
    if (value === undefined) { skipped.push({ reason: "no_value" }); continue; }
    const to = settingTo({ key: d.key, value, level, target: project ? where.project : null });
    if (seen.has(to)) continue;
    seen.add(to);
    intents.push({ ...actIntent(to, "change a setting", null), kind: "setting" });
  }
  return { intents, skipped };
}
