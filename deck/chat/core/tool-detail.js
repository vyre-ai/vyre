// @ts-check
// Derived from Paseo (https://github.com/getpaseo/paseo), packages/protocol/src/agent-types.ts,
// packages/protocol/src/tool-call-display.ts, packages/server/src/server/agent/providers/claude/tool-call-detail-parser.ts,
// packages/server/src/server/agent/providers/claude/tool-call-mapper.ts, packages/server/src/server/agent/providers/tool-call-detail-primitives.ts
// and packages/server/src/server/agent/providers/tool-call-mapper-utils.ts,
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0. Modified for Vyre: plain JS without zod,
// Claude Code tool names only, a "todo" type, mcp tools split into server and tool, a `bodies` switch, icons from deck/js/icons.js.
//
// What a tool call is, as one typed value: a shell command, a file read, an edit, a search. Every
// surface (the Deck, the phone app, core/transcripts) reads the same detail, so a tool is titled
// the same way everywhere and a new tool is taught once, here. Shared core: no DOM and no Node
// APIs, so the Deck, core and an Expo app all import this file as it is.
//
// The input is a Claude Code tool_use input and the output the tool_result's text (both already
// redacted and capped when they come from core/transcripts). Nothing here throws: a shape it does
// not know is { type: "unknown" }.

/**
 * @typedef {{ content: string, status: "pending"|"in_progress"|"completed", activeForm?: string }} Todo
 * @typedef {{ type: "shell", command: string, cwd?: string, description?: string, output?: string, exitCode?: number|null }
 *   | { type: "read", filePath: string, content?: string, offset?: number, limit?: number }
 *   | { type: "edit", filePath: string, oldString?: string, newString?: string, unifiedDiff?: string,
 *       edits?: { oldString?: string, newString?: string }[], notebook?: true }
 *   | { type: "write", filePath: string, content?: string }
 *   | { type: "search", query: string, toolName?: "search"|"grep"|"glob"|"web_search", path?: string, content?: string,
 *       filePaths?: string[], numFiles?: number, truncated?: boolean, mode?: "content"|"files_with_matches"|"count" }
 *   | { type: "fetch", url: string, prompt?: string, result?: string }
 *   | { type: "sub_agent", subAgentType?: string, description?: string, log: string }
 *   | { type: "todo", todos: Todo[] }
 *   | { type: "plan", text: string }
 *   | { type: "plain_text", label?: string, text?: string, icon?: string }
 *   | { type: "unknown", name: string, server?: string, tool?: string, input?: unknown, output?: unknown }} ToolDetail
 */

/** A string with something in it, or undefined. @param {unknown} v */
const str = v => (typeof v === "string" && v.length > 0 ? v : undefined);
/** A finite number, or undefined. @param {unknown} v */
const num = v => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Only the fields that are set: a detail never carries `key: undefined`. @param {Record<string, unknown>} o */
const set = o => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o; };

const SHELL = new Set(["Bash", "bash", "shell", "exec_command"]);
const READ = new Set(["Read", "read", "read_file", "view_file"]);
const WRITE = new Set(["Write", "write", "write_file", "create_file"]);
const EDIT = new Set(["Edit", "MultiEdit", "multi_edit", "edit", "apply_patch", "apply_diff", "str_replace_editor", "NotebookEdit"]);
const FETCH = new Set(["WebFetch", "web_fetch", "WebFetchTool", "web_fetch_tool", "webfetch"]);
const SEARCH = { WebSearch: "web_search", web_search: "web_search", search: "search", Grep: "grep", grep: "grep", Glob: "glob", glob: "glob" };
const AGENT = new Set(["Task", "Agent"]);
const STATUS = new Set(["pending", "in_progress", "completed"]);

// Claude Code's Read output is `cat -n` style: a right-aligned line number, then a tab (or an arrow
// in some versions), then the line. Stripped so read.content is the file's own text, with the
// first number as `offset`. Guarded (first line must match, numbering strictly sequential, most
// lines matching) so real source is never mistaken for a gutter.
const GUTTER = /^\s*(\d+)(?:\t|→)(.*)$/;

/** @param {string|undefined} text @returns {{ content: string, startLine?: number }|undefined} */
export function stripGutter(text) {
  if (!text) return undefined;
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let nonEmpty = 0, matched = 0, seen = false;
  /** @type {number|undefined} */ let start;
  /** @type {number|undefined} */ let prev;
  for (const line of lines) {
    if (!line.length) { out.push(line); continue; }
    nonEmpty++;
    const m = GUTTER.exec(line);
    if (!m) { if (!seen) return undefined; out.push(line); continue; }
    seen = true; matched++;
    const n = Number.parseInt(m[1], 10);
    if (start === undefined) start = n;
    if (prev !== undefined && n !== prev + 1) return undefined;
    prev = n;
    out.push(m[2]);
  }
  if (!nonEmpty || matched / nonEmpty < 0.5) return undefined;
  return { content: out.join("\n"), startLine: start };
}

