// @ts-check
// prompts: the system prompt of the Claude sessions Vyre starts, editable at three levels.
//
// The levels, general to specific: the assistant, a named agent, a project. Each edit is a new
// version, never an overwrite, so a bad edit is undone by reverting to an older one, and the
// revert is itself a version (history only grows).
//
// Two modes. "append" adds the text after Claude Code's own system prompt, which keeps its tool
// use, safety and coding behaviour: the default, and the right choice nearly always. "replace"
// makes the text the whole system prompt. That is for experts, so compose() carries a warning.
// Vyre's own launch text survives both: it is how a session knows it runs under Vyre.

import { redact } from "../transcripts/sanitize.js";

export const PROMPTS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_prompts (
  scope TEXT NOT NULL, version INTEGER NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL,
  by TEXT, note TEXT, at INTEGER NOT NULL, PRIMARY KEY (scope, version))`;

export const MAX_CHARS = 20000;

export const REPLACE_WARNING = "Replacing the system prompt drops Claude Code's own instructions (tool use, safety and coding behaviour), so it is for experts only.";

const MODES = new Set(["append", "replace"]);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A checked scope: "assistant", "agent:<name>" or "project:<slug>". Throws on anything else.
 * @param {unknown} s
 * @returns {string}
 */
export function scopeOf(s) {
  const v = String(s ?? "");
  if (v === "assistant") return v;
  const m = /^(agent|project):(.*)$/.exec(v);
  if (!m) throw new Error(`prompt scope must be "assistant", "agent:<name>" or "project:<slug>", not ${JSON.stringify(v.slice(0, 80))}`);
  if (!NAME.test(m[2])) throw new Error(`the ${m[1]} ${m[1] === "agent" ? "name" : "slug"} in a prompt scope must be 1-64 letters, digits, dots, dashes or underscores`);
  return v;
}

/** @typedef {{ scope: string, version: number, mode: "append"|"replace", text: string, by: string|null, note: string|null, at: number }} PromptRow */

/** @returns {PromptRow} */
const shape = (/** @type {any} */ r) => ({
  scope: String(r.scope), version: Number(r.version), mode: r.mode === "replace" ? "replace" : "append", text: String(r.text),
  by: r.by == null ? null : String(r.by), note: r.note == null ? null : String(r.note), at: Number(r.at),
});

export class Prompts {
  /** @param {import("node:sqlite").DatabaseSync} db @param {() => number} [now] */
  constructor(db, now = () => Date.now()) {
    this.db = db;
    this.now = now;
  }

  /** The latest version of a scope, or null. An empty append text is a clear, still a version. */
  current(scope) {
    const r = this.db.prepare("SELECT * FROM sessions_prompts WHERE scope = ? ORDER BY version DESC LIMIT 1").get(scopeOf(scope));
    return r ? shape(r) : null;
  }

  /**
   * Save a new version. The same text and mode as now is not an edit, so it makes no version.
   * @param {string} scope
   * @param {{ text: string, mode?: "append"|"replace", by?: string|null, note?: string|null }} p
   * @returns {PromptRow & { unchanged?: true }}
   */
  set(scope, { text, mode = "append", by = null, note = null }) {
    const sc = scopeOf(scope);
    if (!MODES.has(mode)) throw new Error(`prompt mode must be "append" or "replace", not ${JSON.stringify(String(mode))}`);
    if (typeof text !== "string") throw new Error("prompt text must be a string");
    if (text.length > MAX_CHARS) throw new Error(`that prompt is ${text.length} characters; the limit is ${MAX_CHARS}`);
    // A replace with nothing in it would send the model no system prompt at all.
    if (mode === "replace" && !text.trim()) throw new Error("a replacing prompt cannot be empty; clear it in append mode instead");
    if (redact(text).text !== text) throw new Error("that looks like it contains a secret; system prompts are sent to the model");
    const cur = this.current(sc);
    if (cur && cur.text === text && cur.mode === mode) return { ...cur, unchanged: true };
    const version = cur ? cur.version + 1 : 1;
    this.db.prepare("INSERT INTO sessions_prompts (scope, version, mode, text, by, note, at) VALUES (?,?,?,?,?,?,?)")
      .run(sc, version, mode, text, by == null ? null : String(by), note == null ? null : String(note), this.now());
    return /** @type {PromptRow} */ (this.current(sc));
  }

  /** Versions of a scope, newest first. */
  history(scope, limit = 20) {
    const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 20));
    return this.db.prepare("SELECT * FROM sessions_prompts WHERE scope = ? ORDER BY version DESC LIMIT ?").all(scopeOf(scope), n).map(shape);
  }

  /** Undo by copying an older version forward as a new one. */
  revert(scope, version, by = null) {
    const sc = scopeOf(scope);
    const old = this.db.prepare("SELECT * FROM sessions_prompts WHERE scope = ? AND version = ?").get(sc, Number(version));
    if (!old) throw new Error(`${sc} has no prompt version ${version}`);
    const o = shape(old);
    const cur = /** @type {PromptRow} */ (this.current(sc));
    this.db.prepare("INSERT INTO sessions_prompts (scope, version, mode, text, by, note, at) VALUES (?,?,?,?,?,?,?)")
      .run(sc, cur.version + 1, o.mode, o.text, by == null ? null : String(by), `revert to v${o.version}`, this.now());
    return /** @type {PromptRow} */ (this.current(sc));
  }

  /**
   * The system prompt for one session.
   * @param {{ agent?: string|null, agentKind?: string|null, project?: string|null, append?: string|null }} [o]
   *   append is Vyre's own launch text: first in append mode, last in replace mode, never dropped
   * @returns {{ mode: "append"|"replace", text: string, parts: { scope: string, version: number, mode: "append"|"replace" }[], warning?: string }}
   */
  compose({ agent = null, agentKind = null, project = null, append = null } = {}) {
    /** @type {string[]} */
    const scopes = [];
    if (!agent || agentKind === "assistant") scopes.push("assistant");
    else scopes.push(scopeOf(`agent:${agent}`));
    if (project) scopes.push(scopeOf(`project:${project}`));
    const rows = scopes.map(s => this.current(s)).filter(r => r && r.text.trim() !== "");
    const levels = /** @type {PromptRow[]} */ (rows);
    const vyre = append && String(append).trim() ? String(append) : null;
    const part = (/** @type {PromptRow} */ r) => ({ scope: r.scope, version: r.version, mode: r.mode });

    let base = -1;
    for (let i = levels.length - 1; i >= 0; i--) if (levels[i].mode === "replace") { base = i; break; }
    if (base < 0) {
      const texts = [...(vyre ? [vyre] : []), ...levels.map(r => r.text)];
      return { mode: "append", text: texts.join("\n\n"), parts: levels.map(part) };
    }
    const used = levels.slice(base);
    const texts = [...used.map(r => r.text), ...(vyre ? [vyre] : [])];
    return { mode: "replace", text: texts.join("\n\n"), parts: used.map(part), warning: REPLACE_WARNING };
  }
}
