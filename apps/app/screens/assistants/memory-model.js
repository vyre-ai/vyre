// The pure half of an agent's Memory pane: what it has learned as rows (its own memory.writes plus the corrections people made to it that agents passed on, memory.corrections suggested), which of them are lessons, and the new AGENTS.md when a lesson becomes an instruction.
// No calls here. A lesson is a memory write of kind "correction", not a store of its own; "promoted" is read from AGENTS.md itself, so it can never disagree with the instructions.

/** The words memory.heard puts in front of a correction it files for an agent. */
const REPORTS = /^an agent reports the person corrected:\s*/i;
/** Where lessons go in AGENTS.md. */
export const LESSONS_HEADING = "## Lessons";
const KIND_LABEL = { fact: "Fact", note: "Note", decision: "Decision", correction: "Lesson" };

/** The agent a heard correction came from: the caller reads "mcp:agent:juno" or "harness:agent:juno". @param {unknown} by @param {string} agent */
const isAgent = (by, agent) => { const s = String(by || ""); return s === agent || s.endsWith(`:${agent}`); };

/** The text of a lesson as an instruction would say it: no "an agent reports" lead-in, one line. @param {string} text */
export const lessonText = (text) => String(text || "").replace(REPORTS, "").replace(/\s+/g, " ").trim();

/** Where a row came from, as the screen words it. @param {{ thread?: string|null, project?: string|null, ref?: string|null }} s */
export function sourceLine(s) {
  if (s.thread) return { line: "From a chat", href: `/u/chats/${encodeURIComponent(s.thread)}` };
  if (s.ref && /^vyre:\/\/|\/files\//.test(s.ref)) return { line: "From a file", href: "/u/files" };
  if (s.project) return { line: `In ${s.project}`, href: null };
  return { line: "Added by hand", href: null };
}

/**
 * The rows for one agent, newest first. `writes` is memory.writes({ from: agent }); `heard` is memory.corrections({ suggested: true }).heard. A correction that was filed as a write and also heard is one row.
 * @param {string} agent @param {any[]} writes @param {any[]} heard
 * @returns {{ id: string, text: string, label: string, lesson: boolean, line: string, href: string|null, at: number, by: string, forget: { tool: string, input: any } }[]}
 */
export function memoryRows(agent, writes, heard) {
  /** @type {any[]} */ const rows = [];
  const seen = new Set();
  for (const w of Array.isArray(writes) ? writes : []) {
    if (!w || w.state === "forgotten") continue;
    const f = w.from || {};
    const lesson = w.kind === "correction";
    if (f.thread && Number.isInteger(f.seq)) seen.add(`${f.thread}#${f.seq}`);
    const src = sourceLine({ thread: f.thread, ref: w.source_ref, project: (w.projects || []).find((/** @type {any} */ l) => l.state === "live")?.project });
    rows.push({ id: String(w.id), text: lesson ? lessonText(w.text) : String(w.text || ""), label: KIND_LABEL[w.kind] || "Note", lesson, ...src, at: Number(w.at) || 0,
      by: f.kind === "person" ? "You" : String(f.name || agent), forget: { tool: "memory.write.forget", input: { id: String(w.id) } } });
  }
  for (const h of Array.isArray(heard) ? heard : []) {
    if (!h || !isAgent(h.by, agent) || seen.has(`${h.thread}#${h.seq}`)) continue;
    const src = sourceLine({ thread: String(h.thread || "") });
    // The correction itself is undone, not just the note about it: Forget says so.
    rows.push({ id: `heard:${h.thread}#${h.seq}`, text: lessonText(h.summary), label: "Lesson", lesson: true, ...src, at: Number(h.at) || 0, by: "You", forget: { tool: h.undo?.tool || "memory.uncorrect", input: h.undo?.input || {} } });
  }
  return rows.sort((a, b) => b.at - a.at);
}

const norm = (/** @type {string} */ s) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** The "## Lessons" section of AGENTS.md, or "". @param {string} doc */
function lessonsSection(doc) {
  const m = /^## Lessons[ \t]*$/m.exec(doc);
  if (!m) return "";
  const rest = doc.slice(m.index + m[0].length), next = /^#{1,2} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Whether the lesson is already one of the agent's instructions. @param {string} doc @param {string} text */
export const isPromoted = (doc, text) => { const t = norm(lessonText(text)); return Boolean(t) && norm(lessonsSection(String(doc || ""))).includes(t); };

/** AGENTS.md with the lesson added as a bullet under "## Lessons" (the heading is made when it is missing); unchanged when it is already there. @param {string} doc @param {string} text */
export function withLesson(doc, text) {
  const d = String(doc || ""), t = lessonText(text);
  if (!t || isPromoted(d, t)) return d;
  const bullet = `- ${t}`;
  const m = /^## Lessons[ \t]*$/m.exec(d);
  if (!m) return `${d.replace(/\s+$/, "")}${d.trim() ? "\n\n" : ""}${LESSONS_HEADING}\n\n${bullet}\n`;
  const at = m.index + m[0].length, rest = d.slice(at), next = /^#{1,2} /m.exec(rest);
  const body = (next ? rest.slice(0, next.index) : rest).replace(/\s+$/, ""), tail = next ? rest.slice(next.index) : "";
  return `${d.slice(0, at)}${body ? `${body}\n` : "\n"}${bullet}\n${tail ? `\n${tail}` : ""}`;
}