/** An mcp tool name split: "mcp__kit__search_notes" is server "kit", tool "search_notes". @param {string} name */
export function splitMcp(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Output lines, blanks and Claude Code's own notes dropped. @param {string|undefined} out */
const outputLines = out => (out ? out.split("\n").map(l => l.trim()).filter(l => l && !/^\(Results are truncated/.test(l)) : []);

/**
 * A tool call as a typed detail.
 * - bodies: false leaves out the fields that only copy the call's own input or output text (shell
 *   output, file contents, edit strings, fetch results, an unknown tool's input and output), for a
 *   caller that already carries those next to the detail, the way core/transcripts' tool blocks do.
 * @param {string} tool the tool's name, as Claude Code writes it
 * @param {any} input the tool_use input
 * @param {unknown} [output] the tool_result's text, when it has one
 * @param {{ bodies?: boolean }} [opts]
 * @returns {ToolDetail}
 */
export function toolDetail(tool, input, output, { bodies = true } = {}) {
  const name = String(tool ?? "").trim();
  const i = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const out = typeof output === "string" ? output : undefined;
  const body = (/** @type {unknown} */ v) => (bodies ? v : undefined);
  const d = /** @type {ToolDetail|undefined} */ (known(name, i, out, body));
  if (d) return d;
  const mcp = splitMcp(name);
  return /** @type {ToolDetail} */ (set({ type: "unknown", name, server: mcp?.server, tool: mcp?.tool,
    input: body(input ?? null), output: body(output ?? null) }));
}

/**
 * The typed detail of a tool this file knows, or undefined (the caller falls back to unknown).
 * @param {string} name @param {any} i @param {string|undefined} out @param {(v: unknown) => unknown} body
 */
function known(name, i, out, body) {
  if (SHELL.has(name)) {
    const c = i.command ?? i.cmd;
    const command = Array.isArray(c) ? c.map(t => String(t).trim()).filter(Boolean).join(" ") || undefined : str(c);
    if (!command) return undefined;
    return set({ type: "shell", command, cwd: str(i.cwd) ?? str(i.directory), description: str(i.description), output: body(str(out)) });
  }
  if (READ.has(name)) {
    const filePath = str(i.file_path) ?? str(i.path) ?? str(i.filePath);
    if (!filePath) return undefined;
    const stripped = stripGutter(str(out));
    return set({ type: "read", filePath, content: body(stripped?.content ?? str(out)),
      offset: num(i.offset) ?? stripped?.startLine, limit: num(i.limit) });
  }
  if (WRITE.has(name)) {
    const filePath = str(i.file_path) ?? str(i.path) ?? str(i.filePath);
    if (!filePath) return undefined;
    return set({ type: "write", filePath, content: body(str(i.content) ?? str(i.new_content) ?? str(i.newContent)) });
  }
  if (EDIT.has(name)) {
    const filePath = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? str(i.filePath);
    if (!filePath) return undefined;
    const edits = Array.isArray(i.edits)
      ? i.edits.filter((/** @type {any} */ e) => e && typeof e === "object").map((/** @type {any} */ e) => set({ oldString: str(e.old_string), newString: str(e.new_string) }))
      : undefined;
    const first = edits && edits[0];
    return set({ type: "edit", filePath,
      oldString: body(str(i.old_string) ?? str(i.old_str) ?? first?.oldString),
      newString: body(str(i.new_string) ?? str(i.new_str) ?? str(i.new_source) ?? str(i.content) ?? first?.newString),
      unifiedDiff: body(str(i.patch) ?? str(i.diff) ?? str(i.unified_diff) ?? str(i.unifiedDiff)),
      edits: edits && edits.length > 1 ? body(edits) : undefined,
      notebook: name === "NotebookEdit" ? true : undefined });
  }
  if (name in SEARCH) {
    const toolName = /** @type {"search"|"grep"|"glob"|"web_search"} */ (SEARCH[/** @type {keyof typeof SEARCH} */ (name)]);
    const query = str(i.query) ?? str(i.q) ?? str(i.pattern);
    if (!query) return undefined;
    /** @type {Record<string, unknown>} */
    const d = { type: "search", query, toolName, path: str(i.path) };
    if (toolName === "glob" && out !== undefined) {
      const files = outputLines(out).filter(l => !/^No files found/i.test(l));
      Object.assign(d, { filePaths: files.length ? body(files) : undefined, numFiles: files.length,
        truncated: /\(Results are truncated/.test(out) || undefined });
    } else if (toolName === "grep") {
      const mode = i.output_mode === "content" || i.output_mode === "count" ? i.output_mode : "files_with_matches";
      d.mode = mode;
      if (out !== undefined && mode === "files_with_matches") {
        const lines = outputLines(out);
        const found = /^Found (\d+) files?/i.exec(lines[0] || "");
        const files = found ? lines.slice(1) : lines.filter(l => !/^No files found/i.test(l));
        Object.assign(d, { filePaths: files.length ? body(files) : undefined, numFiles: found ? Number(found[1]) : files.length });
      } else if (out !== undefined) d.content = body(str(out));
    } else if (out !== undefined) d.content = body(str(out));
    return set(d);
  }
  if (FETCH.has(name)) {
    const url = str(i.url);
    if (!url) return undefined;
    return set({ type: "fetch", url, prompt: str(i.prompt), result: body(str(out)) });
  }
  if (AGENT.has(name)) {
    return set({ type: "sub_agent", subAgentType: str(i.subagent_type), description: str(i.description) ?? str(i.prompt)?.split("\n")[0],
      log: bodies ? out ?? "" : "" });
  }
  if (name === "TodoWrite") {
    if (!Array.isArray(i.todos)) return undefined;
    const todos = i.todos.filter((/** @type {any} */ t) => t && typeof t === "object").map((/** @type {any} */ t) =>
      set({ content: String(t.content ?? ""), status: STATUS.has(t.status) ? t.status : "pending", activeForm: str(t.activeForm) }));
    return { type: "todo", todos };
  }
  if (name === "ExitPlanMode") {
    const text = str(i.plan);
    return text ? { type: "plan", text } : undefined;
  }
  if (name === "Skill") {
    const label = str(i.skill) ?? str(i.command);
    return label ? set({ type: "plain_text", label, icon: "chat", text: body(str(out)) }) : undefined;
  }
  return undefined;
}

// ---- display ----------------------------------------------------------------

/** The icons a detail can ask for; each is a drawing in deck/js/icons.js. */
export const TOOL_ICONS = /** @type {const} */ (["terminal", "file", "edit", "search", "login", "agents", "check", "lines", "chat", "settings"]);

/** "search_notes" as "Search notes"; a name with separators Paseo keeps whole. @param {string} name */
export function humanize(name) {
  const t = String(name ?? "").trim();
  if (!t || /[:./]/.test(t) || t.includes("__")) return t;
  const words = t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").split(" ").filter(Boolean).join(" ").toLowerCase();
  return words.replace(/^./, c => c.toUpperCase());
}

/**
 * An mcp server's name as a person reads it. Claude Code names the connectors it brings along
 * "claude_ai_<Name>"; that prefix is dropped, so a label never names the vendor.
 * @param {string} server
 */
export const serverLabel = server => humanize(String(server).replace(/^claude[_-]?ai[_-]/i, "")) || server;

/** A subtitle is one line, cut at 300. @param {unknown} s */
const one = s => String(s ?? "").split("\n")[0].slice(0, 300);

/**
 * What a card's header shows for a detail: its title (what kind of call), subtitle (the command,
 * the file, the query) and icon (a name from deck/js/icons.js).
 * @param {ToolDetail} detail
 * @param {string} [tool] the tool's name, for the title of a detail that does not name its kind
 * @returns {{ title: string, subtitle: string, icon: typeof TOOL_ICONS[number] }}
 */
export function toolDisplay(detail, tool) {
  const d = /** @type {any} */ (detail || { type: "unknown", name: "" });
  const at = (/** @type {unknown} */ q) => one(q) + (d.path ? ` in ${one(d.path)}` : "");
  switch (d.type) {
    case "shell": return { title: "Shell", subtitle: one(d.command), icon: "terminal" };
    case "read": return { title: "Read", subtitle: one(d.filePath), icon: "file" };
    case "edit": return { title: "Edit", subtitle: one(d.filePath), icon: "edit" };
    case "write": return { title: "Write", subtitle: one(d.filePath), icon: "edit" };
    case "search": return { title: d.toolName === "web_search" ? "Web search" : "Search", subtitle: at(d.query), icon: "search" };
    case "fetch": return { title: "Fetch", subtitle: one(d.url), icon: "login" };
    case "sub_agent": return { title: humanize(d.subAgentType || "") || "Task", subtitle: one(d.description), icon: "agents" };
    case "todo": {
      const todos = Array.isArray(d.todos) ? d.todos : [];
      const done = todos.filter((/** @type {any} */ t) => t && t.status === "completed").length;
      return { title: "Todos", subtitle: todos.length ? `${done} of ${todos.length} done` : "", icon: "check" };
    }
    case "plan": return { title: "Plan", subtitle: one(d.text), icon: "lines" };
    case "plain_text": return { title: humanize(tool || "") || "Note", subtitle: one(d.label), icon: "chat" };
    default: {
      const title = d.server ? `${serverLabel(d.server)}: ${humanize(d.tool)}` : humanize(d.name) || "Tool";
      const i = d.input && typeof d.input === "object" ? d.input : {};
      const first = Object.values(i).find(v => typeof v === "string");
      return { title, subtitle: first ? one(first) : "", icon: "settings" };
    }
  }
}
