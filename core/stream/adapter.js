// @ts-check
// adapter: today's events become frames (ADR 0052). A pure mapping: no I/O, no clock, no log.
//
// Three sources feed the stream:
//   1. the switchboard's thread.* and ask.* events (as the app's chat core session-state reads them),
//   2. transcript blocks (core/transcripts blocks(), for history),
//   3. terminal bytes (core/term ring offsets).
// Each call returns specs `{ kind, data, turn? }`; log.append(kind, data, { turn }) mints the frame.
//
// An adapter instance keeps the little a mapping needs between events: which text blocks have
// streamed (so a done text with no deltas still yields its words once), each open tool's name and
// input (so its finish can become a typed Block), queued message words by uuid (thread.steered
// names only the uuid), the turn number, and a terminal's running offset.
//
// Message life (queued, picked-up, cancelled) goes through lib/queue-state.js, the one reading of
// thread.queued / thread.sent / thread.steered / thread.unqueued. term.command (what a person typed
// in the session's terminal) becomes a term-command frame.
//
// Not mapped, on purpose: thread.usage, thread.limit, mode/model changes (header state, read from a
// snapshot).

import { blockFor, kindOfTool, summarize, termChunks } from "./protocol.js";
import { describe, toUserMessage } from "../../lib/queue-state.js";
import { redact } from "../../lib/sanitize.js";

/** The switchboard's raw thread.state word, as a person says it (lib/thread-status.js). @param {unknown} w */
export function stateWord(w) {
  if (w === "running") return "working";
  if (w === "waiting") return "asking";
  if (w === "idle") return "waiting";
  return typeof w === "string" ? w : "stopped";
}

/** thread.stopped's reason as a status state, as session-state.js guesses it. @param {unknown} reason */
export function stoppedState(reason) {
  const r = typeof reason === "string" ? reason : "";
  if (r === "idle" || r === "restart" || r === "rewind") return "paused";
  if (r === "done" || r === "exited") return "finished";
  if (r.startsWith("exited ")) return "failed";
  return "stopped";
}

const EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const turnNo = (/** @type {unknown} */ t) => { const m = /:(\d+)$/.exec(String(t ?? "")); return m ? m[1] : null; };

/**
 * @typedef {{ kind: string, data: any, turn?: string|null, author?: string }} Spec
 */

