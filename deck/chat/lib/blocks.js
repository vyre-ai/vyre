// @ts-check
// The pure half of the session view: no DOM here, so every rule is testable in node. What a
// block is called, when an assistant header starts, how a turn's footer reads, and how the same
// blocks print the way Claude Code's own terminal prints them (the raw view).
//
// Blocks are recall.transcript's (team/archive/work-journals/chat.md, contract 2): user, text, thinking, tool,
// turn. Labels (lib/names.js) never say "claude": a reply is the assistant's name (or the agent's), the person is "you",
// and another surface is its own name.

import { labelFor } from "./names.js";
export { OURS } from "./names.js";

/**
 * Who a row is from: lib/names.js's labelFor, kept under this name for the view's callers.
 * @param {{ role: "assistant"|"user", agent?: string|null, surface?: string|null }} o
 * @param {{ assistant?: string|null, owner?: string|null }} [names]
 */
export const whoLabel = (o, names) => labelFor(o, names);

/** Which side of the conversation a block is on. @param {{ kind: string }} b */
export const sideOf = b => b.kind === "user" ? "user" : b.kind === "turn" ? "turn" : "assistant";

/**
 * The render plan for blocks appended after a row of kind `prev` ("user", "assistant", "turn"
 * or null): each assistant run gets one header ("Vyre", time) before its first block, the way a
 * chat groups a reply. Returns ops in order: { op: "head", ts } or { op: "block", block }.
 * @param {any[]} blocks
 * @param {string|null} [prev]
 */
export function plan(blocks, prev = null) {
  const ops = [];
  let last = prev;
  for (const b of blocks) {
    const side = sideOf(b);
    if (side === "assistant" && last !== "assistant") ops.push({ op: "head", ts: b.ts });
    ops.push({ op: "block", block: b });
    last = side;
  }
  return ops;
}

/**
 * Consecutive blocks grouped into what a reader sees: a "you" message, a reply (its thinking,
 * text and tools together), a turn footer.
 * @param {any[]} blocks
 * @returns {{ type: "user"|"assistant"|"turn", ts: number|null, blocks: any[] }[]}
 */
export function groupBlocks(blocks) {
  const out = [];
  for (const b of blocks) {
    const side = sideOf(b);
    const cur = out[out.length - 1];
    if (side === "assistant" && cur && cur.type === "assistant") cur.blocks.push(b);
    else out.push({ type: side, ts: b.ts ?? null, blocks: [b] });
  }
  return out;
}

/**
 * A block's identity. Blocks are unique by seq and kind (a turn block shares its seq with the user
 * line that closed it; one assistant line can hold text and a tool), and tools by id. The turn
 * still open at the end of the file is one key, "turn:open", whatever its seq, so its closed
 * version (or a fresher open one) replaces it.
 */
export function blockKey(b) {
  if (b.kind === "tool") return "tool:" + b.id;
  if (b.kind === "turn") return b.open ? "turn:open" : "turn:" + b.seq;
  return b.kind + ":" + b.seq;
}

/**
 * Merge newer blocks into a seq-ordered list: a block with the same key is replaced by the newer
 * read (a tool's output arrives on a re-read), an open turn gives way to whatever turn comes next,
 * and on a shared seq the turn goes before the user line that closed it.
 */
export function mergeBlocks(have, more) {
  const byKey = new Map();
  const drop = more.some(b => b.kind === "turn");
  for (const b of have) if (!(drop && blockKey(b) === "turn:open")) byKey.set(blockKey(b), b);
  for (const b of more) byKey.set(blockKey(b), b);
  const rank = b => (b.kind === "turn" ? 0 : 1);
  return [...byKey.values()].sort((a, b) => a.seq - b.seq || rank(a) - rank(b));
}

