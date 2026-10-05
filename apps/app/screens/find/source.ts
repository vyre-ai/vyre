// Find's calls on a real vyred, over an injected `call`: the lists loaded once on open (agents.list, projects.catalog, threads.list, projects.list), the searches per query
// (recall.search, files.search, memory.relevant, and mentions.search for vault names, Drive, artifacts and GitHub), a file preview, and the commands Enter runs (agents.ask, threads.send, threads.watch). Vault items are never searched here:
// they stay behind the Vault.
import { MIN, pickAgents, pickProjects, pickSessions, type Command } from "./model.ts";

export type Call = <T = unknown>(tool: string, input?: Record<string, unknown>) => Promise<{ data?: T; error?: { code: string; message: string } }>;
export type Result<T> = { data?: T; error?: { code: string; message: string } };

export function findSource(call: Call, surface: string) {
  return {
    /** What Find leans on, in one go. A list that fails is empty: Find still searches what it can. */
    async load() {
      const [al, cat, th, pl] = await Promise.all([call("agents.list"), call("projects.catalog", { limit: 300 }), call("threads.list", { all: true }), call("projects.list")]);
      const agents = pickAgents(al.data);
      return { agents, assistant: agents.find((a) => a.kind === "assistant")?.name ?? null, sessions: pickSessions(cat.data, th.data), projects: pickProjects(pl.data) };
    },
    /** The searches for a query; each answers on its own so the screen draws as they come. */
    search(q: string, on: { recall: (r: Result<unknown>) => void; files: (r: Result<unknown>) => void; memory: (r: Result<unknown>) => void; mentions: (r: Result<unknown>) => void }) {
      if (q.length < MIN) return;
      void call("recall.search", { q, limit: 20 }).then(on.recall);
      void call("files.search", { q, limit: 20 }).then(on.files);
      void call("memory.relevant", { text: q, limit: 5 }).then(on.memory);
      void call("mentions.search", { q, limit: 8 }).then(on.mentions);
    },
    preview: (path: string, source: string) => call("files.preview", { path, ...(source === "mac" || source === "box" ? { source } : {}) }),
    /** Ask an agent; the thread it landed in comes back so the screen can open it. */
    async ask(agent: string, text: string): Promise<{ thread: string | null; note: string }> {
      const r = await call<{ thread?: string; note?: string }>("agents.ask", { agent, text, surface, wait: false });
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
      return { thread: typeof r.data?.thread === "string" ? r.data.thread : null, note: typeof r.data?.note === "string" ? r.data.note : "" };
    },
    /** A drive or a watch on a session: type into it (drive), then watch it. Nothing is sent when another keyboard has it. */
    async run(cmd: Command, session: { id: string }, name: string): Promise<{ done: boolean; note: string }> {
      if (cmd.kind === "drive") {
        const s = await call<{ sent?: boolean; queued?: boolean; note?: string }>("threads.send", { thread: session.id, text: cmd.text, surface });
        if (s.error) throw Object.assign(new Error(s.error.message), { code: s.error.code });
        if (s.data?.sent === false && !s.data?.queued) return { done: false, note: s.data.note || `${name} did not take it.` };
      }
      const w = await call("threads.watch", { thread: session.id, until: cmd.kind === "watch" ? cmd.until : "either", notify: surface, note: cmd.kind === "drive" ? `Tell ${name}: ${cmd.text}` : `Watch ${name}` });
      if (w.error) throw Object.assign(new Error(w.error.message), { code: w.error.code });
      return { done: true, note: "" };
    },
  };
}