export function createAdapter() {
  /** @type {string|null} */ let turn = null;
  let statusSeen = false;
  /** message:block -> text already streamed @type {Set<string>} */ const streamed = new Set();
  /** call -> { tool, input, summary } @type {Map<string, any>} */ const tools = new Map();
  /** uuid -> text @type {Map<string, string>} */ const words = new Map();
  /** @type {Map<string, number>} */ const offsets = new Map();

  /** @param {string} kind @param {any} data @returns {Spec} */
  const spec = (kind, data) => ({ kind, data, turn });

  /** @param {any} p @returns {Spec[]} */
  const text = p => {
    const message = String(p.message || "vyre");
    const index = Number.isInteger(p.block) ? p.block : 0;
    const key = `${message}:${index}:${p.kind === "reasoning" ? "r" : "m"}`;
    const extra = p.kind === "reasoning" ? { reasoning: true } : {};
    /** @type {Spec[]} */ const out = [];
    if (typeof p.delta === "string" && p.delta) { streamed.add(key); out.push(spec("text-delta", { message, index, text: p.delta, ...extra })); }
    if (p.done || p.notice) {
      if (!streamed.has(key) && typeof p.text === "string" && p.text) out.push(spec("text-delta", { message, index, text: p.text, ...extra }));
      streamed.delete(key);
      out.push(spec("text-done", { message, index }));
    }
    return out;
  };

  /** @param {any} p @returns {Spec[]} */
  const tool = p => {
    const call = String(p.call ?? p.id ?? "");
    if (!call) return [];
    /** @type {Spec[]} */ const out = [];
    let t = tools.get(call);
    const name = String(p.tool ?? p.name ?? (t && t.tool) ?? "");
    const finished = p.phase === "done" || p.status === "completed" || p.status === "failed" || p.status === "canceled";
    if (!t) {
      t = { tool: name, input: p.input ?? null, summary: typeof p.summary === "string" ? p.summary : "" };
      tools.set(call, t);
      out.push(spec("tool-started", { tool_id: call, tool: name, kind: kindOfTool(name), summary: t.summary || summarize(name, t.input) }));
    } else {
      if (name && !t.tool) t.tool = name;
      if (p.input != null) t.input = p.input;
      if (typeof p.summary === "string" && p.summary) t.summary = p.summary;
    }
    if (typeof p.text === "string" || typeof p.pct === "number") out.push(spec("tool-progress", { tool_id: call, ...(typeof p.text === "string" ? { text: p.text } : {}), ...(typeof p.pct === "number" ? { pct: p.pct } : {}) }));
    if (finished) {
      const ok = !(p.error || p.status === "failed" || p.status === "canceled");
      const result = t.input != null || p.output != null || p.result != null
        ? blockFor(t.tool, t.input, p.output ?? p.result)
        : { block: "text", text: t.summary || (ok ? `${t.tool || "tool"} finished` : `${t.tool || "tool"} failed`) };
      if (!ok && result.block === "text" && typeof p.error === "string") result.text = `${result.text} (${p.error})`.slice(0, 400);
      out.push(spec("tool-finished", { tool_id: call, ok, result }));
      if (ok && EDITS.has(t.tool) && t.input) {
        const path = String(t.input.file_path || t.input.notebook_path || "");
        if (path) out.push(spec("file-changed", { path, op: t.tool === "Write" ? (result.created ? "create" : "edit") : "edit" }));
      }
      tools.delete(call);
    }
    return out;
  };

  /** @param {string} term @param {number} at */
  const seekTerm = (term, at) => offsets.set(term, at);

  /** A shell line the person ran: what they typed, then what it printed. @param {string} term @param {string} command @param {string} output */
  const shell = (term, command, output) => {
    // Redacted before it is logged or sent: a shell prints whatever the session read (a key in an env dump, a token in a config).
    /** @type {Spec[]} */ const out = [spec("term-command", { term, command: redact(command).text })];
    output = redact(output).text;
    if (output) {
      const bytes = Buffer.from(output, "utf8");
      const at = offsets.get(term) ?? 0;
      for (const c of termChunks(term, at, bytes)) out.push(spec(c.kind, c.data));
      offsets.set(term, at + bytes.length);
    }
    return out;
  };

  return {
    /**
     * One switchboard event ({ id, at, type, thread, payload }) as the frames it becomes.
     * @param {{ type: string, payload?: any }} e @returns {Spec[]}
     */
    event(e) {
      const p = e && e.payload && typeof e.payload === "object" ? e.payload : {};
      switch (e && e.type) {
        case "thread.started": return [spec("status", { state: "starting" })];
        case "thread.status":
          if (typeof p.status !== "string") return [];
          statusSeen = true;
          return [spec("status", { state: p.status, ...(turnNo(p.turn) ? { turn: turnNo(p.turn) } : {}), ...(p.stopping ? { stopping: true } : {}) })];
        case "thread.state":
          if (statusSeen || typeof p.state !== "string") return [];
          return [spec("status", { state: stateWord(p.state), ...(turnNo(p.turn) ? { turn: turnNo(p.turn) } : {}) })];
        case "thread.turn": {
          const n = turnNo(p.turn);
          if (n) turn = n;
          /** @type {Spec[]} */ const out = [];
          if (typeof p.text === "string" && p.text) out.push(spec("user-message", { message: String(p.uuid || `turn:${n}`), text: p.text, state: "picked-up" }));
          if (!statusSeen) out.push(spec("status", { state: "working", ...(n ? { turn: n } : {}) }));
          return out;
        }
        case "thread.sent": case "thread.queued": case "thread.steered": {
          if (p.kind === "teammate-result") return [];
          const uuid = String(p.uuid || (p.queued != null ? `q:${p.queued}` : ""));
          if (!uuid) return [];
          // via steer is queued; via turn, now or restored is taken at once (queue-state.js).
          const m = toUserMessage({ ...e, payload: { ...p, uuid } });
          if (!m) return [];
          if (m.text) words.set(uuid, m.text);
          const state = e.type === "thread.sent" && m.state === "picked-up" && !p.via ? "sent" : m.state;
          // Who wrote it rides on the frame (author), so a group or a person can tell their own words from another's.
          return [{ ...spec("user-message", { message: m.message, text: m.text || words.get(uuid) || "", state, ...(m.queued_at != null ? { queued_at: m.queued_at } : {}) }), ...(typeof p.author === "string" && /^person:[^\s]{1,200}$/.test(p.author) ? { author: p.author } : {}) }];
        }
        case "thread.unqueued": {
          const uuid = String(p.uuid || (p.queued != null ? `q:${p.queued}` : ""));
          const d = uuid ? describe({ ...e, payload: { ...p, uuid } }) : null;
          return d ? [spec("user-message", { message: uuid, text: words.get(uuid) || "", state: "cancelled" })] : [];
        }
        case "term.command":
          // The typist rides on the frame: author (a person id), and via / surface as the terminal's opener used them.
          return typeof p.command === "string" && p.command
            ? [{ ...spec("term-command", { term: String(p.term || "shell"), command: p.command, ...(typeof p.via === "string" && p.via ? { via: p.via } : {}), ...(typeof p.surface === "string" && p.surface ? { surface: p.surface } : {}) }),
              ...(typeof p.author === "string" && /^person:[^\s]{1,200}$/.test(p.author) ? { author: p.author } : {}) }]
            : [];
        case "thread.text": return text(p);
        case "thread.thinking": return text({ ...p, kind: "reasoning", notice: undefined });
        case "thread.tool": return tool(p);
        case "thread.plan": {
          const items = (Array.isArray(p.items) ? p.items : []).filter((/** @type {any} */ x) => x && typeof x.text === "string" && x.text)
            .map((/** @type {any} */ x) => ({ text: x.text, status: x.status === "done" || x.status === "running" ? x.status : "pending" }));
          return items.length ? [spec("tool-finished", { tool_id: "plan", ok: true, result: { block: "task", items } })] : [];
        }
        case "thread.task": {
          if (p.id == null || p.id === "") return [];
          const id = `task:${p.id}`;
          const done = ["completed", "failed", "killed"].includes(p.status);
          if (!done) return [spec("tool-started", { tool_id: id, tool: "task", kind: "agent", summary: String(p.title || p.summary || "task") })];
          return [spec("tool-finished", { tool_id: id, ok: p.status === "completed", result: { block: "task", items: [{ text: String(p.title || p.summary || "task"), status: "done" }] } })];
        }
        case "thread.shell": return shell("shell", String(p.command ?? ""), String(p.output ?? ""));
        case "thread.artifact":
          return p.artifact ? [spec("tool-finished", { tool_id: `art:${p.artifact}:${p.version ?? 0}`, ok: true, result: { block: "text", text: `Artifact ${String(p.title || p.artifact).slice(0, 120)}` } })] : [];
        case "ask.raised":
          return p.ask ? [spec("ask", { ask_id: String(p.ask), kind: ["permission", "question", "approval"].includes(p.kind) ? p.kind : "permission", ...(p.tool ? { tool: String(p.tool) } : {}), ...(p.summary ? { summary: String(p.summary) } : {}) })] : [];
        case "ask.answered": case "ask.cancelled":
          return p.ask ? [spec("ask-answered", { ask_id: String(p.ask), decision: e.type === "ask.cancelled" ? "cancelled" : p.decision ?? null })] : [];
        case "thread.finished":
          return statusSeen ? [] : [spec("status", { state: p.ok === false || p.error ? "failed" : "waiting", ...(turn ? { turn } : {}) })];
        case "thread.stopped":
          return statusSeen ? [] : [spec("status", { state: stoppedState(p.reason) })];
        default: return [];
      }
    },

    /**
     * One transcript block (core/transcripts blocks()) as frames, for history a client has not streamed.
     * @param {any} b @returns {Spec[]}
     */
    block(b) {
      if (!b || typeof b !== "object") return [];
      const t = typeof b.turn === "number" ? String(b.turn) : turn;
      /** @type {Spec[]} */ const out = [];
      const add = (/** @type {string} */ k, /** @type {any} */ d) => out.push({ kind: k, data: d, turn: t });
      switch (b.kind) {
        case "user":
          if (b.command) add("term-command", { term: "shell", command: String(b.text ?? "") });
          else add("user-message", { message: String(b.uuid || `u:${b.seq}`), text: String(b.text ?? ""), state: "sent" });
          break;
        case "text": case "thinking": {
          const message = String(b.message || `m:${b.seq}`), index = Number.isInteger(b.block) ? b.block : 0;
          const extra = b.kind === "thinking" ? { reasoning: true } : {};
          if (b.text) add("text-delta", { message, index, text: String(b.text), ...extra });
          add("text-done", { message, index });
          break;
        }
        case "tool": {
          const name = String(b.tool || "");
          add("tool-started", { tool_id: String(b.id), tool: name, kind: kindOfTool(name), summary: summarize(name, b.input) });
          if (b.output !== null || b.done_ts) {
            const ok = !b.error;
            add("tool-finished", { tool_id: String(b.id), ok, result: blockFor(name, b.input, b.output) });
            if (ok && EDITS.has(name) && b.input) { const path = String(b.input.file_path || b.input.notebook_path || ""); if (path) add("file-changed", { path, op: name === "Write" ? "create" : "edit" }); }
          }
          break;
        }
        case "shell":
          for (const s of shell("shell", String(b.command ?? ""), String(b.output ?? ""))) out.push({ ...s, turn: t });
          break;
        default: break;
      }
      return out;
    },

    /** Terminal bytes at a ring offset as term-chunk specs. @param {string} term @param {number} offset @param {Buffer} bytes @returns {Spec[]} */
    term(term, offset, bytes) {
      offsets.set(term, offset + bytes.length);
      return termChunks(term, offset, bytes).map(c => spec(c.kind, c.data));
    },
    seekTerm,
    get turn() { return turn; },
  };
}

/**
 * Feed events into a log through an adapter. Returns the frames appended.
 * @param {import("./log.js").SessionLog} log @param {ReturnType<typeof createAdapter>} ad @param {{ type: string, payload?: any }} e
 */
export function pipe(log, ad, e) {
  return ad.event(e).map(s => log.append(s.kind, s.data, { turn: s.turn ?? null, ...(s.author ? { author: s.author } : {}) }));
}