/** A slash command's line (`<command-name>/clear</command-name>...`) as the terminal shows it: "/clear". */
export function commandText(text) {
  const s = String(text ?? "");
  const name = /<command-name>([^<]*)<\/command-name>/.exec(s);
  const args = /<command-args>([^<]*)<\/command-args>/.exec(s);
  if (name) return [name[1].trim(), args ? args[1].trim() : ""].filter(Boolean).join(" ");
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

// ---- small formatters -------------------------------------------------------

/** "840 ms", "12.4 s", "3 min 05 s". */
export function duration(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return "";
  // Under a twentieth of a second says nothing a person reads ("0 ms done"): no time at all.
  if (ms < 50) return "";
  if (ms < 1000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000), s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${String(s).padStart(2, "0")} s`;
}

/** A clock counting up: "0:42", "12:05". */
export function elapsed(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "910", "3.2k", "1.4M". */
export function tokens(n) {
  if (n == null || !isFinite(n)) return "";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** "$0.042", "$1.20". */
export function cost(usd) {
  if (typeof usd !== "number" || !isFinite(usd) || usd <= 0) return "";
  return usd < 0.1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

/**
 * A turn block as its footer's parts: time, tokens, and a $ figure only when the turn really is
 * billed by it (auth "api-key"). A subscription runs on the person's Claude plan; no screen shows
 * a dollar amount for that, since it reads as a charge that never happens (the user's rule).
 */
export function turnParts(t) {
  const parts = [];
  const d = duration(t.duration_ms);
  if (d) parts.push(d);
  const tk = t.tokens || {};
  if (tk.input || tk.output) parts.push(`${tokens((tk.input || 0) + (tk.output || 0))} tokens`);
  if (t.auth === "api-key") { const c = cost(t.cost_usd); if (c) parts.push(c); }
  return parts;
}

/** Output split for a card: the first `max` lines, and how many more are behind "show all". */
export function clip(text, max = 12) {
  const lines = text == null ? [] : String(text).replace(/\n+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return { shown: "", hidden: 0, total: 0 };
  return { shown: lines.slice(0, max).join("\n"), hidden: Math.max(0, lines.length - max), total: lines.length };
}

const LANGS = { js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", py: "python", sh: "bash", bash: "bash", zsh: "bash",
  json: "json", css: "css", html: "html", htm: "html", svg: "html", xml: "html" };
/** The highlight.js language for a file path, or "text". */
export function langOf(path) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(path || ""));
  return (m && LANGS[m[1].toLowerCase()]) || "text";
}

/** The line a tool card's header shows next to the tool's name. */
export function toolTitle(tool, input, cwd = null) {
  const i = input || {};
  const one = s => String(s ?? "").split("\n")[0].slice(0, 300);
  const p = s => shortPath(one(s), cwd);
  switch (tool) {
    case "Bash": return inCwd(one(i.command), cwd);
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return p(i.file_path || i.notebook_path);
    case "Grep": return one(i.pattern) + (i.path ? ` in ${p(i.path)}` : "");
    case "Glob": return one(i.pattern) + (i.path ? ` in ${p(i.path)}` : "");
    case "WebFetch": return one(i.url);
    case "WebSearch": return one(i.query);
    case "TodoWrite": {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const done = todos.filter(t => t && t.status === "completed").length;
      return todos.length ? `${done} of ${todos.length} done` : "";
    }
    case "Task": case "Agent": return one(i.description || i.prompt);
    default: {
      const first = Object.entries(i).find(([, v]) => typeof v === "string");
      return first ? one(first[1]) : "";
    }
  }
}

/**
 * A path as the session reads it: relative to the session's folder when inside it ("menu.md",
 * "src/app.js", "." for the folder itself), else the whole path (the row's ellipsis cuts it).
 * The full path goes in a title.
 * @param {string|null|undefined} path @param {string|null|undefined} [cwd]
 */
export function shortPath(path, cwd = null) {
  const s = String(path ?? "");
  if (!s) return "";
  const base = cwd ? String(cwd).replace(/\/+$/, "") : "";
  if (base && s === base) return ".";
  if (base && s.startsWith(base + "/")) return s.slice(base.length + 1);
  return s;
}

/** A command with the session's folder dropped where it names a path inside it ("cat src/a.js"). */
function inCwd(cmd, cwd) {
  const base = cwd ? String(cwd).replace(/\/+$/, "") : "";
  if (!base || !cmd.includes(base)) return cmd;
  return cmd.split(base + "/").join("").split(base).join(".");
}

/**
 * The verb a tool row leads with (tool-row.md): past tense done, the -ing form while it runs.
 * Never the SDK's names ("Bash", "TodoWrite"). An MCP tool reads its own name, words spaced.
 * @param {string} tool @param {string} state from toolState, or "waiting"
 */
export function toolVerb(tool, state) {
  const now = state === "running" || state === "waiting";
  const V = /** @type {Record<string, [string, string]>} */ ({
    Read: ["Read", "Reading"], Edit: ["Edited", "Editing"], MultiEdit: ["Edited", "Editing"], NotebookEdit: ["Edited", "Editing"],
    Write: ["Wrote", "Writing"], Bash: ["Ran", "Running"], Grep: ["Searched", "Searching"], Glob: ["Searched", "Searching"],
    WebFetch: ["Fetched", "Fetching"], WebSearch: ["Searched the web", "Searching the web"], Task: ["Delegated", "Delegating"],
    Agent: ["Delegated", "Delegating"], TodoWrite: ["Todos", "Todos"], AskUserQuestion: ["Asked", "Asking"],
    ExitPlanMode: ["Plan", "Plan"], BashOutput: ["Read output", "Reading output"], KillShell: ["Stopped a task", "Stopping a task"],
    KillBash: ["Stopped a task", "Stopping a task"],
  });
  const v = V[tool];
  if (v) return v[now ? 1 : 0];
  const name = String(tool || "tool").replace(/^mcp__.+?__/, "").replace(/_/g, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** A tool block's state word: running (no output yet, not done), failed, canceled (the turn was stopped), or done. */
export function toolState(b) {
  if (b.error) return "failed";
  if (b.canceled) return "canceled";
  if (b.output == null && !b.done_ts && !b.done) return "running";
  return "done";
}

// ---- the raw view: the blocks as Claude Code's terminal prints them ------------

const q = s => JSON.stringify(String(s ?? ""));

/** "Bash(npm test)", "Update(src/app.js)", "Search(pattern: "x", path: "src")". */
export function rawToolHead(tool, input, cwd = null) {
  const i = input || {};
  const first = s => String(s ?? "").split("\n")[0].slice(0, 160);
  // Claude Code prints paths relative to the session's folder.
  const fp = s => shortPath(first(s), cwd);
  switch (tool) {
    case "Bash": return `Bash(${first(i.command)})`;
    case "Read": return `Read(${fp(i.file_path)})`;
    case "Write": return `Write(${fp(i.file_path)})`;
    case "Edit": case "MultiEdit": return `Update(${fp(i.file_path)})`;
    case "NotebookEdit": return `Edit Notebook(${fp(i.notebook_path)})`;
    case "Grep": case "Glob": return `Search(pattern: ${q(first(i.pattern))}${i.path ? `, path: ${q(fp(i.path))}` : ""})`;
    case "WebFetch": return `Fetch(${first(i.url)})`;
    case "WebSearch": return `Web Search(${q(first(i.query))})`;
    case "TodoWrite": return "Update Todos";
    case "Task": case "Agent": return `Task(${first(i.description)})`;
    default: {
      const firstStr = Object.entries(i).find(([, v]) => typeof v === "string");
      return `${tool}(${firstStr ? first(firstStr[1]) : ""})`;
    }
  }
}

const OUT = "  ⎿  ", MORE = "     ";

/** What a tool printed under its head, as Claude Code's terminal abbreviates it. */
function rawToolBody(b) {
  const i = b.input || {};
  if (b.tool === "TodoWrite" && Array.isArray(i.todos)) {
    return i.todos.map((t, n) => (n ? MORE : OUT) + (t.status === "completed" ? "☒ " : t.status === "in_progress" ? "◼ " : "☐ ") + String(t.content ?? ""));
  }
  const state = toolState(b);
  if (state === "running") return [OUT + "Running…"];
  const text = b.output == null ? "" : String(b.output);
  if (b.error) {
    const c = clip(text, 4);
    return (("Error: " + c.shown).split("\n")).map((l, n) => (n ? MORE : OUT) + l).concat(c.hidden ? [MORE + `… +${c.hidden} lines`] : []);
  }
  if (b.tool === "Read") { const n = clip(text, 1).total; return [OUT + `Read ${n} ${n === 1 ? "line" : "lines"}`]; }
  const fp = shortPath(i.file_path, b.cwd) || "the file";
  if (b.tool === "Edit" || b.tool === "MultiEdit") return [OUT + `Updated ${fp}`];
  if (b.tool === "Write") { const n = clip(i.content, 1).total; return [OUT + `Wrote ${n} ${n === 1 ? "line" : "lines"} to ${fp}`]; }
  const c = clip(text, 4);
  if (!c.total) return [OUT + "(No content)"];
  return c.shown.split("\n").map((l, n) => (n ? MORE : OUT) + l).concat(c.hidden ? [MORE + `… +${c.hidden} lines`] : []);
}

/**
 * The blocks as the terminal shows them: "> you said", "⏺ reply", "⏺ Bash(npm test)" then
 * "  ⎿  output", "✻ Thinking…", a blank line between entries. Turn blocks print nothing.
 * @param {any[]} blocks
 * @returns {string[]}
 */
export function rawLines(blocks) {
  const out = [];
  for (const b of blocks) {
    let lines = [];
    if (b.kind === "user") lines = String(b.command ? commandText(b.text) : b.text ?? "").split("\n").map((l, n) => (n ? "  " : "> ") + l);
    else if (b.kind === "text") lines = String(b.text ?? "").replace(/\n+$/, "").split("\n").map((l, n) => (n ? "  " : "⏺ ") + l);
    else if (b.kind === "thinking") lines = ["✻ Thinking…"];
    else if (b.kind === "tool") lines = ["⏺ " + (b.input ? rawToolHead(b.tool, b.input, b.cwd) : `${b.tool}(${b.summary || ""})`), ...rawToolBody(b)];
    else continue;
    if (out.length) out.push("");
    out.push(...lines);
  }
  return out;
}
