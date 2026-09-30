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
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { transcriptFolders, claudeHome } from "../config/index.js";
import { scan } from "./scan.js";
import { agentHomes, formatFor } from "./formats/index.js";
import { folderName } from "./formats/shared.js";

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
      // Codex and Gemini CLI: one source each when the agent has sessions here (scan drops an empty one).
      const all = [...configured, ...added, ...agentHomes(root)];
      // The person's ~/.claude only for their own ~/.vyre; a dev, demo or test home reads its own.
      const ok = new Set([...transcriptFolders(all.filter(r => !formatFor(r.kind)).map(r => r.path), root), ...all.filter(r => formatFor(r.kind)).map(r => r.path)]);
      const seen = new Set();
      return all.filter(r => ok.has(r.path) && !seen.has(path.resolve(r.path)) && seen.add(path.resolve(r.path)));
    };
    const projects = async () => {
      const r = await ctx.call("projects.list", {});
      const list = Array.isArray(r?.data) ? r.data : Array.isArray(r?.data?.projects) ? r.data.projects : [];
      return list.map(p => ({ slug: String(p.slug), name: String(p.name || p.slug), folders: (Array.isArray(p.folders) ? p.folders : p.home ? [p.home] : []).map(String) }));
    };

    ctx.tool("import.scan", {
      description: "The coding-agent sessions on this device (Claude Code, Codex, Gemini CLI; each source is tagged with its agent), by source and by the folder each ran in: counts, sizes, dates, the project each folder belongs to, and which are suggested for import (Vyre's own sessions and temporary folders are not). Work on Vyre itself, folders the person excluded, and credential folders (~/.ssh and the like) are left out before anything is listed (left_out counts them). Reads file names, sizes, times and each session's folder only, within caps (capped says one was hit); nothing leaves the device. claude_keeps_days: how long Claude Code keeps sessions here. folders: more folders to look in (absolute paths).",
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
        const candidates = ps.flatMap(p => p.folders);
        const r = scan(roots(folders), { projectOf, candidates, exclude, isDev: cwd => VYRE_DIR.test(cwd), quick: root ? path.join(root, "quick") : null, ask: root ? path.join(root, "capsule", "ask") : null });
        last = { at: Date.now(), files: r.files };
        return { sources: r.sources, left_out: r.left_out, capped: r.capped, claude_keeps_days: keepsDays() };
      },
    });

    ctx.tool("import.plan", {
      description: "Exactly what an import of these folders would take: { plan, sessions, bytes, folders, pace: { turns, fast: { hours }, gentle: { days } } } (pace: how long understanding them would take at each speed, within the plan's normal limits; search works at once either way). include and exclude are folders sessions ran in (as import.scan lists them) or whole sources (their path); run import.scan first. The plan is kept for 30 minutes, for the confirm screen.",
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
        const plan = { at: t, files: chosen.map(f => f.file), items: chosen.map(f => ({ path: f.file, rel: f.format ? `${folderName(f.cwd)}/${f.id}.jsonl` : `${path.basename(path.dirname(f.file))}/${f.id}.jsonl`, bytes: f.bytes, ...(f.format ? { format: f.format, home: f.home, cwd: f.cwd } : {}) })),
          hash: crypto.createHash("sha256").update(chosen.map(f => f.file).sort().join("\n")).digest("hex"), sessions: chosen.length, bytes: chosen.reduce((n, f) => n + f.bytes, 0),
          folders: [...new Set(chosen.map(f => f.cwd).filter(Boolean))].sort() };
        plans.set(id, plan);
        return { plan: id, sessions: plan.sessions, bytes: plan.bytes, folders: plan.folders, pace: await paces(plan.bytes) };
      },
    });

    // ---- sending: the person's consent, then federation's sender (core/sync), a batch at a time.
    ctx.store.migrate([`CREATE TABLE import_runs (id TEXT PRIMARY KEY, at INTEGER NOT NULL, machine TEXT NOT NULL, plan_hash TEXT NOT NULL, mode TEXT NOT NULL, pace TEXT NOT NULL,
      state TEXT NOT NULL, of INTEGER NOT NULL, sent INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, ended INTEGER);`]);
    const BATCH = 25;
    /** This device's name, as the server files what it sends under synced/<machine>/ and knows it from pairing (the hostname it paired under; config.machine is the kind of machine, never a name). */
    const machine = () => String(ctx.config.name || os.hostname()).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 80) || "device";
    /**
     * The server's own record of consent: sync.consent lives on the box only, so a device asks for it over the link. (A box
     * importing its own sessions has the tool itself.)
     */
    const consent = async input => {
      const r = await ctx.call("sync.consent", input);
      if (r?.error?.code !== "no_such_tool" || ctx.config.role === "box") return r;
      return ctx.call("link.call", { tool: "sync.consent", input });
    };
    /** @type {{ id: string, stop: boolean, done: Promise<void>|null }|null} */
    let current = null;
    const runRow = id => /** @type {any} */ (ctx.store.db.prepare("SELECT * FROM import_runs WHERE id = ?").get(id));
    const hashOf = file => new Promise((resolve, reject) => { const h = crypto.createHash("sha256"); fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject); });
    // The person at this device's own surfaces: an import sends this device's sessions, so a phone
    // (which has none) never starts one; callers holds the rest out before this runs.
    const person = caller => PEOPLE.includes(String(caller));
    const send = async (id, items, mode) => {
      const known = (await projects().catch(() => [])).flatMap(p => p.folders);
      const upd = ctx.store.db.prepare("UPDATE import_runs SET sent = sent + ?, failed = failed + ?, quarantined = quarantined + ? WHERE id = ?");
      for (let i = 0; i < items.length; i += BATCH) {
        if (!current || current.id !== id || current.stop) break;
        const files = [];
        // A Codex or Gemini CLI session is converted to Claude Code's shape into a staging folder just
        // for this batch (the reader opens only its allowlisted files), and that copy is what is sent.
        let stage = null;
        for (const it of items.slice(i, i + BATCH)) {
          try {
            let item = it;
            if (it.format) {
              const conv = formatFor(it.format)?.convert(it.home, it.path, { cwd: it.cwd, candidates: known });
              if (!conv || !conv.text) throw new Error("nothing to convert");
              if (!stage) { const base = root ? path.join(root, ".import-stage") : os.tmpdir(); fs.mkdirSync(base, { recursive: true, mode: 0o700 }); stage = fs.mkdtempSync(path.join(base, "b-")); }
              const staged = path.join(stage, `${files.length}-${crypto.randomBytes(3).toString("hex")}.jsonl`);
              fs.writeFileSync(staged, conv.text, { mode: 0o600 });
              item = { ...it, path: staged, bytes: Buffer.byteLength(conv.text) };
            }
            files.push({ path: item.path, rel: item.rel, bytes: item.bytes, hash: await hashOf(item.path) });
          } catch { upd.run(0, 1, 0, id); }
        }
        let r;
        try { r = await ctx.call("sync.send", { files, mode }); } finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
        const d = r?.data || {};
        if (r?.error) { upd.run(0, files.length, 0, id); ctx.log(`import ${id}: sending failed: ${r.error.message}`); if (r.error.code === "no_such_tool") break; continue; }
        upd.run(Number(d.sent) || 0, Number(d.failed) || 0, Number(d.quarantined) || 0, id);
        soon();
      }
      const stopped = !current || current.id !== id || current.stop;
      ctx.store.db.prepare("UPDATE import_runs SET state = ?, ended = ? WHERE id = ?").run(stopped ? "stopped" : "done", Date.now(), id);
      if (current && current.id === id) current = null;
      soon();
    };

    ctx.tool("import.start", {
      description: "Import a plan the person confirmed: { plan, mode: once (these sessions) | sync (these, then new ones too), pace: fast (understood in hours, uses more of the Claude plan's normal limits today) | gentle (over days) }. Never adds paid usage. The person's own action with a person session, never an agent. Records their consent with the server (sync.consent) and sends the plan's sessions through federation's sender, a batch at a time; progress comes as import.progress. Returns { run, sessions, mode, pace }.",
      input: { type: "object", required: ["plan", "mode", "pace"], properties: { plan: { type: "string" }, mode: { type: "string", enum: ["once", "sync"] }, pace: { type: "string", enum: ["fast", "gentle"] } } },
      callers: PEOPLE,
      run: async ({ plan, mode, pace }, meta = {}) => {
        if (!person(meta.caller)) throw Object.assign(new Error("an import is the person's own action"), { code: "denied" });
        const p = plans.get(String(plan));
        if (!p || Date.now() - p.at > PLAN_TTL_MS) throw Object.assign(new Error("that plan has expired or was never made: choose again"), { code: "not_found" });
        if (current) throw Object.assign(new Error("an import is already running: stop it first"), { code: "busy" });
        const m = machine();
        // Consent goes to the server's own record, through federation's one door; the plan's hash
        // goes with this run, so a different plan is a different consent (e2e).
        const c = await consent({ machine: m, on: true, mode, plan: p.hash });
        if (c?.error) throw Object.assign(new Error(c.error.code === "no_such_tool" ? "this device cannot send to a server yet" : `the server did not take the consent: ${c.error.message}`), { code: c.error.code === "no_such_tool" ? "unavailable" : "failed" });
        await ctx.call("memory.pace", { pace });
        const id = "imp_" + crypto.randomBytes(6).toString("hex");
        ctx.store.db.prepare("INSERT INTO import_runs (id, at, machine, plan_hash, mode, pace, state, of) VALUES (?,?,?,?,?,?,'sending',?)").run(id, Date.now(), m, p.hash, mode, pace, p.items.length);
        current = { id, stop: false, done: null };
        current.done = send(id, p.items, mode).catch(e => ctx.log(`import ${id} failed: ${e.message}`));
        plans.delete(String(plan));
        return { run: id, sessions: p.items.length, mode, pace };
      },
    });
    ctx.tool("import.stop", {
      description: "Stop sending: the files already sent stay, and so does everything made from them. For a sync import, new sessions stop going too (the server's consent turns off). Deletes nothing.",
      input: { type: "object", properties: {} },
      callers: PEOPLE,
      run: async (_, meta = {}) => {
        if (!person(meta.caller)) throw Object.assign(new Error("stopping an import is the person's own action"), { code: "denied" });
        const r = current; if (r) { r.stop = true; await r.done; }
        await consent({ machine: machine(), on: false });
        return { stopped: Boolean(r) };
      },
    });
    ctx.tool("import.cancel", {
      description: "Stop this import. What it already sent stays until the server can drop just this import's files (a per-import delete, coming from federation); deleting everything a device sent is the person's own previewed action in Settings, never a cancel.",
      input: { type: "object", properties: {} },
      callers: PEOPLE,
      run: async (_, meta = {}) => {
        if (!person(meta.caller)) throw Object.assign(new Error("cancelling an import is the person's own action"), { code: "denied" });
        const r = current; if (r) { r.stop = true; await r.done; }
        await consent({ machine: machine(), on: false });
        if (r) ctx.store.db.prepare("UPDATE import_runs SET state = 'cancelled' WHERE id = ?").run(r.id);
        return { stopped: Boolean(r), dropped: false };
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
      // Fast: batches of 50 a minute within the plan's normal limits; gentle: the default 20 a
      // minute, at most the daily cap a day. Neither ever adds paid usage.
      return { turns, fast: { hours: Math.max(1, Math.ceil(turns / 50 / 60)) }, gentle: { days: Math.max(1, Math.ceil(usd / daily), Math.ceil(turns / 20 / 60 / 24)) } };
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
        const run = /** @type {any} */ (ctx.store.db.prepare("SELECT * FROM import_runs ORDER BY at DESC LIMIT 1").get());
        return {
          ...(run ? { upload: { done: Number(run.sent), total: Number(run.of), failed: Number(run.failed), quarantined: Number(run.quarantined), state: String(run.state), mode: String(run.mode), pace: String(run.pace) } } : {}),
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
    const offs = ["session.indexed", "recall.embedded", "memory.curated", "sync.sending", "sync.sent"].map(type => ctx.events.on(type, soon));

    return { async stop() { for (const o of offs) o(); if (timer) clearTimeout(timer); if (current) { current.stop = true; await current.done; } plans.clear(); last = null; } };
  },
};
