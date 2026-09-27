// @ts-check
// A prototype of ADR 0030's Claude driver: one Vyre-owned session on the Claude Agent SDK.
//
// Not wired into vyred. It exists to prove the shape: one long-lived query() per session fed by a
// push queue, SDK messages mapped to Vyre's session events, and every permission question sent
// through canUseTool into an ask that a person answers from any surface.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

/** A push queue the SDK reads user messages from, for the life of the session. */
function inbox() {
  /** @type {any[]} */ const items = [];
  /** @type {((r: IteratorResult<any>) => void) | null} */ let wake = null;
  let ended = false;
  return {
    push(m) { if (wake) { const w = wake; wake = null; w({ value: m, done: false }); } else items.push(m); },
    end() { ended = true; if (wake) { const w = wake; wake = null; w({ value: undefined, done: true }); } },
    iterable: { [Symbol.asyncIterator]: () => ({
      next: () => items.length ? Promise.resolve({ value: items.shift(), done: false })
        : ended ? Promise.resolve({ value: undefined, done: true })
        : new Promise(r => { wake = r; }),
    }) },
  };
}

/**
 * @typedef {{ type: string, session: string|null, turn?: string|null, at: number, [k: string]: any }} SessionEvent
 * @typedef {{ decision: "allow"|"deny"|"always", answers?: Record<string, string>, message?: string }} Answer
 * @typedef {(tool: string, input: any) => { deny: string } | null} Floor
 */

export class ClaudeSession {
  /**
   * @param {{ cwd: string, resume?: string, sessionId?: string, append?: string, env?: Record<string, string|undefined>,
   *           bin?: string, floor?: Floor, settingSources?: any[], model?: string }} o
   */
  constructor(o) {
    this.o = o;
    this.id = o.resume || o.sessionId || null;
    /** @type {Set<(e: SessionEvent) => void>} */ this.subs = new Set();
    /** @type {Map<string, { ask: any, resolve: (r: any) => void }>} */ this.asks = new Map();
    this.turn = null; this.turns = 0; this.pending = 0;
    /** @type {number|null} */ this.pid = null;
    this.input = inbox();
    this.state = "idle";
    this.q = query({ prompt: this.input.iterable, options: this.options() });
    this.pump = this.run();
  }

  options() {
    const o = this.o;
    return {
      cwd: o.cwd,
      includePartialMessages: true,
      ...(o.resume ? { resume: o.resume } : o.sessionId ? { sessionId: o.sessionId } : {}),
      systemPrompt: /** @type {const} */ ({ type: "preset", preset: "claude_code", ...(o.append ? { append: o.append } : {}) }),
      settingSources: o.settingSources ?? ["user", "project", "local"],
      ...(o.model ? { model: o.model } : {}),
      ...(o.bin ? { pathToClaudeCodeExecutable: o.bin } : {}),
      env: o.env,
      canUseTool: (tool, input, opts) => this.canUseTool(tool, input, opts),
      // Own the spawn, so the pid is known (the peer ancestry check and the RSS numbers need it).
      spawnClaudeCodeProcess: sp => {
        const child = spawn(sp.command, sp.args, { cwd: sp.cwd, env: sp.env, signal: sp.signal, stdio: ["pipe", "pipe", "pipe"] });
        this.pid = child.pid ?? null;
        return /** @type {any} */ (child);
      },
      stderr: () => {},
    };
  }

  /** @param {(e: SessionEvent) => void} fn */
  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  /** @param {string} type @param {Record<string, any>} [data] */
  emit(type, data = {}) { const e = { type, session: this.id, turn: this.turn, at: Date.now(), ...data }; for (const f of this.subs) f(e); }

  /** Send a user turn. While a turn runs it is queued (priority "next"), as Claude Code queues typed text. */
  send(text) {
    const uuid = crypto.randomUUID();
    const busy = this.state === "running";
    this.pending++;
    this.input.push({ type: "user", uuid, message: { role: "user", content: String(text) }, parent_tool_use_id: null, session_id: this.id || "",
      ...(busy ? { priority: "next" } : {}) });
    if (busy) this.emit("turn.queued", { uuid, text });
    else this.startTurn(text);
    return uuid;
  }

