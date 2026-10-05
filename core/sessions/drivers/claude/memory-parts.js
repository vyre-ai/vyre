// @ts-check
// The Claude adapter's reading side (core/sessions/drivers/<provider>, team/0.3/DESIGN-provider-adapter.md): where a session's transcript is, what is in it as neutral turns, which native
// session a Vyre thread is running, how much of the window a session or an event used, and what a hook says. Chat's adapter index spreads these into the provider object; callers outside the
// drivers ask the adapter, never the files.
import { find, read } from "./transcripts.js";
import { lastUsage } from "./usage.js";
import { windowFor } from "../windows.js";
import { hookIn, hookOut } from "./hooks.js";

/**
 * The transcript of a native session, or null: where it is and its format. `folders` are the transcript folders configured for the account.
 * @param {string} nativeId @param {string[]} folders
 * @returns {{ file: string, format: "claude-jsonl" } | null}
 */
export function transcriptOf(nativeId, folders) {
  const t = find(folders || [], String(nativeId));
  return t && t.file ? { file: t.file, format: "claude-jsonl" } : null;
}

/**
 * A transcript as neutral turns: { turn, who, text, tools, at }, in order. A tool is { kind: file|read|commit|url, ref }. An unreadable file is [].
 * @param {string} file
 * @returns {{ turn: number, who: "user"|"assistant", text: string, tools: { kind: string, ref: string }[], at: number, model?: string }[]}
 */
export function readTranscript(file) {
  const t = read(file);
  if (!t) return [];
  return t.turns.map((/** @type {any} */ x) => ({ turn: x.seq, who: x.role, text: x.text, tools: Array.isArray(x.links) ? x.links.map((/** @type {any} */ l) => ({ kind: String(l.kind), ref: String(l.ref) })) : [], at: x.ts, ...(x.model ? { model: x.model } : {}) }));
}

/**
 * The provider's own session id for a Vyre thread: for Claude a thread keeps its own id until its first roll, after which the newest native id is kept with it (a session id names one transcript).
 * @param {{ id: string, native?: string|null }} thread
 */
export const nativeIdOf = thread => (thread && (thread.native || thread.id)) || null;

/**
 * How many tokens a session or a result used, and how much of its window that is. A string is a transcript file (the last request's count); an object is a result event
 * ({ usage: { input_tokens, ... }, total_cost_usd, model }). Null when nothing is known.
 * @param {string | Record<string, any>} what
 * @returns {{ tokens: number, cost_usd?: number, context?: number, limit?: number } | null}
 */
export function usageOf(what) {
  if (typeof what === "string") {
    const u = lastUsage(what);
    return u ? { tokens: u.used, context: u.used, limit: windowFor(u.model, "claude") } : null;
  }
  const u = what && what.usage;
  if (!u || typeof u !== "object") return null;
  const n = (/** @type {unknown} */ v) => (typeof v === "number" && v >= 0 ? v : 0);
  const tokens = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens);
  return { tokens, ...(typeof what.total_cost_usd === "number" ? { cost_usd: what.total_cost_usd } : {}), ...(typeof what.model === "string" ? { limit: windowFor(what.model, "claude") } : {}) };
}

export { hookIn, hookOut };
