// @ts-check
// import: discover this device's Claude Code sessions, let the person choose, and show the import
// filling in stage by stage (docs/design/import.md, 0.1.1's flagship).
//
// Discovery reads metadata only (import/scan.js): file names, sizes, times and the folder each
// session ran in. The person picks folders; import.plan says exactly what that is; import.status
// says how far each stage has got. Sending to a box is federation's (import.start, when its
// transport lands). A home that is not the person's own never reads their ~/.claude
// (transcriptFolders), and nothing here polls: status is read when asked.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { transcriptFolders, claudeHome } from "../config/index.js";
import { scan } from "./scan.js";

/** Only the person's own surfaces read what is on their disk. */
const PEOPLE = ["cli", "local", "deck", "capsule"];
/** A plan is kept this long for its confirm screen. */
const PLAN_TTL_MS = 30 * 60_000;
/** A Vyre folder: the repo or one of its worktrees (the same rule as memory's source trust). */
const VYRE_DIR = /(?:^|\/)vyre(?:[-_.][\w.-]*)?(?:\/|$)/i;

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    const root = ctx.paths?.root || "";
    const claude = root ? claudeHome(root) : null;
    /** @type {Map<string, { at: number, files: string[], sessions: number, bytes: number, folders: string[] }>} */
    const plans = new Map();
    let last = null;

    const roots = extra => {
      // <home>/synced holds other devices' sessions: never offered as this device's own.
      const synced = root ? path.resolve(root, "synced") : null;
      const configured = (ctx.config.transcripts || []).filter(p => !synced || path.resolve(String(p)) !== synced).map(p => ({ path: String(p), kind: /archive/i.test(String(p)) ? "archive" : claude && path.resolve(String(p)).startsWith(path.resolve(claude)) ? "claude" : "folder" }));
      const added = (extra || []).filter(p => typeof p === "string" && path.isAbsolute(p)).map(p => ({ path: p, kind: /** @type {const} */ ("folder") }));
      const all = [...configured, ...added];
      // The person's ~/.claude only for their own ~/.vyre; a dev, demo or test home reads its own.
      const ok = new Set(transcriptFolders(all.map(r => r.path), root));
      const seen = new Set();
      return all.filter(r => ok.has(r.path) && !seen.has(path.resolve(r.path)) && seen.add(path.resolve(r.path)));
    };
    const projects = async () => {
      const r = await ctx.call("projects.list", {});
      const list = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.projects) ? r.data.projects : [];
      return list.map(p => ({ slug: String(p.slug), name: String(p.name || p.slug), folders: (Array.isArray(p.folders) ? p.folders : p.home ? [p.home] : []).map(String) }));
    };

    ctx.tool("import.scan", {
      description: "The Claude Code sessions on this device, by source and by the folder each ran in: counts, sizes, dates, the project each folder belongs to, and which are suggested for import (Vyre's own sessions and temporary folders are not). Work on Vyre itself, folders the person excluded, and credential folders (~/.ssh and the like) are left out before anything is listed (left_out counts them). Reads file names, sizes, times and each session's folder only, within caps (capped says one was hit); nothing leaves the device. claude_keeps_days: how long Claude Code keeps sessions here. folders: more folders to look in (absolute paths).",
      input: { type: "object", properties: { folders: { type: "array", items: { type: "string" } } } },
      callers: PEOPLE,
      run: async ({ folders } = {}) => {
        const ps = await projects().catch(() => []);
        const projectOf = cwd => {
          let best = null;
          for (const p of ps) for (const f of p.folders) if ((cwd === f || cwd.startsWith(f.replace(/\/+$/, "") + "/")) && (!best || f.length > best.len)) best = { slug: p.slug, name: p.name, len: f.length };
          return best ? { slug: best.slug, name: best.name } : null;
        };
        // Left out before anything is listed (e2e): Vyre's own folders, and folders the person
        // excluded from memory (memory.personal.skipCwds) or from imports (import.exclude).
        const exclude = [...(ctx.config.memory?.personal?.skipCwds || []), ...(ctx.config.import?.exclude || [])].filter(x => typeof x === "string");
        const r = scan(roots(folders), { projectOf, exclude, isDev: cwd => VYRE_DIR.test(cwd), quick: root ? path.join(root, "quick") : null, ask: root ? path.join(root, "capsule", "ask") : null });
        last = { at: Date.now(), files: r.files };
        return { sources: r.sources, left_out: r.left_out, capped: r.capped, claude_keeps_days: keepsDays() };
      },
    });

    ctx.tool("import.plan", {
      description: "Exactly what an import of these folders would take: { plan, sessions, bytes, folders, pace: { turns, usd, fast: { hours }, gentle: { days } } } (pace: how long understanding them would take at each speed; search works at once either way). include and exclude are folders sessions ran in (as import.scan lists them) or whole sources (their path); run import.scan first. The plan is kept for 30 minutes, for the confirm screen.",
      input: { type: "object", required: ["include"], properties: { include: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } } } },
      callers: PEOPLE,
      run: async ({ include, exclude = [] }) => {
        if (!last) throw Object.assign(new Error("run import.scan first"), { code: "bad_input" });
        const under = (p, dirs) => dirs.some(d => p === d || p.startsWith(String(d).replace(/\/+$/, "") + "/"));
        const t = Date.now();
        for (const [id, p] of plans) if (t - p.at > PLAN_TTL_MS) plans.delete(id);
        const chosen = [...last.files.values()].filter(f => {
          const byFolder = f.cwd != null && under(f.cwd, include) && !under(f.cwd, exclude);
          const bySource = under(f.file, include) && !under(f.file, exclude) && !(f.cwd && under(f.cwd, exclude));
          return byFolder || bySource;
        });
        const id = "plan_" + crypto.randomBytes(6).toString("hex");
        const plan = { at: t, files: chosen.map(f => f.file), sessions: chosen.length, bytes: chosen.reduce((n, f) => n + f.bytes, 0),
          folders: [...new Set(chosen.map(f => f.cwd).filter(Boolean))].sort() };
        plans.set(id, plan);
        return { plan: id, sessions: plan.sessions, bytes: plan.bytes, folders: plan.folders, pace: await paces(plan.bytes) };
      },
    });

    ctx.tool("import.status", {
      description: "How far the import has got, stage by stage: search (sessions indexed), meaning (turns embedded), graph (people, orgs and facts so far) and personal facts (turns read and waiting). Each { done, total }. Counts only, read when asked.",
      input: { type: "object", properties: {} },
      callers: [...PEOPLE, "module"],
      run: async () => statusNow(),
    });
    /**
     * How long reading personal facts would take at each pace (the person chooses, docs/design/import.md).
     * Search works at once either way. An estimate from the size: about one of the person's turns
     * with something personal in it per 20 KB of session file, at what reading has cost so far.
     */
    const paces = async bytes => {
      const m = (await ctx.call("memory.stats", {}).catch(() => null))?.data?.personal?.model || {};
      const turns = Math.max(1, Math.round(bytes / 20_000));
      const per = Number(m.usd_per_1000_turns) > 0 ? Number(m.usd_per_1000_turns) / 1000 : 0.0003;
      const usd = Math.round(turns * per * 100) / 100;
      const daily = Number(m.cap_usd) > 0 ? Number(m.cap_usd) : 0.25;
      // Fast: one batch of 20 a minute, paid from a one-time pool sized to the history.
      return { turns, usd, fast: { hours: Math.max(1, Math.ceil(turns / 20 / 60)) }, gentle: { days: Math.max(1, Math.ceil(usd / daily)) } };
    };
    /** How long Claude Code keeps sessions here (cleanupPeriodDays, default 30), read, never changed. */
    const keepsDays = () => {
      if (!claude) return null;
      try { const j = JSON.parse(fs.readFileSync(path.join(claude, "settings.json"), "utf8")); return Number.isInteger(j.cleanupPeriodDays) ? j.cleanupPeriodDays : 30; }
      catch { return 30; }
    };

    /** Each stage's counts, from Recall and memory. */
    async function statusNow() {
        const [rs, ms] = await Promise.all([ctx.call("recall.status", {}), ctx.call("memory.stats", {})]);
        const r = rs?.data || {}, m = ms?.data || {};
        const stage = (done, total) => ({ done: Number(done) || 0, total: Math.max(Number(total) || 0, Number(done) || 0) });
        const read = m.personal?.model || {};
        return {
          search: stage(r.progress?.sessions ? r.progress.sessions.done : r.sessions, r.progress?.sessions ? r.progress.sessions.total : r.sessions),
          meaning: stage(r.vectors?.embedded, r.turns),
          graph: { people: Number(m.byKind?.person ?? 0), orgs: Number(m.byKind?.org ?? 0), facts: Number(m.facts ?? 0), sessions: Number(m.sessions ?? 0) },
          personal: stage(read.read_turns, Number(read.read_turns || 0) + Number(read.waiting_turns || 0)),
          searchable_sessions: Number(r.sessions) || 0,
        };
    }

    // Progress as it happens (import.progress): after Recall indexes or embeds and after memory's
    // passes, at most every 2 s, only when a count moved. Counts only, never names or text. No
    // polling: with nothing happening, nothing is sent.
    let timer = null, said = "";
    const tell = async () => {
      timer = null;
      try {
        const s = await statusNow();
        const key = JSON.stringify(s);
        if (key === said) return;
        said = key;
        ctx.events.emit("import.progress", s);
      } catch { /* a module is not running: nothing to say */ }
    };
    const soon = () => { if (!timer) { timer = setTimeout(tell, 2000); timer.unref?.(); } };
    const offs = ["session.indexed", "recall.embedded", "memory.curated"].map(type => ctx.events.on(type, soon));

    return { async stop() { for (const o of offs) o(); if (timer) clearTimeout(timer); plans.clear(); last = null; } };
  },
};
