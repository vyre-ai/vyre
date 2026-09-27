// @ts-check
// The projects module: the tools over ./projects.js. Recall and Memory are used through
// ctx.call and are not listed under requires, because projects must still start, list and
// brief without them; it only searches less and says so.

import { Projects, MIGRATIONS } from "./projects.js";
import { label } from "./brief.js";
import { wantsMacs, askMacs, mergeRows, sourcesOf, boxLabel, macLabel } from "../modules/federate.js";

const str = { type: "string" };
const strs = { type: "array", items: str };
const person = { type: "object", properties: { name: str, email: str } };
/** On the box, "all" takes in the paired Macs' rows too (the default for the person), "local" only the box's. */
const machines = { type: "string", enum: ["all", "local"] };
/** The catalogue's own order across machines: title matches, then how often it was said, then newest. */
const byCatalog = (a, b) => Number(Boolean(b.titled)) - Number(Boolean(a.titled)) || (b.said || 0) - (a.said || 0) || (b.last || 0) - (a.last || 0);

/**
 * A project's threads with its missing picks filled in from the Macs' recall.sessions answers:
 * name, title, folder and times from the Mac, labelled with it. Every other row is the box's and
 * labelled so; a pick no machine answered for stays as it was, missing, with no label. Newest
 * first, missing picks last, as threadsOf orders them.
 * @param {any} ctx @param {any[]} rows @param {Array<{ name: string, ok: boolean, data?: any }>} answers
 */
function resolvePicks(ctx, rows, answers) {
  /** @type {Map<string, any>} */
  const found = new Map();
  for (const a of answers) if (a.ok && Array.isArray(a.data)) for (const s of a.data) if (s && s.id && !found.has(s.id)) found.set(s.id, { s, where: macLabel(a) });
  const out = rows.map(t => {
    if (!t.missing) return { ...t, ...boxLabel(ctx) };
    const f = found.get(t.id);
    if (!f) return t;
    const s = f.s;
    const row = { ...t, name: s.name || null, title: s.title || null, cwd: s.cwd || null, started: Number(s.started) || 0,
      last: Number(s.ended) || 0, turns: Number(s.turns) || 0, human: Number(s.human) === 1 || s.human === true, missing: false };
    return { ...row, label: label(row), ...f.where };
  });
  return out.sort((a, b) => Number(Boolean(a.missing)) - Number(Boolean(b.missing)) || (b.last || 0) - (a.last || 0));
}

/**
 * The catalogue with live on each session: true when a terminal has it open now, from the
 * Switchboard's binds. Without the Switchboard every row says false.
 * @param {any} ctx @param {{ sessions: any[] }} cat
 */
export async function withLive(ctx, cat) {
  const r = await ctx.call("threads.live", {}).catch(() => null);
  const live = new Set(r && r.data && Array.isArray(r.data.sessions) ? r.data.sessions : []);
  return { ...cat, sessions: cat.sessions.map(s => ({ ...s, live: live.has(s.id) })) };
}

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
      description: "Every session on this device for picking into projects, with its /rename name, first message, folder, last activity, projects, and live (a terminal has it open now). q searches names, first messages, folders and, through Recall, what was said.",
      input: { type: "object", properties: { q: str, limit: { type: "integer" }, human: { type: "boolean" }, machines } },
      run: async (input, { caller } = {}) => {
        const { machines: _, ...own } = input;
        if (!wantsMacs(ctx, input, caller)) return withLive(ctx, await P.catalog(own));
        // On the box, for the person: every Mac's sessions too, in one list in the catalogue's
        // order, capped at the limit. total counts every machine; sources says who answered, and
        // each one's own total.
        const [here, answers] = await Promise.all([P.catalog(own).then(c => withLive(ctx, c)), askMacs(ctx, "projects.catalog", own)]);
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
      input: { type: "object", required: ["project"], properties: { project: str, limit: { type: "integer" }, machines } },
      run: async (input, { caller } = {}) => {
        const { project, limit = 100 } = input;
        P.refresh();
        const rows = P.threadsOf(P.resolve(project));
        if (!wantsMacs(ctx, input, caller)) return rows.slice(0, limit);
        // On the box, for the person: a pick the box has no session for may be a Mac session
        // picked from the Deck. The Macs are asked once, for those ids only, and what they have
        // comes back labelled and is never stored here. A pick no machine has stays missing.
        const ids = rows.filter(t => t.missing).map(t => t.id);
        const answers = ids.length ? await askMacs(ctx, "recall.sessions", { ids, limit: ids.length }) : [];
        return resolvePicks(ctx, rows, answers).slice(0, limit);
      },
    });
    ctx.tool("projects.context", {
      description: "The brief for a thread starting in a project, as plain text for Claude: what the project is, its people, its other threads and its memory. Give project, or cwd and session as a SessionStart hook sees them.",
      input: { type: "object", properties: { project: str, cwd: str, session: str } },
      run: async input => P.context(input),
    });
    return { async stop() {} };
  },
};
