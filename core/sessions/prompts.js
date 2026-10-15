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
import { parseRefs, renderForPrompt } from "../../lib/doc-refs.js";

export const PROMPTS_MIGRATION = `CREATE TABLE IF NOT EXISTS sessions_prompts (
  scope TEXT NOT NULL, version INTEGER NOT NULL, mode TEXT NOT NULL, text TEXT NOT NULL,
  by TEXT, note TEXT, at INTEGER NOT NULL, PRIMARY KEY (scope, version))`;

export const MAX_CHARS = 20000;

export const REPLACE_WARNING = "Replacing the system prompt drops Claude Code's own instructions (tool use, safety and coding behaviour), so it is for experts only.";

const MODES = new Set(["append", "replace"]);
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A checked scope: "assistant", "agent:<name>", "project:<slug>" or "capsule" (the Capsule's
 * quick answer, Vyre IQ: iq-prompt.js). Throws on anything else.
 * @param {unknown} s
 * @returns {string}
 */
export function scopeOf(s) {
  const v = String(s ?? "");
  if (v === "assistant" || v === "capsule") return v;
  const m = /^(agent|project):(.*)$/.exec(v);
  if (!m) throw new Error(`prompt scope must be "assistant", "agent:<name>", "project:<slug>" or "capsule", not ${JSON.stringify(v.slice(0, 80))}`);
  if (!NAME.test(m[2])) throw new Error(`the ${m[1]} ${m[1] === "agent" ? "name" : "slug"} in a prompt scope must be 1-64 letters, digits, dots, dashes or underscores`);
  return v;
}

/** @typedef {{ scope: string, version: number, mode: "append"|"replace", text: string, by: string|null, note: string|null, at: number }} PromptRow */

/** @returns {PromptRow} */
const DOC_PROMPT_MAX = 24000;
/** The most distinct references one instructions file has looked up for the prompt. */
export const REFS_MAX = 50;
/**
 * The instructions with each @ or # reference (a markdown link to a vyre:// address, lib/doc-refs.js) turned into a line the model can use, "@Sam (person, vyre://acme/person/p_1)". `canRead` is the caller's
 * read check, asked once per address; a reference it refuses, or one that fails to answer, keeps its name and loses the address, so the prompt never carries what the reader could not open.
 * @param {{ agent?: { name: string, text: string }, project?: { name: string, text: string } } | null | undefined} x
 * @param {(ref: import("../../lib/doc-refs.js").DocRef) => Promise<boolean>} canRead
 */
export async function withRefsResolved(x, canRead) {
  if (!x) return x;
  const known = new Map();
  const ask = async (/** @type {import("../../lib/doc-refs.js").DocRef} */ r) => { if (!known.has(r.urn)) known.set(r.urn, await canRead(r).then(Boolean, () => false)); };
  // at most REFS_MAX distinct addresses are resolved per document (each is a read check, one after another): the rest keep their names, and the prompt says how many
  /** @type {Map<any, number>} */ const left = new Map();
  for (const d of [x.agent, x.project]) if (d && typeof d.text === "string") {
    const asked = new Set();
    for (const r of parseRefs(d.text)) { if (asked.has(r.urn)) continue; if (asked.size >= REFS_MAX) { left.set(d, (left.get(d) || 0) + 1); continue; } asked.add(r.urn); await ask(r); }
  }
  const one = (/** @type {{ name: string, text: string } | undefined} */ d) => (d && typeof d.text === "string" ? { ...d, text: renderForPrompt(d.text, (r) => known.get(r.urn) === true) + (left.get(d) ? `\n\n(${left.get(d)} more references in this file keep only their names: at most ${REFS_MAX} are looked up in one file)` : "") } : d);
  return { ...(x.agent ? { agent: one(x.agent) } : {}), ...(x.project ? { project: one(x.project) } : {}) };
}

/**
 * The instructions blocks of a session's prompt: the agent's AGENTS.md, then the project's. Each is the file's words under one line that says whose they are; a long one is cut with a pointer to the file.
 * @param {{ agent?: { name: string, text: string }, project?: { name: string, text: string } } | null | undefined} x
 * @returns {string[]}
 */
export function instructionBlocks(x) {
  /** @type {string[]} */ const out = [];
  const add = (/** @type {string} */ head, /** @type {{ name: string, text: string } | undefined} */ d) => {
    const t = d && typeof d.text === "string" ? d.text.trim() : "";
    if (t) out.push(`${head} (its AGENTS.md):\n\n${t.length > DOC_PROMPT_MAX ? t.slice(0, DOC_PROMPT_MAX).replace(/\s+\S*$/, "") + "\n\n(cut here: the rest is in the file)" : t}`);
  };
  if (x) { add(`Instructions for you, the agent "${x.agent && x.agent.name}"`, x.agent); add(`Instructions for the project "${x.project && x.project.name}"`, x.project); }
  return out;
}

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
   * @param {{ agent?: string|null, agentKind?: string|null, project?: string|null, append?: string|null, environment?: string|null, context?: string|null, instructions?: { agent?: { name: string, text: string }, project?: { name: string, text: string } } | null }} [o]
   *   append is Vyre's own launch text: first in append mode, last in replace mode, never dropped
   *   environment (environment.js) is layer one and context (the project's own, for a driver with no SessionStart hook) layer three: the environment is always there, even when a
   *   prompt replaces Claude Code's own (a replacing prompt replaces only the role layer), and the context comes last. The role layer is the launch text and the prompt levels.
   * @returns {{ mode: "append"|"replace", text: string, parts: { scope: string, version: number, mode: "append"|"replace" }[], warning?: string }}
   */
  compose({ agent = null, agentKind = null, project = null, append = null, environment = null, context = null, instructions = null } = {}) {
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
    const env = environment && String(environment).trim() ? [String(environment)] : [];
    const ctx = context && String(context).trim() ? [String(context)] : [];
    // the agent's and the project's own AGENTS.md, in the words of the file: every provider is told them here, whatever its CLI reads on its own
    const docs = instructionBlocks(instructions);
    if (base < 0) {
      const texts = [...env, ...(vyre ? [vyre] : []), ...levels.map(r => r.text), ...docs, ...ctx];
      return { mode: "append", text: texts.join("\n\n"), parts: levels.map(part) };
    }
    const used = levels.slice(base);
    const texts = [...env, ...used.map(r => r.text), ...(vyre ? [vyre] : []), ...docs, ...ctx];
    return { mode: "replace", text: texts.join("\n\n"), parts: used.map(part), warning: REPLACE_WARNING };
  }
}
