// @ts-check
// The projects module: the tools over ./projects.js. Recall and Memory are used through
// ctx.call and are not listed under requires, because projects must still start, list and
// brief without them; it only searches less and says so.

import { Projects, MIGRATIONS } from "./projects.js";

const str = { type: "string" };
const strs = { type: "array", items: str };
const person = { type: "object", properties: { name: str, email: str } };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const P = new Projects({
      db: ctx.store.db, config: ctx.config, call: ctx.call,
      emit: (type, payload, where) => ctx.events.emit(type, payload, where),
    });
    // Only markers already known are read at start. Walking the roots waits for the first list
    // or create, so starting vyred never crawls the user's folders unasked.
    try { P.refresh(); } catch (e) { ctx.log("could not read project markers: " + /** @type {Error} */ (e).message); }

    ctx.tool("projects.list", {
      description: "Every project: name, home, folders, people and how many threads are in it (picked or by folder), newest activity first.",
      input: { type: "object", properties: {} },
      run: async () => P.list(),
    });
    ctx.tool("projects.create", {
      description: "Make a project by hand: a name, a home folder (default: a new folder in the projects folder), other folders it owns, the threads picked into it, and its people.",
      input: { type: "object", required: ["name"], properties: { name: str, home: str, org: str, workspaces: strs, threads: strs, people: { type: "array", items: person }, watchers: strs } },
      run: async input => P.create(input),
    });
    ctx.tool("projects.add-threads", {
      description: "Pick threads (Claude Code session ids) into a project. A thread can be in several projects.",
      input: { type: "object", required: ["project", "threads"], properties: { project: str, threads: strs } },
      run: async ({ project, threads }) => P.addThreads(project, threads),
    });
    ctx.tool("projects.remove-threads", {
      description: "Remove picks from a project. Threads that ran in the project's folders stay in it by folder, and are listed.",
      input: { type: "object", required: ["project", "threads"], properties: { project: str, threads: strs } },
      run: async ({ project, threads }) => P.removeThreads(project, threads),
    });
    ctx.tool("projects.catalog", {
      description: "Every session on this device for picking into projects, with its /rename name, first message, folder, last activity and projects. q searches names, first messages, folders and, through Recall, what was said.",
      input: { type: "object", properties: { q: str, limit: { type: "integer" }, human: { type: "boolean" } } },
      run: async input => P.catalog(input),
    });
    ctx.tool("projects.of", {
      description: "The project that owns a folder, or null.",
      input: { type: "object", required: ["cwd"], properties: { cwd: str } },
      run: async ({ cwd }) => { const p = P.of(cwd); return p ? { project: p.slug, name: p.name, home: p.home } : null; },
    });
    ctx.tool("projects.threads", {
      description: "The threads in a project, newest first, each saying whether it was picked or ran in the project's folders.",
      input: { type: "object", required: ["project"], properties: { project: str, limit: { type: "integer" } } },
      run: async ({ project, limit = 100 }) => { P.refresh(); return P.threadsOf(P.resolve(project)).slice(0, limit); },
    });
    ctx.tool("projects.context", {
      description: "The brief for a thread starting in a project, as plain text for Claude: what the project is, its people, its other threads and its memory. Give project, or cwd and session as a SessionStart hook sees them.",
      input: { type: "object", properties: { project: str, cwd: str, session: str } },
      run: async input => P.context(input),
    });
    return { async stop() {} };
  },
};
