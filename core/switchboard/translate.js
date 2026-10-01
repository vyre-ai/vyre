// @ts-check
// translate: what one line of Claude Code's stream-json output means to a surface.
//
// Claude Code with `--output-format stream-json --include-partial-messages --verbose` writes a
// line per thing that happens: system notices, partial deltas, whole assistant messages, tool
// results, permission requests and a result per turn. Most of it is for Claude Code's own SDK.
// A surface needs much less: the text as it grows, which tools ran, when a turn ended, and what
// it was asked. This file is the whole mapping, pure, so it can be tested line by line against
// what a real `claude` printed.
//
// Events stay small (spec 6, the brief): no whole tool inputs or outputs, no hook output (the
// user's own hooks print whatever they like, personal things included). Thinking is shown as
// Claude Code shows it, as its own event (thread.thinking), capped like text.
//
// An ask is richer, because a person has to judge it: a question's options, or the command, file
// and change a permission is for. That goes into the ask's row (threads.asks), redacted and
// capped, never into an event.

import { redact } from "../transcripts/sanitize.js";

const CUT = 200;

/** @param {unknown} v @param {number} [n] */
export const cut = (v, n = CUT) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** A string for an ask: secrets redacted, then capped. Whitespace is kept, a diff needs it. */
export const clip = (v, n) => {
  const s = typeof v === "string" ? redact(v).text : "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

/** Caps from the chat contract (ADR 0024). */
export const CAPS = { question: 1000, header: 200, label: 200, description: 1000, preview: 8000, detail: 8000, questions: 4, options: 8, answer: 200 };

/**
 * AskUserQuestion's questions as a person reads them: at most 4, 8 options each, every string
 * redacted and capped. A preview is kept only when there is one.
 * @param {any} input
 */
export function questionsOf(input) {
  const qs = Array.isArray(input && input.questions) ? input.questions : [];
  return qs.slice(0, CAPS.questions).map(q => ({
    question: clip(q && q.question, CAPS.question),
    header: clip(q && q.header, CAPS.header),
    multiSelect: Boolean(q && q.multiSelect),
    options: (Array.isArray(q && q.options) ? q.options : []).slice(0, CAPS.options).map(o => ({
      label: clip(o && o.label, CAPS.label),
      description: clip(o && o.description, CAPS.description),
      ...(o && typeof o.preview === "string" && o.preview ? { preview: clip(o.preview, CAPS.preview) } : {}),
    })),
  }));
}

/** Any value with its strings redacted and capped, bounded in depth and breadth. */
function scrub(v, depth = 0) {
  if (typeof v === "string") return clip(v, CAPS.detail);
  if (v === null || typeof v !== "object") return v;
  if (depth >= 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 50).map(x => scrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v).slice(0, 50).map(([k, x]) => [k, scrub(x, depth + 1)]));
}

/**
 * What a permission is for, in the fields a card shows: a command, a file and its change, a URL,
 * or the whole input (scrubbed) for any other tool.
 * @param {string} tool @param {Record<string, any>} input
 */
export function detailOf(tool, input = {}) {
  const i = input || {};
  const d = /** @type {Record<string, any>} */ ({});
  const put = (k, v) => { if (typeof v === "string" && v !== "") d[k] = clip(v, CAPS.detail); };
  if (tool === "Bash") { put("command", i.command); put("description", i.description); return d; }
  if (tool === "Edit") { put("file", i.file_path); put("old", i.old_string); put("new", i.new_string); return d; }
  if (tool === "Write") { put("file", i.file_path); put("content", i.content); return d; }
  if (tool === "Read") { put("file", i.file_path); return d; }
  if (tool === "NotebookEdit") { put("file", i.notebook_path); put("new", i.new_source); return d; }
  if (tool === "MultiEdit") { put("file", i.file_path); d.input = scrub({ edits: i.edits }); return d; }
  if (tool === "WebFetch") { put("url", i.url); put("description", i.prompt); return d; }
  d.input = scrub(i);
  return d;
}

/** Where a sending tool keeps its destination, in the order worth showing (as core/harness/rules.js). */
const DEST_KEYS = ["to", "channel", "channel_id", "recipient", "recipients", "email", "thread_id", "chat_id", "user", "url"];

