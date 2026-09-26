// @ts-check
// harness — what the Claude Code hooks ask vyred (docs/SPEC.md section 8).
//
// The hooks in harness/hooks/ are a few lines each: they read the hook's JSON from stdin, call
// one of these tools, and print what comes back. All the logic is here, where it can be tested
// and where it can use the other modules. Those modules are reached only through ctx.call, and
// every one of them may be missing (not installed, failed, not built yet): each tool then
// returns less, never an error, so Claude Code behaves exactly as it would without Vyre.

import os from "node:os";
import path from "node:path";
import { rules } from "./rules.js";

const MIGRATIONS = [
  `CREATE TABLE harness_files (
     session TEXT NOT NULL, path TEXT NOT NULL, tool TEXT NOT NULL, at INTEGER NOT NULL,
     PRIMARY KEY (session, path, tool)
   );
   CREATE INDEX harness_files_at ON harness_files (at);`,
];

/** Tools that change files, and where each keeps the path it changed. */
const WRITERS = { Write: "file_path", Edit: "file_path", MultiEdit: "file_path", NotebookEdit: "notebook_path" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;

    /** Call another module's tool; any failure, including its absence, is simply no answer. */
    const ask = async (tool, input) => {
      const r = await ctx.call(tool, input);
      return r && "data" in r ? r.data : null;
    };

    /** The project a folder is in, if Projects is running and knows one. */
    const projectOf = async cwd => (cwd ? ask("projects.of", { cwd }) : null);

    ctx.tool("harness.brief", {
      description: "SessionStart: what Claude should know about the project this thread is in. Empty outside a project.",
      input: { type: "object", properties: { cwd: { type: "string" }, session: { type: "string" }, source: { type: "string" }, project: { type: "string" } } },
      run: async ({ cwd, session, source, project }) => {
        if (session) ctx.events.emit("thread.started", { session, cwd: cwd || null, source: source || null });
        // Projects decides which project this is: from the folder first, then from the session's
        // single pick. A session picked into several projects gets no brief rather than a guess.
        const brief = await ask("projects.context", project ? { project, session } : { cwd, session });
        const text = typeof brief === "string" ? brief : brief && typeof brief.text === "string" ? brief.text : "";
        return { text, project: brief && brief.project ? String(brief.project) : null };
      },
    });

    ctx.tool("harness.enrich", {
      description: "UserPromptSubmit: memory relevant to this prompt, marked as memory with its source. Empty when nothing is relevant.",
      input: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, cwd: { type: "string" }, session: { type: "string" } } },
      run: async ({ prompt, cwd }) => {
        if (!prompt.trim() || prompt.trim().startsWith("/")) return { text: "" };
        const project = await projectOf(cwd);
        const folders = project && (Array.isArray(project.folders) ? project.folders : project.home ? [project.home] : null);
        const project_cwds = folders || (cwd ? [cwd] : undefined);
        const facts = await ask("memory.relevant", { text: prompt, project_cwds, limit: 5 });
        return { text: formatMemory(Array.isArray(facts) ? facts : facts && Array.isArray(facts.facts) ? facts.facts : []) };
      },
    });

    ctx.tool("harness.rules", {
      description: "PreToolUse: the security floor's verdict on a tool call. null means no opinion; Claude Code's own permissions decide.",
      input: { type: "object", required: ["tool_name"], properties: { tool_name: { type: "string" }, tool_input: { type: "object" }, cwd: { type: "string" }, session: { type: "string" } } },
      run: async ({ tool_name, tool_input, cwd, session }) => {
        const verdict = rules({ tool: tool_name, input: tool_input || {}, cwd, home: ctx.paths ? ctx.paths.root : undefined });
        if (verdict.decision) ctx.events.emit("tool.held", { session: session || null, tool: tool_name, decision: verdict.decision, rule: verdict.rule });
        return verdict;
      },
    });

    const touch = db.prepare("INSERT INTO harness_files (session, path, tool, at) VALUES (?,?,?,?) ON CONFLICT DO UPDATE SET at = excluded.at");
    ctx.tool("harness.learn", {
      description: "PostToolUse: record which files a tool changed, so every change is visible (security floor rule 5).",
      input: { type: "object", required: ["tool_name"], properties: { tool_name: { type: "string" }, tool_input: { type: "object" }, cwd: { type: "string" }, session: { type: "string" } } },
      run: async ({ tool_name, tool_input, cwd, session }) => {
        const key = WRITERS[/** @type {keyof typeof WRITERS} */ (tool_name)];
        const raw = key && tool_input ? tool_input[key] : null;
        if (!raw || typeof raw !== "string") return { recorded: 0 };
        const file = path.resolve(cwd || os.homedir(), raw);
        touch.run(session || "", file, tool_name, Date.now());
        ctx.events.emit("file.touched", { session: session || null, path: file, tool: tool_name });
        return { recorded: 1 };
      },
    });

    ctx.tool("harness.touched", {
      description: "Files changed in a thread, newest first.",
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, limit: { type: "integer" } } },
      run: async ({ session, limit }) =>
        db.prepare("SELECT path, tool, at FROM harness_files WHERE session = ? ORDER BY at DESC LIMIT ?").all(session, limit || 100),
    });

    ctx.tool("harness.stop", {
      description: "Stop: the turn is complete, for every surface watching this thread.",
      input: { type: "object", properties: { session: { type: "string" } } },
      run: async ({ session }) => {
        if (session) ctx.events.emit("turn.completed", { session });
        return { ok: true };
      },
    });

    return { async stop() {} };
  },
};

/**
 * Memory for a prompt, as Claude will read it. Each line says it is memory, where it came from
 * and how old it is, so Claude can weigh it and the user can ask where it came from (floor 7).
 * @param {any[]} facts
 */
export function formatMemory(facts) {
  const lines = [];
  for (const f of facts.slice(0, 5)) {
    const text = String(f.text ?? f.fact ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) continue;
    const bits = [f.source && `from ${String(f.source).slice(0, 60)}`, f.age && String(f.age), typeof f.confidence === "number" && `confidence ${f.confidence.toFixed(2)}`].filter(Boolean);
    lines.push(`- ${text}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  if (!lines.length) return "";
  return `Vyre memory. These come from earlier sessions, not from this conversation; check before relying on them.\n${lines.join("\n")}`;
}
