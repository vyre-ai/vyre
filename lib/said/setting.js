// @ts-check
// setting: the person's own words "use Sonnet by default" or "turn off learning" as kind
// "setting" intents, for settings.request (an agent changes a setting only when the person asked
// for exactly that change).
//
// The intent's one `to` names the key, the canonical value and the level, so a yes for one value
// cannot be spent on another, nor a project's setting on the account's:
//   setting:<key>=<JSON value>@account
//   setting:<key>=<JSON value>@project:<slug>
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

/**
 * The string a setting intent and the matching call share.
 * @param {string} key @param {any} value @param {{ level?: string, project?: string }} [at]
 */
export function settingTo(key, value, { level = "account", project } = {}) {
  return `setting:${key}=${JSON.stringify(value)}@${level === "project" ? `project:${project}` : level}`;
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
  const seen = new Set();
  for (const { clause } of askClauses(text)) {
    if (!asks(clause, VERBS)) continue;
    if (/\b(device|session|this\s+(?:chat|thread|conversation)|just\s+(?:this|now)|for\s+now|right\s+now)\b/i.test(clause)) { skipped.push({ reason: "level_unsupported" }); continue; }
    const project = /\b(?:in|for|on)\s+(?:this|the\s+current)\s+project\b/i.test(clause);
    if (project && !where.project) { skipped.push({ reason: "no_project" }); continue; }
    const level = project ? "project" : "account";
    const ok = decls.filter(d => !Array.isArray(d.levels) || d.levels.includes(level));
    const wordsOf = d => String(d.label).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !STOP.has(w));
    let hits = ok.filter(d => { const w = wordsOf(d); return w.length && w.every(x => has(clause, x)); });
    if (hits.length > 1) {
      const top = Math.max(...hits.map(d => wordsOf(d).length));
      hits = hits.filter(d => wordsOf(d).length === top);
    }
    // "use Sonnet by default": no label, so the one model setting that is the default.
    if (!hits.length && /\buse\s+\S+\s+by\s+default\b/i.test(clause)) hits = ok.filter(d => d.type === "model" && /default/i.test(`${d.key} ${d.label}`));
    if (hits.length !== 1) { skipped.push({ reason: hits.length ? "ambiguous_setting" : "no_setting" }); continue; }
    const d = hits[0];
    const value = valueOf(d, clause);
    if (value === undefined) { skipped.push({ reason: "no_value" }); continue; }
    const to = settingTo(d.key, value, { level, project: where.project });
    if (seen.has(to)) continue;
    seen.add(to);
    intents.push({ ...actIntent(to, "change a setting", null), kind: "setting" });
  }
  return { intents, skipped };
}