/**
 * A tool call as one line a person can judge, and where it goes. Never the whole input: a Write's
 * content or an Edit's replacement can be the size of a file, and may hold anything.
 * @param {string} tool @param {Record<string, any>} input
 * @returns {{ summary: string, destination: string|null }}
 */
export function describe(tool, input = {}) {
  const i = input || {};
  // A command can carry a token (curl -H "Authorization: ..."), and the summary is shown on every device.
  if (tool === "Bash") return { summary: cut(clip(String(i.command ?? ""), 4000)), destination: null };
  if (["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) {
    const file = i.file_path || i.notebook_path || "";
    return { summary: `${tool} ${cut(file)}`, destination: file ? String(file) : null };
  }
  if (tool === "WebFetch") return { summary: `fetch ${cut(i.url)}`, destination: i.url ? cut(i.url) : null };
  if (tool === "WebSearch") return { summary: `search ${cut(i.query)}`, destination: null };
  if (tool === "Glob" || tool === "Grep") return { summary: `${tool} ${cut(i.pattern)}${i.path ? " in " + cut(i.path, 80) : ""}`, destination: null };
  const dest = DEST_KEYS.map(k => i[k]).find(v => v != null && v !== "");
  const destination = dest == null ? null : cut(Array.isArray(dest) ? dest.join(", ") : dest);
  const firstString = Object.entries(i).find(([, v]) => typeof v === "string");
  return { summary: cut(`${tool}${firstString ? ` ${firstString[0]}: ${firstString[1]}` : ""}`), destination };
}

/** What a tool call does, for a card's icon and verb: the kinds a surface draws. Anything else is "other". */
export const TOOL_KINDS = ["read", "edit", "write", "run", "search", "fetch", "mcp", "task", "other"];
const CLAUDE_KIND = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit", NotebookEdit: "edit", Grep: "search", Glob: "search", Bash: "run", WebFetch: "fetch", WebSearch: "fetch", Task: "task", Agent: "task" };

/**
 * A tool call's kind and, where it has them, its path, command and query (redacted and capped, as
 * describe() does). `hint`: a provider's own kind when it said one (ACP: delete and move are edits).
 * @param {string} tool @param {Record<string, any>} input @param {string} [hint]
 * @returns {{ kind: string, path?: string, command?: string, query?: string }}
 */
export function toolFields(tool, input = {}, hint) {
  const i = input || {};
  const kind = TOOL_KINDS.includes(String(hint)) ? String(hint) : CLAUDE_KIND[tool] || (String(tool).startsWith("mcp__") ? "mcp" : "other");
  const out = /** @type {{ kind: string, path?: string, command?: string, query?: string }} */ ({ kind });
  const path = i.file_path || i.notebook_path || (kind !== "run" ? i.path : "") || "";
  if (typeof path === "string" && path && ["read", "edit", "write", "search"].includes(kind)) out.path = cut(clip(path, 500), 300);
  if (typeof i.command === "string" && i.command && kind === "run") out.command = cut(clip(i.command, 4000), 1000);
  const q = i.query || (kind === "search" ? i.pattern : "");
  if (typeof q === "string" && q && ["search", "fetch"].includes(kind)) out.query = cut(clip(q, 500), 300);
  else if (typeof i.url === "string" && i.url && kind === "fetch") out.query = cut(clip(i.url, 500), 300);
  return out;
}

/**
 * A plan's items as a card draws them: a todo list or an agent's plan entries, each pending,
 * running or done. Claude's TodoWrite says in_progress and completed; ACP's plan says the same.
 * @param {any} list @returns {{ text: string, status: "pending"|"running"|"done" }[]}
 */
export function planItems(list) {
  return (Array.isArray(list) ? list : []).slice(0, 50).map(x => {
    const st = String(x && x.status || "pending");
    return { text: cut(clip(String(x && (x.content ?? x.text ?? x.activeForm) || ""), 1000), 500), status: /** @type {"pending"|"running"|"done"} */ (st === "in_progress" || st === "running" ? "running" : st === "completed" || st === "done" ? "done" : "pending") };
  });
}

/**
 * One stream-json message, as the thread events it stands for.
 *
 * Returns a list of { type, payload } for events, plus side notes the runner acts on:
 * `session` and `model` (once known), `message` (a new assistant message began), `ask` (a permission request or a
 * question to route: `kind` "question" with `questions`, or "permission" with `detail`; `input` and `suggestions` stay in memory),
 * `cancel` (a request Claude Code withdrew), `delta` (partial text, which the runner throttles
 * rather than emitting one event per token), `limited` (the subscription's limit was hit) and
 * `turn` (a turn ended, with its result).
 * @param {any} m
 */
export function translate(m) {
  /** @type {{ events: { type: string, payload: any }[], session?: string, model?: string|null, message?: string, ask?: any, cancel?: string, delta?: string, block?: number, limited?: boolean, turn?: any,
   *   folded?: string[], blocks?: number, used?: number, window?: number, commands?: string[], reasoning?: string, task?: any,
   *   limit?: { status: string, kind: string|null, resets_at: number|null, utilization?: number } }} */
  const out = { events: [] };
  if (!m || typeof m !== "object") return out;

  if (m.type === "system" && m.subtype === "init") {
    out.session = m.session_id;
    out.model = m.model || null;
    // The slash commands this session offers (built in, the user's, the project's, plugins'), for a composer's menu.
    if (Array.isArray(m.slash_commands)) out.commands = m.slash_commands.map(String);
    return out;
  }

  if (m.type === "stream_event") {
    const e = m.event || {};
    // Only top-level text. A subagent's partial text carries parent_tool_use_id and is shown
    // through its tool, not interleaved with the thread's own words.
    // Deltas carry no message id; message_start does, and the runner keeps it for what follows.
    if (m.parent_tool_use_id) return out;
    if (e.type === "message_start" && e.message && e.message.id) out.message = String(e.message.id);
    if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && e.delta.text) { out.delta = String(e.delta.text); if (typeof e.index === "number") out.block = e.index; }
    // Thinking as it grows (the thinking display): its own delta, kind "reasoning".
    if (e.type === "content_block_delta" && e.delta && e.delta.type === "thinking_delta" && e.delta.thinking) { out.reasoning = String(e.delta.thinking); if (typeof e.index === "number") out.block = e.index; }
    // A steered message Claude Code folded into the running turn is stamped on the first frame after it.
    if (typeof m.user_message_uuid === "string") out.folded = [m.user_message_uuid];
    return out;
  }

  if (m.type === "assistant" && m.message && !m.parent_tool_use_id) {
    const id = String(m.message.id || "");
    // block: the block's place in this line; the Switchboard adds the blocks earlier lines of the
    // same message had (Claude Code writes each block as its own line), so live and transcript
    // rows share one key, message:block.
    (m.message.content || []).forEach((b, block) => {
      if (b.type === "text" && b.text) out.events.push({ type: "thread.text", payload: { message: id, block, text: String(b.text).slice(0, 20000), done: true } });
      // Thinking is its own event, so a surface that does not show it never takes it for the reply.
      if (b.type === "thinking" && b.thinking) out.events.push({ type: "thread.thinking", payload: { message: id, block, text: String(b.thinking).slice(0, 20000), done: true } });
      if (b.type === "tool_use") {
        out.events.push({ type: "thread.tool", payload: { id: b.id, call: b.id, tool: b.name, name: b.name, phase: "started", status: "running", block, ...describe(b.name, b.input), ...toolFields(b.name, b.input, b.vyre_kind) } });
        // Claude's todo list is the plan: one event carrying the whole list, so a card just replaces its state.
        if (b.name === "TodoWrite" && b.input && Array.isArray(b.input.todos)) out.events.push({ type: "thread.plan", payload: { items: planItems(b.input.todos), at: Date.now() } });
      }
    });
    out.blocks = (m.message.content || []).length;
    // The request's own usage: what the context held when Claude answered (for thread.usage context).
    const u = m.message.usage;
    if (u && typeof u === "object") out.used = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"].reduce((a, k) => a + (Number(u[k]) || 0), 0);
    if (typeof m.user_message_uuid === "string") out.folded = [m.user_message_uuid];
    return out;
  }

  if (m.type === "user" && m.message && Array.isArray(m.message.content) && !m.parent_tool_use_id) {
    for (const b of m.message.content) {
      if (b.type === "tool_result") out.events.push({ type: "thread.tool", payload: { id: b.tool_use_id, call: b.tool_use_id, phase: "done", status: b.is_error ? "failed" : "completed", error: Boolean(b.is_error) } });
    }
    return out;
  }

  // A provider's own plan (ACP session/update "plan"), said through the driver's own wire line.
  if (m.type === "system" && m.subtype === "vyre_plan") {
    out.events.push({ type: "thread.plan", payload: { items: planItems(m.entries), at: Date.now() } });
    return out;
  }

  // Background tasks (Bash run in the background, subagents): started, updated, finished.
  if (m.type === "system" && (m.subtype === "task_started" || m.subtype === "task_updated" || m.subtype === "task_notification")) {
    const p = m.patch || {};
    const status = m.subtype === "task_started" ? "running" : m.subtype === "task_updated" ? (p.status || null) : m.status === "stopped" ? "killed" : m.status;
    out.task = { id: String(m.task_id), ...(status ? { status } : {}),
      ...(m.subtype === "task_started" ? { kind: /shell|bash/i.test(String(m.task_type || "")) ? "shell" : "agent", title: cut(m.description || m.prompt || "", 200), call: m.tool_use_id || null,
        background: Boolean(m.is_backgrounded) } : {}),
      ...(p.description ? { title: cut(p.description, 200) } : {}), ...(p.error ? { error: cut(p.error, 300) } : {}),
      ...(m.subtype === "task_notification" ? { summary: cut(m.summary || "", 500) } : {}) };
    return out;
  }

  if (m.type === "control_request" && m.request && m.request.subtype === "can_use_tool") {
    const r = m.request;
    const name = String(r.tool_name || ""), input = r.input || {};
    const base = { request_id: m.request_id, tool: name, tool_use_id: r.tool_use_id || null, input, reason: r.decision_reason || r.description || null };
    if (name === "AskUserQuestion") {
      const questions = questionsOf(input);
      out.ask = { ...base, kind: "question", questions, suggestions: null,
        summary: cut(questions.length ? questions[0].question : "A question"), destination: null };
      return out;
    }
    const d = describe(name, input);
    out.ask = { ...base, kind: "permission", detail: detailOf(name, input),
      suggestions: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length ? r.permission_suggestions : null,
      ...d, summary: redact(d.summary).text };
    return out;
  }
  if (m.type === "control_cancel_request") { out.cancel = m.request_id; return out; }

  // The subscription's rate limit, as Claude Code reports it: every status is passed on (a warning
  // is worth showing), and "rejected" also means the limit was hit.
  if (m.type === "rate_limit_event" && m.rate_limit_info) {
    const r = m.rate_limit_info;
    out.limit = { status: String(r.status || "unknown"), kind: r.rateLimitType || null, resets_at: typeof r.resetsAt === "number" ? r.resetsAt : null,
      ...(typeof r.utilization === "number" ? { utilization: r.utilization } : {}) };
    if (r.status === "rejected") out.limited = true;
    return out;
  }

  if (m.type === "result") {
    const text = typeof m.result === "string" ? m.result : "";
    // A turn that failed on the subscription's limit reads as an error result naming the limit.
    if (m.is_error && /usage limit|rate limit|limit reached|out of (extra )?usage/i.test(text)) out.limited = true;
    out.turn = { ok: !m.is_error, text, cost_usd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : 0 };
    // An agent that names the model per turn (Grok Build, Codex) says so on the result: the reply's events carry it.
    if (typeof m.model === "string" && m.model) out.model = m.model;
    if (Array.isArray(m.user_message_uuids)) out.folded = m.user_message_uuids.map(String);
    // The model's context window, from the result's per-model usage.
    const windows = m.modelUsage && typeof m.modelUsage === "object" ? Object.values(m.modelUsage).map(x => Number(x && x.contextWindow) || 0).filter(Boolean) : [];
    if (windows.length) out.window = Math.max(...windows);
    const u = m.usage || {};
    const n = v => (typeof v === "number" && v >= 0 ? v : 0);
    const tokens = { input: n(u.input_tokens), output: n(u.output_tokens), cache_read: n(u.cache_read_input_tokens), cache_write: n(u.cache_creation_input_tokens) };
    out.events.push({ type: "thread.finished", payload: { ok: !m.is_error, stop_reason: m.stop_reason || m.subtype || null,
      cost_usd: out.turn.cost_usd, duration_ms: m.duration_ms || null, turns: m.num_turns || null, tokens, ...(m.is_error ? { error: cut(text) } : {}) } });
    return out;
  }
  return out;
}