  startTurn(text) {
    this.turn = `turn-${++this.turns}`; this.state = "running";
    this.emit("turn.started", { text });
  }

  /** The permission callback: the floor first (never asks), then an ask a person answers. */
  canUseTool(tool, input, opts) {
    const denied = this.o.floor?.(tool, input);
    if (denied) { this.emit("tool.denied", { tool, by: "floor", reason: denied.deny }); return Promise.resolve({ behavior: "deny", message: denied.deny }); }
    const id = crypto.randomBytes(9).toString("base64url");
    const ask = { id, kind: tool === "AskUserQuestion" ? "question" : "permission", tool, input,
      title: opts.title || null, suggestions: opts.suggestions || null, tool_use_id: opts.toolUseID || null,
      mcp: opts.mcpServer || null, reason: opts.decisionReason || null };
    return new Promise(resolve => {
      this.asks.set(id, { ask, resolve });
      opts.signal?.addEventListener("abort", () => {
        if (!this.asks.delete(id)) return;
        this.emit("ask.cancelled", { ask: id });
        resolve({ behavior: "deny", message: "Cancelled." });
      }, { once: true });
      this.state = "waiting";
      this.emit("ask.raised", { ask });
    });
  }

  /** A person's answer to an ask. Who may call this is vyred's business (PERSON_ONLY), not the driver's. */
  /** @param {string} id @param {Answer} a */
  answer(id, a) {
    const p = this.asks.get(id);
    if (!p) return false;
    this.asks.delete(id);
    const { ask } = p;
    const updatedInput = a.answers ? { ...ask.input, answers: a.answers } : ask.input;
    p.resolve(a.decision === "deny"
      ? { behavior: "deny", message: a.message || "The user declined this." }
      : { behavior: "allow", updatedInput, ...(a.decision === "always" && ask.suggestions ? { updatedPermissions: ask.suggestions } : {}) });
    this.state = "running";
    this.emit("ask.answered", { ask: id, decision: a.decision });
    return true;
  }

  async interrupt() { await this.q.interrupt(); }
  async close() { this.input.end(); try { this.q.close(); } catch {} await this.pump.catch(() => {}); }

  async run() {
    try {
      for await (const m of this.q) this.map(m);
    } catch (e) { this.emit("session.error", { message: String(/** @type {any} */ (e)?.message || e) }); }
    this.state = "closed";
    this.emit("session.closed");
  }

  /** SDK message to session events. */
  map(m) {
    if (m.session_id && m.session_id !== this.id) { const was = this.id; this.id = m.session_id; if (was) this.emit("session.rebound", { was }); }
    if (m.type === "system" && m.subtype === "init") return this.emit("session.started", { model: m.model, cwd: m.cwd, tools: m.tools?.length ?? 0 });
    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") this.emit("text.delta", { text: ev.delta.text });
      return;
    }
    if (m.type === "assistant") {
      for (const b of m.message?.content || []) if (b.type === "tool_use") this.emit("tool.call", { call: b.id, name: b.name, status: "running", input: b.input });
      return;
    }
    if (m.type === "user") {
      const c = m.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b.type === "tool_result")
        this.emit("tool.call", { call: b.tool_use_id, status: b.is_error ? "failed" : "completed" });
      return;
    }
    if (m.type === "rate_limit_event") return this.emit("usage.limit", { info: m.rate_limit_info });
    if (m.type === "result") {
      this.emit("usage", { cost_usd: m.total_cost_usd, usage: m.usage });
      this.emit(m.is_error ? "turn.failed" : "turn.completed", { result: m.result, subtype: m.subtype });
      this.pending = Math.max(0, this.pending - 1);
      this.turn = null; this.state = "idle";
      if (this.pending > 0) this.startTurn("(queued)");
    }
  }
}
