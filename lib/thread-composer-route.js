// @ts-check
// Where a composer's line goes before it hits a session: Claude Code's ! and / shortcuts, mapped to kernel tools.
// The CLI, stream.send, and threads.slash share this table so surfaces do not drift.

/** @typedef {{ tool: string, input: Record<string, unknown>, sendAsMessage?: boolean }} Route */

const SLASH_SEND = new Set([
  "compact", "clear", "reset", "new", "context", "cost", "init", "review", "rename", "undo",
  "vyre", "help", "status", "plan", "permissions", "mcp", "agents", "export", "usage", "resume",
  "memory", "goal",
]);

const LATER_RE = /^(?:"([^"]+)"|(\S+))\s*(.*)$/;

/**
 * Parse /later's words into a planner.add input. Empty body is refused upstream.
 * @param {string} body
 */
export function laterInput(body) {
  const t = String(body || "").trim();
  if (!t) return { kind: "reminder", title: "Follow up in this chat", body: "" };
  const m = LATER_RE.exec(t);
  if (!m) return { kind: "reminder", title: t.slice(0, 120), body: t };
  const when = (m[1] || m[2] || "").trim();
  const rest = (m[3] || "").trim();
  return { kind: "reminder", title: (rest || "Follow up in this chat").slice(0, 120), body: rest || when, at: when };
}

/**
 * Route one composer line. `raw` sends it as a message with no shortcuts.
 * @param {string} text
 * @param {boolean} [raw]
 * @returns {Route}
 */
export function routeComposerLine(text, raw = false) {
  const t = String(text ?? "");
  if (!raw && t.startsWith("!")) {
    return { tool: "threads.shell", input: { command: t.slice(1).trim() } };
  }
  if (!raw && t.startsWith("/")) {
    const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(t);
    if (!m) return { tool: "threads.send", input: { text: t } };
    const name = m[1].toLowerCase();
    const body = (m[2] || "").trim();
    const aliases = { search: "find", remind: "later" };
    const cmd = aliases[name] || name;
    if (cmd === "remember") return { tool: "threads.remember", input: { text: body } };
    if (cmd === "model") return body ? { tool: "threads.model", input: { model: body } } : { tool: "threads.get", input: { limit: 1 } };
    if (cmd === "effort") return { tool: "threads.effort", input: body ? { effort: body } : {} };
    if (cmd === "rewind") return { tool: "threads.rewind", input: body ? { uuid: body } : {} };
    if (cmd === "later") return { tool: "planner.add", input: laterInput(body) };
    if (cmd === "find") return body ? { tool: "recall.search", input: { q: body } } : { tool: "threads.commands", input: {} };
    if (cmd === "roll") return { tool: "threads.roll", input: {} };
    if (SLASH_SEND.has(cmd)) return { tool: "threads.send", input: { text: t }, sendAsMessage: true };
    return { tool: "threads.send", input: { text: t }, sendAsMessage: true };
  }
  return { tool: "threads.send", input: { text: t } };
}

/** CLI-shaped answer (threads.send / threads.shell / threads.remember only). @param {string} text @param {boolean} [raw] */
export function routeLine(text, raw = false) {
  const r = routeComposerLine(text, raw);
  if (r.tool === "threads.shell") return { tool: "threads.shell", body: String(r.input.command ?? "") };
  if (r.tool === "threads.remember") return { tool: "threads.remember", body: String(r.input.text ?? "") };
  return { tool: "threads.send", body: String(r.input.text ?? text) };
}
