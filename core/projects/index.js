// @ts-check
// The projects module: the tools over ./projects.js. Recall and Memory are used through
// ctx.call and are not listed under requires, because projects must still start, list and
// brief without them; it only searches less and says so.

import { Projects, MIGRATIONS } from "./projects.js";
import { wantsMacs, askMacs, mergeRows, sourcesOf } from "../modules/federate.js";

const str = { type: "string" };
const strs = { type: "array", items: str };
const person = { type: "object", properties: { name: str, email: str } };
/** On the box, "all" takes in the paired Macs' rows too (the default for the person), "local" only the box's. */
const machines = { type: "string", enum: ["all", "local"] };
/** The catalogue's own order across machines: title matches, then how often it was said, then newest. */
const byCatalog = (a, b) => Number(Boolean(b.titled)) - Number(Boolean(a.titled)) || (b.said || 0) - (a.said || 0) || (b.last || 0) - (a.last || 0);

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
      description: "Every project: name, home, folders, people, how many threads are in it (picked or by folder), the picked thread ids (picks), newest activity first.",
      input: { type: "object", properties: { machines } },
      run: async (input, { caller } = {}) => {
        if (!wantsMacs(ctx, input, caller)) return P.list();
        // On the box, for the person: the box's projects, then each Mac's, every one labelled.
        const [own, answers] = await Promise.all([P.list(), askMacs(ctx, "projects.list", {})]);
        return { ...own, projects: mergeRows(ctx, own.projects, answers, { rows: d => d && d.projects }),
          problems: mergeRows(ctx, own.problems, answers, { rows: d => d && d.problems }), sources: sourcesOf(ctx, answers) };
      },
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
      input: { type: "object", properties: { q: str, limit: { type: "integer" }, human: { type: "boolean" }, machines } },
      run: async (input, { caller } = {}) => {
        const { machines: _, ...own } = input;
        if (!wantsMacs(ctx, input, caller)) return P.catalog(own);
        // On the box, for the person: every Mac's sessions too, in one list in the catalogue's
        // order, capped at the limit. total counts every machine; sources says who answered, and
        // each one's own total.
        const [here, answers] = await Promise.all([P.catalog(own), askMacs(ctx, "projects.catalog", own)]);
        const total = answers.reduce((n, a) => n + (a.ok && a.data ? Number(a.data.total) || 0 : 0), here.total);
        const sessions = mergeRows(ctx, here.sessions, answers, { rows: d => d && d.sessions, compare: byCatalog, limit: own.limit ?? 50 });
        const totals = [here.total, ...answers.map(a => (a.ok && a.data ? Number(a.data.total) || 0 : undefined))];
        const sources = sourcesOf(ctx, answers).map((x, i) => (totals[i] === undefined ? x : { ...x, total: totals[i] }));
        return { ...here, total, sessions, sources };
      },
    });
    ctx.tool("projects.of", {
      description: "The project that owns a folder or any folder under it, or null. slug is what the other tools take.",
      input: { type: "object", required: ["cwd"], properties: { cwd: str } },
      run: async ({ cwd }) => { const p = P.of(cwd); return p ? { slug: p.slug, name: p.name, home: p.home, folders: p.workspaces } : null; },
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
