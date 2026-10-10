// @ts-check
// learn — Vyre learns from corrections and enforces what it learned (docs/SPEC.md section 7.11).
//
// A lesson that only sits in memory is advice. A lesson here with a check is code the hooks run:
// before a tool runs (harness.rules asks learn.check {stage: "tool"}) and before a turn ends
// (harness.stop asks learn.check {stage: "stop"}). A failed Stop check sends the turn back to
// Claude with the lesson named, at most twice a turn, so a lesson Claude cannot satisfy costs a
// turn two retries rather than a loop. Then the turn ends and the lesson counts as broken.
//
// Nothing becomes a lesson unseen. A correction heard in a prompt is only proposed; Claude is
// told to ask the user, and the user's next prompt decides: a plain yes accepts it here, inside
// Learning, with no tool call (accept by reply); a plain no declines it. The user can also accept
// from their own surface (learn.accept from the CLI, the Capsule or the Deck), or write a lesson
// themselves (learn.add, `/vyre remember`, `vyre learn add`).
//
// Anything that makes Vyre stricter is free; anything that makes it looser needs a person
// (ADR 0007, decision 11). learn.edit only tightens. Lowering, narrowing, removing a check,
// pinning and retiring go through learn.relax and learn.retire, which only owner surfaces may
// call. They ask no presence (the no-nag rule): the callers list and the harness floor, which
// refuses a model's shell that names them, keep models and agents out.
//
// Levels: remind (repeated to Claude, never holds anything), ask (a tool call waits for the
// user; a reply is sent back), block (a tool call is denied; a reply is sent back). A lesson
// broken again moves up one level, unless it is pinned or at its max_level.

//
// Learning hears more than prompts (ADR 0007, decision 6): drafts the user edited or rejected at
// the Gate, files the user reverted, commands that failed and were fixed, calls the user
// declined or denied, and Memory's corrections. Each is a signal with a key, so repeats can be
// counted. Behaviour becomes a proposal on its own (a file reverted in two sessions, a command
// declined three times, tests not re-run after a fix); what no pattern fits waits as a job for a
// model, off the hot path (jobs.js). Every proposal is the user's to accept.
//
// Hooks stay small: a Stop stats at most 20 recent writes and records at most 40 fingerprints;
// housekeeping (pruning, dormancy) runs at most hourly or daily from Stop, never on a timer.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { distill, fromEdit, invalid, atStop, atTool, weakens, sentBack, held, reply, loosens, fileOf, commandPattern, LEVELS, MAX_BLOCKS, CODE, TESTS } from "./checks.js";
import { writeSnapshot, drain, SNAPSHOT } from "./offline.js";
import { SKILL_MIGRATIONS, createSkills, stepsOf } from "./skills.js";
import { toLibrary } from "./to-library.js";
import { createJobs, JOBS_MIGRATION } from "./jobs.js";
import { createMetrics, METRICS_MIGRATION } from "./metrics.js";
import * as sig from "./signals.js";
import { callsOf, runFor, evidenceOf } from "../../lib/skill-skeleton.js";
import { claudeHome } from "../config/index.js";

const MIGRATIONS = [
  `CREATE TABLE learn_lessons (
     id INTEGER PRIMARY KEY, scope TEXT NOT NULL, when_text TEXT NOT NULL, rule TEXT NOT NULL, check_json TEXT,
     level TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL,
     applied INTEGER NOT NULL DEFAULT 0, caught INTEGER NOT NULL DEFAULT 0, broken INTEGER NOT NULL DEFAULT 0,
     created INTEGER NOT NULL, updated INTEGER NOT NULL
   );
   CREATE TABLE learn_signals (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, session TEXT, seq INTEGER, text TEXT, lesson INTEGER);
   CREATE TABLE learn_turns (session TEXT PRIMARY KEY, prompt TEXT, seq INTEGER NOT NULL, started INTEGER NOT NULL, blocks INTEGER NOT NULL, owed TEXT NOT NULL);
   CREATE TABLE learn_commands (session TEXT NOT NULL, command TEXT NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX learn_commands_session ON learn_commands (session, at);`,
  // told: whether the thread has been told about the lesson this signal proposed.
  `ALTER TABLE learn_signals ADD COLUMN told INTEGER NOT NULL DEFAULT 0;`,
  // max_level: the user's cap on escalation (null: block). pinned: no automatic change at all.
  // asked: proposals told to the thread last prompt, which the user's next prompt may answer.
  // learn_state: small values Learning keeps, such as the hash of the snapshot it last wrote.
  `ALTER TABLE learn_lessons ADD COLUMN max_level TEXT;
   ALTER TABLE learn_lessons ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE learn_turns ADD COLUMN asked TEXT NOT NULL DEFAULT '[]';
   CREATE TABLE learn_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE INDEX learn_signals_kind ON learn_signals (kind, at);`,
  // Signals with a fingerprint (ADR 0007, decision 6); lessons keep theirs, when they were
  // accepted and whether they went dormant; the writes and calls Learning watches, for reverts,
  // failures and calls the user said no to. Hashes and shapes only, never content.
  `ALTER TABLE learn_signals ADD COLUMN key TEXT;
   ALTER TABLE learn_signals ADD COLUMN project TEXT;
   ALTER TABLE learn_signals ADD COLUMN agent TEXT;
   ALTER TABLE learn_signals ADD COLUMN meta TEXT;
   CREATE INDEX learn_signals_key ON learn_signals (key, at);
   CREATE INDEX learn_signals_session ON learn_signals (session, kind);
   CREATE INDEX learn_signals_lesson ON learn_signals (lesson, kind);
   ALTER TABLE learn_lessons ADD COLUMN key TEXT;
   ALTER TABLE learn_lessons ADD COLUMN accepted INTEGER;
   ALTER TABLE learn_lessons ADD COLUMN dormant INTEGER NOT NULL DEFAULT 0;
   UPDATE learn_lessons SET accepted = updated WHERE status = 'active';
   ALTER TABLE learn_turns ADD COLUMN project TEXT;
   ALTER TABLE learn_turns ADD COLUMN agent TEXT;
   CREATE TABLE learn_writes (
     session TEXT NOT NULL, path TEXT NOT NULL, project TEXT, h0 TEXT NOT NULL, h1 TEXT, mtime INTEGER, size INTEGER,
     at INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, path)
   );
   CREATE INDEX learn_writes_open ON learn_writes (done, at);
   CREATE TABLE learn_calls (
     id TEXT PRIMARY KEY, session TEXT NOT NULL, tool TEXT NOT NULL, shape TEXT, test INTEGER NOT NULL DEFAULT 0,
     lesson INTEGER, held TEXT, outcome TEXT, at INTEGER NOT NULL
   );
   CREATE INDEX learn_calls_session ON learn_calls (session, at);
   CREATE INDEX learn_commands_at ON learn_commands (at);`,
  JOBS_MIGRATION,
  METRICS_MIGRATION,
  ...SKILL_MIGRATIONS,
  // stopped: whether the thread's turn has passed a Stop. A prompt that arrives while it has not
  // (a forged enrich, or a turn the user interrupted) does not wipe the turn's edits or its count.
  `ALTER TABLE learn_turns ADD COLUMN stopped INTEGER NOT NULL DEFAULT 1;`,
  // PreToolUse and a revert look writes up by path.
  `CREATE INDEX learn_writes_path ON learn_writes (path, done);`,
];

export { MAX_BLOCKS };
/** The surfaces a person uses, for what only reads (learn.signals). */
const OWNER = ["cli", "local", "deck", "capsule"];
/**
 * Who may call the human-only tools (accept, retire, relax, skill-install, skill-retire,
 * skill-dismiss): only a surface that names itself. Not "local", which any socket client gets by
 * sending no header, nor MCP, agents or hooks. A model can still claim "cli", so vyred also
 * checks the `presence` these tools declare (ADR 0004), and weakens() asks before a model's shell
 * reaches them.
 */
const HUMAN = ["cli", "deck", "capsule"];
/** Declared lists (the registry would otherwise default these writes to the person and modules). The hooks reach learn.signal, observe and check through harness (module). */
const HOOKS_ONLY = ["module"];
/** learn.add makes a lesson active at once: the person's surfaces and modules only. DESIGN CHOICE (see the report): the /vyre lesson command reaches it as a model. */
const ADDERS = [...OWNER, "module", "mcp"];
/** learn.edit only tightens (learn.relax is the person's), so a model may do it. */
const TIGHTENERS = [...OWNER, "module", "mcp", "harness"];
/**
 * A refusal only a person can get past: the error carries code "presence_required" (the
 * registry passes a short code through), so a surface can run its presence flow and call the
 * named human-only tool; `detail` says which tool and lesson.
 * @param {string} message @param {{ tool: string, id?: number }} detail
 */
export function presenceRequired(message, detail) {
  return Object.assign(new Error(message), { code: "presence_required", detail });
}
const HOUR = 3600 * 1000, DAY = 24 * HOUR, WEEK = 7 * DAY;
/** Per-turn rows (commands, calls, writes, turns) are kept this long. */
const KEEP = WEEK;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

/** The user themself, as Memory names them in a taught fact (its node `me:you`). */
export const ME = Object.freeze({ kind: "me" });

const scopeSchema = { anyOf: [{ type: "string" }, { type: "object" }] };
const checkSchema = { type: "object" };

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const now = () => Date.now();

    const row = r => r && {
      id: r.id, scope: JSON.parse(r.scope), when: r.when_text, rule: r.rule, check: r.check_json ? JSON.parse(r.check_json) : null,
      level: r.level, status: r.status, source: JSON.parse(r.source), applied: r.applied, caught: r.caught, broken: r.broken,
      max_level: r.max_level ?? null, pinned: Boolean(r.pinned), key: r.key ?? null, accepted: r.accepted ?? null, dormant: Boolean(r.dormant),
      created: r.created, updated: r.updated,
    };
    const get = id => row(db.prepare("SELECT * FROM learn_lessons WHERE id = ?").get(id));
    const active = () => db.prepare("SELECT * FROM learn_lessons WHERE status = 'active' ORDER BY id").all().map(row);
    const must = id => { const l = get(id); if (!l) throw new Error(`no lesson ${id}`); return l; };

    /** Check a lesson's parts; throws with a readable reason. */
    const clean = ({ rule, when, level, scope, check, max_level, pinned }) => {
      if (rule !== undefined && (typeof rule !== "string" || !rule.trim() || rule.length > 400)) throw new Error("rule must be a sentence, at most 400 characters");
      if (level !== undefined && !LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(", ")}`);
      if (scope !== undefined && scope !== "all" && !(scope && typeof scope === "object" && (typeof scope.project === "string" || typeof scope.agent === "string"))) {
        throw new Error('scope must be "all", { project } or { agent }');
      }
      const bad = invalid(check);
      if (bad) throw new Error(bad);
      if (when !== undefined && typeof when !== "string") throw new Error("when must be a string");
      if (max_level !== undefined && max_level !== null && !LEVELS.includes(max_level)) throw new Error(`max_level must be one of ${LEVELS.join(", ")}, or null`);
      if (pinned !== undefined && typeof pinned !== "boolean") throw new Error("pinned must be true or false");
    };

    /**
     * A project scope holds the project's slug. A name, a home or a folder (what older lessons
     * or a person may give) is turned into the slug when Projects knows it; otherwise it is kept.
     */
    const projectsList = async () => {
      const r = await ctx.call("projects.list", {});
      return r && r.data && Array.isArray(r.data.projects) ? r.data.projects : [];
    };
    const find = (list, v) => list.find(p => p.slug === v || p.name === v || p.home === v || (Array.isArray(p.workspaces) && p.workspaces.includes(v)));
    const slugged = async scope => {
      if (!scope || typeof scope !== "object" || typeof scope.project !== "string") return scope;
      const p = find(await projectsList(), scope.project);
      return p ? { project: p.slug } : scope;
    };

    const insert = db.prepare(`INSERT INTO learn_lessons (scope, when_text, rule, check_json, level, status, source, key, accepted, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    /** @returns {any} */
    const create = (l, status) => {
      clean(l);
      const at = now();
      const check = l.check || null;
      const r = insert.run(JSON.stringify(l.scope ?? "all"), l.when || "always", l.rule.trim(), check ? JSON.stringify(check) : null,
        l.level || (check ? "block" : "remind"), status, JSON.stringify(l.source || { kind: "user" }), l.key || sig.lessonKey({ check, rule: l.rule }),
        status === "active" ? at : null, at, at);
      return get(Number(r.lastInsertRowid));
    };

    // Turns: learn.signal marks one starting (every prompt passes through Enrich); Stop counts
    // how often it sent the turn back. Claude Code's prompt_id names the turn when it sends one.
    const turnOf = session => db.prepare("SELECT * FROM learn_turns WHERE session = ?").get(session);
    const saveTurn = t => db.prepare(`INSERT INTO learn_turns (session, prompt, seq, started, blocks, owed, asked, project, agent, stopped) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (session) DO UPDATE SET prompt = excluded.prompt, seq = excluded.seq, started = excluded.started, blocks = excluded.blocks, owed = excluded.owed,
        asked = excluded.asked, project = excluded.project, agent = excluded.agent, stopped = excluded.stopped`)
      .run(t.session, t.prompt ?? null, t.seq, t.started, t.blocks, t.owed, t.asked || "[]", t.project ?? null, t.agent ?? null, t.stopped == null ? 1 : Number(t.stopped) ? 1 : 0);
    const turn = (session, prompt_id) => {
      const t = turnOf(session) || { session, prompt: null, seq: 0, started: 0, blocks: 0, owed: "[]", asked: "[]", stopped: 1 };
      // A turn Enrich never saw (vyred came up mid-turn): a new turn from here. Its block count is
      // not reset by a new prompt_id: only a real prompt (learn.signal) or a Stop that Claude Code
      // says is not a continuation (stop_hook_active false) starts the count over, so a turn at
      // the cap cannot win more tries by showing another prompt_id.
      if (prompt_id && t.prompt && t.prompt !== prompt_id) Object.assign(t, { prompt: prompt_id, seq: t.seq + 1 });
      return t;
    };

    const metrics = createMetrics(db, now);
    const bumpRow = db.prepare("UPDATE learn_lessons SET applied = applied + ?, caught = caught + ?, broken = broken + ?, level = ?, updated = ? WHERE id = ?");
    /** Count what a lesson did, today too; catching or breaking wakes a dormant lesson. */
    const bump = (applied, caught, broken, level, id) => {
      bumpRow.run(applied, caught, broken, level, now(), id);
      metrics.tally(id, { applied, caught, broken });
      if (caught || broken) db.prepare("UPDATE learn_lessons SET dormant = 0 WHERE id = ? AND dormant = 1").run(id);
    };
    const addSignal = db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson, told, key, project, agent, meta) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    /**
     * A signal: { kind, session, seq, project, agent, key, lesson?, meta }. `text` is only ever a
     * prompt or a summary Learning wrote; `meta` is small (shapes, kinds, counts).
     * @param {{ kind: string, session?: string|null, seq?: number|null, project?: string|null, agent?: string|null, key?: string|null,
     *           lesson?: number|null, meta?: any, text?: string|null, told?: number }} s
     */
    const note = s => Number(addSignal.run(now(), s.kind, s.session || null, s.seq ?? null, s.text ?? null, s.lesson ?? null, s.told ?? 1,
      s.key ?? null, s.project ?? null, s.agent ?? null, s.meta == null ? null : JSON.stringify(s.meta)).lastInsertRowid);
    const signal = (kind, session, lesson, text = null) => note({ kind, session, lesson, text });
    /**
     * A lesson ended a turn (or ran a tool) still failing: count it, and move it up a level the
     * second time, unless it is pinned or already at its max_level. The break is a signal too, so
     * the brief can say how often it happened this week.
     */
    const broke = async (l, session, owe, stage) => {
      const from = l.level;
      const top = LEVELS.indexOf(l.max_level || "block");
      const next = LEVELS.indexOf(from) + 1;
      const to = !l.pinned && l.broken + 1 >= 2 && next <= top ? LEVELS[next] : from;
      bump(0, 0, 1, to, l.id);
      signal("broken", session, l.id);
      ctx.events.emit("lesson.broken", { lesson: l.id, session: session || null, level: from, stage }, { thread: session || undefined });
      if (to !== from) { ctx.events.emit("lesson.escalated", { lesson: l.id, from, to }); await snap(); }
      owe.push(l.id);
    };

    /**
     * The lessons that apply here: scope "all", this project, or this agent. A project scope
     * holds the slug; a lesson that holds the project's name, home or a folder still applies.
     */
    const inScope = async (lessons, { cwd, agent }, known = undefined) => {
      let p = known === undefined ? null : known;
      if (known === undefined && cwd && lessons.some(l => l.scope && l.scope.project)) {
        const r = await ctx.call("projects.of", { cwd });
        p = r && r.data ? r.data : null;
      }
      const here = v => Boolean(p) && (v === p.slug || v === p.name || v === p.home || (Array.isArray(p.folders) && p.folders.includes(v)));
      return lessons.filter(l => l.scope === "all" || (l.scope.project && here(l.scope.project)) || (l.scope.agent && l.scope.agent === agent));
    };

    /** Files changed in this thread since `since`, newest first, from the Harness. */
    const touchedSince = async (session, since, limit = 500) => {
      const r = await ctx.call("harness.touched", { session, limit });
      return r && Array.isArray(r.data) ? r.data.filter(f => f.at >= since) : [];
    };

    // The hooks' copy of the accepted lessons, for when vyred is down (offline.js). Rewritten on
    // every change; a home that cannot be written costs the offline checks, never a tool call.
    // Project lessons carry their project's folders, so the hook can match cwd with no Projects.
    // vyred keeps the hash of what it wrote; a file that differs at the next start was changed
    // by someone else, which is recorded (never its content) and undone.
    const root = ctx.paths && ctx.paths.root;
    const state = key => { const r = db.prepare("SELECT value FROM learn_state WHERE key = ?").get(key); return r ? String(r.value) : null; };
    const setState = (key, value) => db.prepare("INSERT INTO learn_state (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
    const snap = async () => {
      if (!root) return;
      try {
        const list = active().some(l => l.scope && l.scope.project) ? await projectsList() : [];
        const folders = {};
        for (const l of active()) if (l.scope && l.scope.project) {
          const p = find(list, l.scope.project);
          if (p) folders[l.id] = { project: p.slug, folders: Array.isArray(p.workspaces) && p.workspaces.length ? p.workspaces : [p.home] };
        }
        setState("snapshot", sha256(writeSnapshot(root, active(), folders)));
      } catch (e) { ctx.log("lessons snapshot not written: " + /** @type {Error} */ (e).message); }
    };
    if (root) {
      const want = state("snapshot");
      let have = null;
      try { have = sha256(fs.readFileSync(path.join(root, SNAPSHOT), "utf8")); } catch {}
      if (want && have !== want) {
        signal("tampered", null, null);
        ctx.events.emit("lesson.tampered", {});
        ctx.log(`${SNAPSHOT} was ${have ? "changed" : "removed"} while vyred was down; rewritten`);
      }
    }
    // What the hooks caught or saw broken while vyred was down, counted now, escalation included.
    if (root) for (const e of drain(root)) {
      const l = get(e.lesson);
      if (!l || l.status !== "active") continue;
      if (e.kind === "caught") {
        bump(0, 1, 0, l.level, l.id);
        ctx.events.emit("lesson.caught", { lesson: l.id, session: e.session || null, stage: "offline" }, { thread: e.session || undefined });
      } else if (e.kind === "broken") await broke(l, e.session, [], "offline");
    }
    await snap();

    // Drafts the user edited before approving (the Gate). The event carries no content; gate.get
    // gives the draft and what was sent. Only a summary is kept here, never the message itself.
    const text = v => (typeof v === "string" ? v : v && typeof v === "object" ? String(v.body ?? v.text ?? "") : "");
    const offEdit = ctx.events.on("gate.released", e => { edited(e).catch(err => ctx.log("edited draft not read: " + err.message)); });
    const edited = async e => {
      const p = e.payload || {};
      if (!p.edited || p.id == null) return;
      const r = await ctx.call("gate.get", { id: p.id });
      const d = r && r.data;
      if (!d) return;
      const session = p.thread || e.thread || null;
      const diff = d.diff || {};
      const summary = `edited draft ${p.id}: ${(diff.removed || []).length} removed, ${(diff.added || []).length} added`;
      const found = fromEdit(text(d.draft), text(d.final));
      if (!found.length) {
        db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson) VALUES (?,?,?,?,?,NULL)").run(now(), "edited", session, null, summary);
        return;
      }
      for (const f of found) {
        const same = db.prepare("SELECT id FROM learn_lessons WHERE status IN ('active','proposed') AND check_json = ?").get(JSON.stringify(f.check));
        let id = same ? same.id : null;
        if (!same) {
          const l = create({ ...f, scope: p.agent ? { agent: String(p.agent) } : "all", source: { kind: "edited", session, draft: p.id } }, "proposed");
          id = l.id;
          ctx.events.emit("lesson.proposed", { lesson: l.id, rule: l.rule, checked: true }, { thread: session || undefined });
        }
        db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson, told) VALUES (?,?,?,?,?,?,?)").run(now(), "edited", session, null, summary, id, same ? 1 : 0);
      }
    };

    const off = ctx.events.on("tool.held", e => {
      const p = e.payload || {};
      if (p.lesson) return;                  // held by a lesson: already counted as caught
      note({ kind: "denied", session: p.session || null, key: p.rule != null ? `floor:${p.rule}` : null, text: `${p.tool} ${p.decision} by floor rule ${p.rule}`,
        meta: { tool: p.tool, decision: p.decision, rule: p.rule ?? null } });
    });

    // ---- More signals (ADR 0007, decision 6) -----------------------------------------------

    // A draft the user rejected at the Gate. Counted; what it said is never read.
    const offRejected = ctx.events.on("gate.rejected", e => {
      const p = e.payload || {};
      note({ kind: "rejected", session: e.thread || null, project: e.project || null, key: `gate:${p.kind || "draft"}`, meta: { draft: p.id ?? null, kind: p.kind || null, via: p.via || null } });
    });

    // Memory's corrections: counted per extraction rule. A rule the user corrects again and again
    // is a curation bug to see in `vyre learn signals`, not a lesson for Claude.
    const offCorrected = ctx.events.on("memory.corrected", e => {
      const p = e.payload || {};
      note({ kind: "corrected", key: p.prior_rule != null ? `rule:${p.prior_rule}` : null,
        meta: { correction: p.id ?? null, action: p.action || null, rel: p.rel ?? null, scope: p.scope || null, prior_source: p.prior_source ?? null,
          prior_rule: p.prior_rule ?? null, prior_confidence: typeof p.prior_confidence === "number" ? p.prior_confidence : null } });
    });

    /** Projects, by slug, for folders and homes. */
    const projectBySlug = async slug => (slug ? find(await projectsList(), slug) || null : null);
    const projectOf = async cwd => {
      if (!cwd) return null;
      const r = await ctx.call("projects.of", { cwd });
      return r && r.data ? r.data : null;
    };

    /**
     * A proposal Learning drafted from behaviour or a model, not from the user's own words. Never
     * block; told once in the thread it came from. Nothing when the same check already exists.
     */
    const propose = async ({ rule, check, level, scope, source, key, session, why, meta = {} }) => {
      if (check && db.prepare("SELECT 1 FROM learn_lessons WHERE status IN ('active','proposed') AND check_json = ? LIMIT 1").get(JSON.stringify(check))) return null;
      const l = create({ rule, when: "always", level: level === "ask" ? "ask" : "remind", scope: scope ?? "all", check: check || null, source, key }, "proposed");
      ctx.events.emit("lesson.proposed", { lesson: l.id, rule: l.rule, checked: Boolean(l.check) }, { thread: session || undefined });
      if (session) note({ kind: "proposed", session, lesson: l.id, key, meta: { why, ...meta }, told: 0 });
      return l;
    };

    // Files Claude writes: hashed before (at PreToolUse) and after (PostToolUse), then, at the next
    // prompt or Stop in that project, at most 20 recent writes are statted. Back to the old hash is
    // `reverted`; changed to something else is `rewritten`. A change Claude's own shell made in
    // that session (a git checkout, a command naming the file) is neither.
    const beforeWrite = (session, file, project) => {
      const st = sig.fileState(file);
      if (!st) return;                                                 // too big or unreadable: not watched
      for (const w of db.prepare("SELECT * FROM learn_writes WHERE path = ? AND done = 0 AND h1 IS NOT NULL").all(file)) {
        if (st.hash !== w.h1) settle(w, st.hash);
        else if (w.session !== session) db.prepare("UPDATE learn_writes SET done = 1 WHERE session = ? AND path = ?").run(w.session, file);
      }
      db.prepare(`INSERT INTO learn_writes (session, path, project, h0, at) VALUES (?,?,?,?,?)
        ON CONFLICT (session, path) DO UPDATE SET project = excluded.project, h0 = excluded.h0, h1 = NULL, mtime = NULL, size = NULL, at = excluded.at, done = 0
        WHERE learn_writes.done = 1`).run(session, file, project ?? null, st.hash, now());
    };
    const afterWrite = (session, file) => {
      const st = sig.fileState(file);
      if (!st) return;
      db.prepare("UPDATE learn_writes SET h1 = ?, mtime = ?, size = ?, at = ? WHERE session = ? AND path = ? AND done = 0").run(st.hash, st.mtime, st.size, now(), session, file);
    };
    const OWN_UNDO = /\bgit\s+(checkout|restore|reset|stash|revert|switch|pull|merge|rebase|apply|am)\b|\bpatch\b/;
    /** A write someone changed since Claude made it. */
    const settle = (w, hash) => {
      db.prepare("UPDATE learn_writes SET done = 1 WHERE session = ? AND path = ?").run(w.session, w.path);
      const base = path.basename(String(w.path));
      const own = db.prepare("SELECT command FROM learn_commands WHERE session = ? AND at >= ?").all(w.session, w.at).map(r => String(r.command));
      if (own.some(c => c.includes(base) || OWN_UNDO.test(c))) return null;
      const kind = hash === w.h0 ? "reverted" : "rewritten";
      const key = sig.fileKey(w.path);
      note({ kind, session: w.session, project: w.project ?? null, key, meta: { ext: path.extname(base).slice(1, 9) || null } });
      return kind === "reverted" ? { key, w } : null;
    };
    /** Stat the recent writes in a project; propose a path check for a file reverted in two sessions. */
    const sweep = async project => {
      const found = [];
      for (const w of db.prepare("SELECT * FROM learn_writes WHERE done = 0 AND h1 IS NOT NULL AND project IS ? AND at >= ? ORDER BY at DESC LIMIT 20").all(project ?? null, now() - KEEP)) {
        const st = sig.fileStat(String(w.path));
        if (st.mtime === Number(w.mtime) && st.size === Number(w.size)) continue;
        const full = sig.fileState(String(w.path));
        if (!full) { db.prepare("UPDATE learn_writes SET done = 1 WHERE session = ? AND path = ?").run(w.session, w.path); continue; }
        if (full.hash === w.h1) { db.prepare("UPDATE learn_writes SET mtime = ?, size = ? WHERE session = ? AND path = ?").run(full.mtime, full.size, w.session, w.path); continue; }
        const r = settle(w, full.hash);
        if (r) found.push(r);
      }
      for (const { key, w } of found) {
        const sessions = Number(/** @type {any} */ (db.prepare("SELECT COUNT(DISTINCT session) AS n FROM learn_signals WHERE kind = 'reverted' AND key = ? AND at >= ?").get(key, now() - 30 * DAY)).n);
        if (sessions < 2) continue;
        const p = await projectBySlug(w.project);
        const folders = p ? (Array.isArray(p.workspaces) && p.workspaces.length ? p.workspaces : [p.home]).map(String) : [];
        const home = folders.find(f => String(w.path).startsWith(f + path.sep));
        const rel = home ? path.relative(home, String(w.path)) : String(w.path);
        await propose({ rule: `Do not change ${rel} unless the user asks for it.`, level: "ask", scope: w.project ? { project: String(w.project) } : "all",
          check: { kind: "path", pattern: `(^|/)${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, label: rel }, source: { kind: "reverted" }, key, session: String(w.session), why: "reverted" });
      }
    };

    /** Calls whose PostToolUse Claude Code sends: a call with none by Stop was not run. */
    const addCall = db.prepare("INSERT OR IGNORE INTO learn_calls (id, session, tool, shape, test, lesson, held, outcome, at) VALUES (?,?,?,?,?,?,?,NULL,?)");
    const callOf = id => /** @type {any} */ (db.prepare("SELECT * FROM learn_calls WHERE id = ?").get(id));
    const setOutcome = (id, outcome) => db.prepare("UPDATE learn_calls SET outcome = ? WHERE id = ? AND outcome IS NULL").run(outcome, id);

    /** A lesson that asked: the user's answer, and a demotion proposed after 5 allowed out of 5. */
    const answered = (lesson, kind, session) => {
      note({ kind, session, lesson, key: null, meta: { answer: kind } });
      const l = get(lesson);
      if (!l || l.status !== "active" || l.level !== "ask" || kind !== "allowed") return;
      const since = Number(state(`demote:${lesson}`) || 0);
      const last = db.prepare("SELECT kind FROM learn_signals WHERE lesson = ? AND kind IN ('allowed','denied') AND at > ? ORDER BY id DESC LIMIT 5").all(lesson, since);
      if (last.length === 5 && last.every(r => r.kind === "allowed")) {
        setState(`demote:${lesson}`, String(now()));
        // The user decides: an event for the Deck and the Capsule, nothing changes here.
        ctx.events.emit("lesson.allowed", { lesson, allowed: 5, asked: 5, level: "ask", propose: "remind" });
      }
    };

    /** A command shape the user said no to 3 times in 14 days, and never yes: propose asking first. */
    const maybeHold = async (shape, key, session, project) => {
      const words = String(shape).split(" ");
      if (!words[0] || words[0].startsWith("<")) return;
      const since = now() - 14 * DAY;
      // A missing PostToolUse cannot tell the user's no from a Claude Code settings rule that refused
      // the call, so one session is not enough: 3 nos, in at least 2 sessions.
      const counts = /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT session) AS sessions FROM learn_signals WHERE key = ? AND kind IN ('declined','denied') AND at >= ?").get(key, since));
      const no = Number(counts.n);
      if (no < 3 || Number(counts.sessions) < 2) return;
      const yes = db.prepare("SELECT 1 FROM learn_signals WHERE key = ? AND kind = 'allowed' AND at >= ? LIMIT 1").get(key, since)
        || db.prepare("SELECT 1 FROM learn_calls WHERE shape = ? AND outcome = 'ok' AND at >= ? LIMIT 1").get(shape, since);
      if (yes) return;
      const rest = words.slice(1).filter(w => !w.startsWith("<"));
      const sub = rest[0] && !rest[0].startsWith("-") ? rest[0] : "";
      const flags = rest.filter(w => w.startsWith("-"));
      await propose({ rule: `Ask the user before running ${shape.replace(/ <[a-z]+>/g, "")}.`, level: "ask", scope: project ? { project } : "all",
        check: { kind: "tool", tool: "Bash", command: commandPattern(words[0], sub, flags), label: "`" + [words[0], sub, ...flags].filter(Boolean).join(" ") + "`" },
        source: { kind: "declined" }, key, session, why: "declined", meta: { times: no } });
    };

    // A permission question answered on a Switchboard thread: the user's yes or no, by shape.
    const offAnswered = ctx.events.on("ask.answered", e => { onAnswer(e).catch(err => ctx.log("answer not counted: " + err.message)); });
    const onAnswer = async e => {
      const p = e.payload || {};
      // A paired Mac's ask, relayed to the box (source "mac"): the Mac's own learn counts it there.
      if (p.source === "mac") return;
      const session = e.thread || p.thread || null;
      if (!session || !["allow", "deny"].includes(p.decision) || !p.tool) return;
      const c = /** @type {any} */ (db.prepare("SELECT * FROM learn_calls WHERE session = ? AND tool = ? AND outcome IS NULL ORDER BY at DESC LIMIT 1").get(session, p.tool));
      const shape = c && c.shape ? String(c.shape) : p.tool === "Bash" && p.summary ? sig.shape(p.summary) : null;
      const key = shape ? sig.commandKey(shape) : sig.toolKey(p.tool);
      if (p.decision === "deny") {
        if (c) setOutcome(c.id, "denied");
        note({ kind: "denied", session, project: e.project || null, key, meta: { tool: p.tool, shape } });
        if (c && c.held === "ask" && c.lesson) answered(Number(c.lesson), "denied", session);
        if (shape) await maybeHold(shape, key, session, e.project || null);
      } else {
        // Allowed: the lesson's answer is counted when the call runs (PostToolUse), not twice.
        note({ kind: "allowed", session, project: e.project || null, key, meta: { tool: p.tool, shape } });
      }
    };

    ctx.tool("learn.lessons", {
      effect: "read",
      description: "The lessons Vyre learned from the user, with how often each applied, was caught and was broken.",
      input: { type: "object", properties: { status: { type: "string", enum: ["active", "proposed", "retired", "all"], description: "default: active and proposed" } } },
      run: async ({ status }) => {
        const where = !status ? "status IN ('active','proposed')" : status === "all" ? "1" : "status = ?";
        return db.prepare(`SELECT * FROM learn_lessons WHERE ${where} ORDER BY id`).all(...(status && status !== "all" ? [status] : [])).map(row);
      },
    });

    ctx.tool("learn.add", {
      effect: "write",
      description: "Add a lesson the user wrote or asked for (/vyre remember): text or rule. A known shape becomes a check; anything else is a reminder.",
      callers: ADDERS,
      input: { type: "object", properties: { text: { type: "string", description: "the lesson in plain words" }, rule: { type: "string" }, when: { type: "string" }, level: { type: "string", enum: LEVELS }, scope: scopeSchema, check: checkSchema, session: { type: "string" } } },
      run: async ({ text, rule, when, level, scope, check, session }, extra = {}) => {
        const d = text && !rule ? distill(text) : null;
        if (!rule && !d && !text) throw new Error("say the lesson: text, or rule");
        // A lesson steers every later session, so only the PERSON makes one outright. With the kernel on that is the call's chain (one person, no agent, no session-token hop); a model's
        // `/vyre lesson` (a session calling as itself) makes a PROPOSED lesson the person accepts with learn.accept from their own surface. SHIM(legacy labels): with the kernel off, the
        // model's labels (`mcp`, `harness`) are the model.
        let person;
        if (ctx.kernel && typeof ctx.kernel.chain === "function") {
          const c = await ctx.kernel.chain(extra).catch(() => null);
          person = Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person" && c.viewer !== true && c.delegated !== true && !c.room);
        } else person = !/^(?:mcp|harness)(?::|\s|$)/.test(String(extra.caller || ""));
        const l = create({ rule: rule || (d ? d.rule : String(text)), when: when || (d && d.when) || "always", level: level || (d ? d.level : undefined),
          scope: await slugged(scope), check: check !== undefined ? check : d ? d.check : null, source: { kind: "remember", session: session || null, text: text || rule, ...(person ? {} : { proposedBy: "session" }) } }, person ? "active" : "proposed");
        if (person) { ctx.events.emit("lesson.learned", { lesson: l.id, rule: l.rule, level: l.level, checked: Boolean(l.check) }); await snap(); }
        else ctx.events.emit("lesson.proposed", { lesson: l.id, rule: l.rule, checked: Boolean(l.check) }, { thread: session || undefined });
        return l;
      },
    });

    /**
     * An accepted "use pnpm not npm" teaches Memory that the user prefers pnpm (teaches.memory
     * "preference"), keyed by the lesson, and retiring the lesson forgets it. Without Memory, nothing.
     * The subject is the user themself: Memory's own node for them is `me:you` (curator ME, kind
     * "me"), so it is named by kind, `{ kind: "me" }`, never by a name, which would make a person
     * called "the user". Memory's teach() does not map kind "me" yet (team/archive/work-journals/learning.md, Needs):
     * until it does, it refuses the fact and the preference is logged as not taught.
     */
    const prefer = async (l, forget) => {
      const p = l.source && l.source.prefers;
      if (!p || !ctx.memory || typeof ctx.memory.teach !== "function") return;
      try {
        const proj = l.scope && l.scope.project ? await projectBySlug(l.scope.project) : null;
        const cwds = proj ? (Array.isArray(proj.workspaces) && proj.workspaces.length ? proj.workspaces : [proj.home]).map(String) : null;
        await ctx.memory.teach("preference", { subject: ME, rel: "prefers", object: { name: String(p.use) }, text: `The user prefers ${p.use} over ${p.over}.`,
          key: `lesson:${l.id}`, ...(cwds ? { project_cwds: cwds } : {}), ...(forget ? { forget: true } : {}) });
      } catch (e) { ctx.log("preference not taught: " + /** @type {Error} */ (e).message); }
    };
    /** Put a proposed lesson in force. `via` says how the user accepted it. */
    const activate = async (l, via) => {
      db.prepare("UPDATE learn_lessons SET status = 'active', source = ?, accepted = ?, updated = ? WHERE id = ?").run(JSON.stringify({ ...l.source, accepted: via }), now(), now(), l.id);
      ctx.events.emit("lesson.learned", { lesson: l.id, rule: l.rule, level: l.level, checked: Boolean(l.check) });
      await snap();
      const a = get(l.id);
      await prefer(a, false);
      return a;
    };
    /** Retire a lesson; a proposal the user said no to is noted as declined, one a better draft took over as replaced. */
    const retire = async (l, declined = false, replaced = null) => {
      const source = declined ? { ...l.source, declined: true } : replaced ? { ...l.source, replaced_by: replaced } : l.source;
      db.prepare("UPDATE learn_lessons SET status = 'retired', source = ?, updated = ? WHERE id = ?").run(JSON.stringify(source), now(), l.id);
      ctx.events.emit("lesson.retired", { lesson: l.id, ...(declined ? { declined: true } : {}), ...(replaced ? { replaced } : {}) });
      await snap();
      if (l.status === "active") await prefer(l, true);
      return get(l.id);
    };
    /** Write a change to a lesson's columns. */
    const apply = async (id, change) => {
      const cols = { rule: "rule", when: "when_text", level: "level", scope: "scope", check: "check_json", max_level: "max_level", pinned: "pinned" };
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(cols)) if (change[k] !== undefined) {
        sets.push(`${col} = ?`);
        vals.push(k === "scope" ? JSON.stringify(change[k]) : k === "check" ? (change[k] ? JSON.stringify(change[k]) : null)
          : k === "pinned" ? (change[k] ? 1 : 0) : k === "rule" ? String(change[k]).trim() : change[k]);
      }
      if (sets.length) db.prepare(`UPDATE learn_lessons SET ${sets.join(", ")}, updated = ? WHERE id = ?`).run(...vals, now(), id);
      await snap();
      return get(id);
    };

    const levelSchema = { type: "string", enum: LEVELS };
    const changeSchema = { rule: { type: "string" }, when: { type: "string" }, level: levelSchema, scope: scopeSchema,
      check: { anyOf: [checkSchema, { type: "null" }] }, max_level: { anyOf: [levelSchema, { type: "null" }] }, pinned: { type: "boolean" } };

    ctx.tool("learn.accept", {
      effect: "write",
      description: "Accept a proposed lesson. Only the user can: from the CLI, the Capsule or the Deck; an agent is refused. In a thread the user accepts by replying yes; nothing needs calling.",
      callers: HUMAN,
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => {
        const l = must(id);
        if (l.status === "active") return l;
        if (l.status !== "proposed") throw new Error(`lesson ${id} is ${l.status}`);
        return activate(l, "presence");
      },
    });

    ctx.tool("learn.edit", {
      effect: "write",
      description: "Tighten a lesson: raise level, widen scope or `when`, add a check, change its cap, unpin. Loosening is refused; that is learn.relax.",
      callers: TIGHTENERS,
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, ...changeSchema } },
      run: async ({ id, ...change }) => {
        const l = must(id);
        // A proposal is accepted as the user was shown it; changing it first would accept something else.
        if (l.status === "proposed") throw presenceRequired(`lesson ${id} is proposed: the user accepts it as they were shown it (learn.accept, from their own surface), then it can be tightened`, { tool: "learn.accept", id });
        clean(change);
        if (change.scope !== undefined) change.scope = await slugged(change.scope);
        const loose = loosens(l, change);
        if (loose.length) throw presenceRequired(`this change ${loose.join(", ")}, which weakens lesson ${id}. Weakening a lesson is the user's call: learn.relax, from the CLI or the Deck.`, { tool: "learn.relax", id });
        return apply(id, change);
      },
    });

    ctx.tool("learn.relax", {
      effect: "write",
      description: "Loosen a lesson: lower its level, narrow or move its scope, narrow `when`, change or remove its check, lower its cap, pin it, or rewrite its rule. Only the user can, from their own surfaces; an agent is refused.",
      callers: HUMAN,
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, ...changeSchema } },
      run: async ({ id, ...change }) => {
        must(id);
        clean(change);
        if (change.scope !== undefined) change.scope = await slugged(change.scope);
        return apply(id, change);
      },
    });

    ctx.tool("learn.retire", {
      effect: "write",
      description: "Retire a lesson, or decline a proposed one. Only the user can, from their own surfaces; an agent is refused.",
      callers: HUMAN,
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => retire(must(id)),
    });

    // ---- Skills from repeated procedures (ADR 0007, decision 10) ----------------------------

    const skills = createSkills(db, { now, emit: (type, payload) => ctx.events.emit(type, payload), ...(root ? { claudeDir: claudeHome(root) } : {}) });
    /** Does the Switchboard answer here? Only then can a job draft anything. */
    const switchboard = async () => { const r = await ctx.call("threads.list", {}); return Boolean(r && !r.error); };
    /** A procedure clean in 3 sessions: drafted by a job when the Switchboard can, else the template. */
    /** R031-00s: for a procedure of Vyre calls, the argument names and data flow seen in the Vyre-run threads that did it (their receipts), never a value. @param {any} c */
    const evidenceFor = c => {
      if (!c.steps.some((/** @type {string} */ s) => s.startsWith("vyre:"))) return null;
      const sessions = db.prepare("SELECT DISTINCT session FROM learn_procs WHERE hash = ? AND clean = 1 LIMIT 3").all(c.hash).map((/** @type {any} */ r) => String(r.session));
      /** @type {any[]} */ const runs = [];
      for (const sid of sessions) {
        try { const run = runFor(callsOf(ctx.events.ofThread(sid, { types: ["thread.tool"] })), c.steps); if (run) runs.push(run); } catch { /* no thread log for this session */ }
      }
      return runs.length ? evidenceOf(runs) : null;
    };
    /** A learn skill proposal, also drafted into the skills library for the person's one approval (core/learn/to-library.js). */
    const proposeSkill = (/** @type {any} */ c, /** @type {any} */ o) => { const sk = skills.propose(c, o); void toLibrary((input) => ctx.call("skills.draft.learned", input), sk, ctx.log); return sk; };
    const skillCandidates = async () => {
      const c = skills.candidates({ min: 3 })[0];
      if (!c) return;
      const ev = evidenceFor(c);
      if (ev) c.evidence = ev;
      const key = "skill:" + c.hash;
      const job = /** @type {any} */ (db.prepare("SELECT status FROM learn_jobs WHERE key = ? ORDER BY id DESC LIMIT 1").get(key));
      if (job && ["queued", "running"].includes(String(job.status))) return;
      if (!job && await switchboard()) { jobs.enqueue("skill", key, { candidate: c }); return; }
      proposeSkill(c);                                                  // no Switchboard, or the draft failed: the template
    };

    // ---- Jobs: distilling off the path (ADR 0007, decision 7) -------------------------------

    const jobs = createJobs({
      db, now, call: (tool, input) => ctx.call(tool, input), log: ctx.log,
      emit: (type, payload) => ctx.events.emit(type, payload),
      daily: () => { const n = Number(ctx.config && ctx.config.learn && ctx.config.learn.distill && ctx.config.learn.distill.daily); return Number.isFinite(n) && n >= 0 ? n : 6; },
      dir: () => {
        if (!root) return null;
        const d = path.join(root, "learn-jobs");
        try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; } catch { return null; }
      },
      // A model's answer becomes a proposal at most. Validated like anything a person writes, and
      // never above ask: anything inferred starts at remind or ask.
      handle: async (job, v) => {
        if (job.kind === "skill") {
          if (typeof v.body !== "string" || v.body.length > 20_000) throw new Error("no body");
          return { skill: proposeSkill(job.input.candidate, { body: v.body }).id };
        }
        if (v.rule === null) return { note: "not a rule" };
        const change = { rule: v.rule, level: v.level === "ask" ? "ask" : "remind", check: v.check ?? null };
        clean(change);
        const l = await propose({ ...change, scope: job.input.scope ?? "all", key: job.key, session: job.input.session || null, why: "model",
          source: { kind: "model", job: job.id, ...(job.input.lesson ? { from: job.input.lesson } : {}) } });
        if (!l) return { note: "already a lesson" };
        // The plain-words proposal it improves on is replaced while it still waits for an answer.
        const old = job.input.lesson ? get(job.input.lesson) : null;
        if (old && old.status === "proposed") await retire(old, false, l.id);
        return { lesson: l.id };
      },
    });
    // What a job thread answered, and when it ends; any other thread finishing may free the queue.
    // The Switchboard's one-shot thread (once: true) sends its reply as thread.text {done: true}
    // (partial deltas and its own notices, message "vyre" or notice true, are not the answer),
    // then thread.stopped {reason: "done"}; the stop waits for the answer's handler.
    const offText = ctx.events.on("thread.text", e => {
      const p = e.payload || {};
      const thread = e.thread || p.thread;
      if (p.done !== true || p.notice || p.kind === "reasoning" || p.message === "vyre" || typeof p.text !== "string" || !thread || !jobs.owns(thread)) return;
      jobs.answered(thread, String(p.text || "")).then(r => { if (r && r.skill == null && !r.ok) return skillFallback(); }).catch(err => ctx.log("job answer not read: " + err.message));
    });
    const offStopped = ctx.events.on("thread.stopped", e => {
      const thread = e.thread || (e.payload && e.payload.thread);
      if (thread && jobs.owns(thread)) jobs.stopped(thread).then(skillFallback).catch(err => ctx.log("job not closed: " + err.message));
      else void jobs.pump();
    });
    const offFinished = ctx.events.on("thread.finished", e => {
      const thread = e.thread || (e.payload && e.payload.thread);
      if (!thread || !jobs.owns(thread)) void jobs.pump();
    });
    /** A skill draft that failed: the template instead. */
    const skillFallback = async () => { try { await skillCandidates(); } catch (e) { ctx.log("skill not proposed: " + /** @type {Error} */ (e).message); } };

    // PostToolUse and PostToolUseFailure, from harness.learn: what became of a call.
    ctx.tool("learn.observe", {
      effect: "write",
      internal: true,
      description: "PostToolUse or PostToolUseFailure: a call ran (ok) or failed. Hashes a file Claude wrote, and counts failed and fixed commands. error_head is read, never kept.",
      callers: HOOKS_ONLY,
      input: { type: "object", required: ["session", "tool_name"], properties: { session: { type: "string" }, tool_use_id: { type: "string" }, tool_name: { type: "string" },
        ok: { type: "boolean" }, error_head: { type: "string" }, interrupted: { type: "boolean" }, path: { type: "string" }, cwd: { type: "string" } } },
      run: async ({ session, tool_use_id, tool_name, ok = true, interrupted = false, path: file }) => {
        const c = tool_use_id ? callOf(String(tool_use_id)) : null;
        if (c && c.outcome == null) setOutcome(c.id, ok ? "ok" : interrupted ? "interrupted" : "failed");
        if (c && ok && c.held === "ask" && c.lesson) answered(Number(c.lesson), "allowed", session);
        if (ok && file && sig.WRITERS.has(tool_name)) afterWrite(session, file);
        if (tool_name === "Bash" && c && c.shape && !interrupted) {
          const key = sig.commandKey(String(c.shape));
          const t = turnOf(session);
          const meta = { shape: String(c.shape), test: Boolean(c.test) };
          if (!ok) note({ kind: "failed", session, seq: t ? t.seq : null, project: t ? t.project : null, key, meta });
          else {
            const last = /** @type {any} */ (db.prepare("SELECT kind FROM learn_signals WHERE session = ? AND key = ? AND kind IN ('failed','fixed') ORDER BY id DESC LIMIT 1").get(session, key));
            if (last && last.kind === "failed") note({ kind: "fixed", session, seq: t ? t.seq : null, project: t ? t.project : null, key, meta });
          }
        }
        return { ok: true };
      },
    });

    ctx.tool("learn.signals", {
      effect: "read",
      description: "What Learning heard, as summaries: signals by kind (never their text), repeats by key, Memory corrections per extraction rule, and the jobs waiting for a model (or for the user to write by hand).",
      callers: OWNER,
      input: { type: "object", properties: { kind: { type: "string" }, since: { type: "integer" }, limit: { type: "integer" } } },
      run: async ({ kind, since = 0, limit = 50 }) => {
        const n = Math.max(1, Math.min(500, Number(limit) || 50));
        const rows = kind
          ? db.prepare("SELECT id, at, kind, session, seq, project, agent, key, lesson, meta FROM learn_signals WHERE kind = ? AND at >= ? ORDER BY id DESC LIMIT ?").all(kind, since, n)
          : db.prepare("SELECT id, at, kind, session, seq, project, agent, key, lesson, meta FROM learn_signals WHERE at >= ? ORDER BY id DESC LIMIT ?").all(since, n);
        return {
          signals: rows.map(r => ({ id: r.id, at: r.at, kind: r.kind, session: r.session ? String(r.session).slice(0, 8) : null, seq: r.seq, project: r.project, agent: r.agent,
            key: r.key, lesson: r.lesson, meta: r.meta ? JSON.parse(String(r.meta)) : null })),
          counts: db.prepare("SELECT kind, COUNT(*) AS n FROM learn_signals WHERE at >= ? GROUP BY kind ORDER BY n DESC").all(since).map(r => ({ ...r })),
          repeats: db.prepare(`SELECT key, COUNT(*) AS n, COUNT(DISTINCT session) AS sessions, MAX(lesson) AS lesson FROM learn_signals
            WHERE kind = 'prompt' AND key IS NOT NULL AND at >= ? GROUP BY key HAVING COUNT(*) > 1 ORDER BY n DESC LIMIT 20`).all(since).map(r => ({ ...r })),
          corrected: db.prepare(`SELECT json_extract(meta, '$.prior_rule') AS rule, COUNT(*) AS n FROM learn_signals WHERE kind = 'corrected' AND at >= ?
            GROUP BY rule ORDER BY n DESC LIMIT 20`).all(since).map(r => ({ ...r })),
          // The user's own words, to the user: a job waiting is something they may write by hand.
          jobs: jobs.list({ limit: 50 }).filter(j => j.status !== "dropped").map(j => ({ id: j.id, at: j.at, kind: j.kind, status: j.status, result: j.result,
            text: j.input && typeof j.input.text === "string" ? j.input.text.slice(0, 160) : null })),
        };
      },
    });

    ctx.tool("learn.stats", {
      effect: "read",
      description: "Whether a lesson works: repeats per 100 turns before it was accepted, escapes since, and a verdict. No id gives every active lesson.",
      input: { type: "object", properties: { id: { type: "integer", description: "omit for every active lesson" } } },
      run: async ({ id }) => {
        if (id != null) { const l = must(id); return { id: l.id, dormant: l.dormant, ...metrics.stats(l) }; }
        return active().map(l => ({ id: l.id, dormant: l.dormant, ...metrics.stats(l) }));
      },
    });

    ctx.tool("learn.skills", {
      effect: "read",
      description: "Skills Vyre drafted from procedures the user repeats, each with its whole SKILL.md, plus installed ones whose file changed or is gone (drift).",
      input: { type: "object", properties: { status: { type: "string", enum: ["proposed", "installed", "retired", "dismissed"] } } },
      run: async ({ status }) => ({ skills: skills.list(status ? { status } : {}), drift: skills.drift() }),
    });
    const skillOf = id => { const s = skills.list().find(x => x.id === id); if (!s) throw new Error(`no skill ${id}`); return s; };
    ctx.tool("learn.skill-install", {
      effect: "write",
      description: "Install a proposed skill: instructions every future session follows. Only the user can, with presence. scope: account, project (default for a project's procedure; private keeps it out of the project's folder) or agent.",
      callers: HUMAN,
      presence: { summary: ({ id, scope, agent }) => { const s = skills.list().find(x => x.id === id); return `Install Vyre skill ${id}${s ? ` (${s.name})` : ""} for ${scope === "agent" ? `agent ${agent}` : scope || "its scope"}: every future session there follows it`; } },
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, scope: { type: "string", enum: ["account", "project", "agent"] }, private: { type: "boolean" }, agent: { type: "string" } } },
      run: async ({ id, scope, private: priv, agent }) => {
        if (!root) throw new Error("no Vyre home");
        const s = skillOf(id);
        const where = scope || (agent ? "agent" : s.scope && s.scope.project ? "project" : "account");
        const slug = s.scope && s.scope.project ? String(s.scope.project) : undefined;
        const proj = where === "project" ? await projectBySlug(slug) : null;
        if (where === "project" && !priv && !proj) throw new Error("a project skill needs its project; install it with scope account, or private");
        return skills.install(id, { home: root, scope: /** @type {any} */ (where), private: Boolean(priv), project: slug, agent, projectHome: proj ? String(proj.home) : undefined });
      },
    });
    ctx.tool("learn.skill-retire", {
      effect: "write",
      description: "Retire an installed skill: its file is removed. Only the user can, with presence.",
      callers: HUMAN,
      presence: { summary: ({ id }) => { const s = skills.list().find(x => x.id === id); return `Retire Vyre skill ${id}${s ? ` (${s.name})` : ""}`; } },
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => skills.retire(id),
    });
    ctx.tool("learn.skill-dismiss", {
      effect: "write",
      description: "Say no to a proposed skill; its procedure is not proposed again.",
      callers: HUMAN,
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => skills.dismiss(id),
    });

    const ASK = "Tell the user this in one line and ask whether to keep it. Their next message decides: a plain yes keeps it, a plain no drops it. Do not call any Vyre tool for this; accepting a lesson is the user's alone.";
    /** Where a reply cannot accept (no person typing at a terminal): where the user accepts instead. */
    const elsewhere = id => `the user accepts it with a tap in the Vyre app, from a terminal (\`vyre learn accept ${id}\`), the Deck or the Capsule`;
    const ASK_ELSEWHERE = id => `Tell the user this in one line: it is not in force until ${elsewhere(id)}. A reply here does not accept it. Do not call any Vyre tool for this; accepting a lesson is the user's alone.`;

    ctx.tool("learn.signal", {
      effect: "write",
      internal: true,
      description: "Enrich: a prompt starts a turn. Opens with lessons broken last turn; takes a plain yes or no as the answer to proposals told last prompt, only from a person in an interactive session (interactive true); proposes a lesson when the prompt is a correction; and returns reminders whose `when` matches.",
      callers: HOOKS_ONLY,
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, prompt_id: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" },
        interactive: { type: "boolean" } } },
      run: async ({ session, prompt_id, prompt = "", cwd, agent, interactive = false }) => {
        // A person typed this prompt at an interactive Claude Code: the hook saw its claude process
        // with a terminal and none of -p, --print, --output-format, --input-format, outside a
        // Switchboard thread. An agent's thread never is, whatever it says.
        const person = interactive === true && !agent;
        const t = turnOf(session) || { session, seq: -1, owed: "[]", asked: "[]", stopped: 1 };
        // The same prompt_id again is the same prompt: nothing restarts, nothing is answered or
        // proposed. Claude Code sends one UserPromptSubmit per prompt; a second is a forge (a
        // model piping JSON into hook.js) or a retry.
        if (prompt_id && t.prompt === prompt_id) return { text: "", seq: t.seq, proposed: null, broke: [], duplicate: true };
        // A prompt while the last turn has not passed a Stop: a forge mid-turn, or a turn the user
        // interrupted. Its send-backs and broken lessons carry over, and so do its edits: Stop
        // still sees what changed since the turn really started. Its "no" declines nothing.
        const open = Boolean(t.started) && !Number(t.stopped ?? 1);
        const keep = open && (await touchedSince(session, Number(t.started), 1)).length > 0;
        const owed = /** @type {number[]} */ (JSON.parse(t.owed || "[]"));
        const waiting = /** @type {number[]} */ (JSON.parse(t.asked || "[]"));
        const seq = t.seq + 1;
        const lines = [];
        /** @type {number[]} */
        const asked = [];

        // A turn that ended with a lesson broken: the next prompt opens with it.
        const late = open ? [] : owed.map(get).filter(l => l && l.status === "active");
        if (late.length) lines.push(`Last turn broke ${late.length === 1 ? "this lesson" : "these lessons"}. Keep ${late.length === 1 ? "it" : "them"} this turn.`, ...late.map(l => `- Lesson ${l.id}: ${l.rule}`));

        // Accept by reply (ADR 0007, decision 11, with Security's condition): a forged yes would be
        // a prompt injection that lasts, so a plain yes or no answers a proposal only when
        //   - a person typed it: an interactive Claude Code prompt (`person`), never `-p` input, a
        //     headless Switchboard thread, an agent's thread or a prompt an agent sent;
        //   - the proposal was told in the immediately preceding turn of this thread (`waiting`),
        //     never an earlier one, even when named by number;
        //   - that turn has ended (passed a Stop): a prompt mid-turn is a forge or an interrupt.
        // Otherwise the answer does nothing and Claude is told where the user accepts instead.
        const answer = reply(prompt);
        if (answer) {
          const ids = answer.id ? (waiting.includes(answer.id) ? [answer.id] : []) : waiting;
          const pending = ids.map(get).filter(l => l && l.status === "proposed");
          if (pending.length && !person) {
            lines.push(...pending.map(l => `The user's ${answer.yes ? "yes" : "no"} did not ${answer.yes ? "accept" : "decline"} lesson ${l.id} ("${l.rule}"): Vyre takes an answer by reply only from a person typing in an interactive Claude Code session. It stays proposed until ${elsewhere(l.id)}. Say so in one line.`));
          } else if (pending.length && open) {
            // The last turn has not ended (the user interrupted it, or this is not a real prompt).
            // The proposals stay waiting for the next prompt after a Stop.
            asked.push(...waiting);
            lines.push(...pending.map(l => `The user's ${answer.yes ? "yes" : "no"} was not taken for lesson ${l.id} ("${l.rule}"): the turn before it had not finished. Ask again after this turn, or ${elsewhere(l.id)}.`));
          } else for (const l of pending) {
            if (answer.yes) {
              const a = await activate(l, "reply");
              lines.push(`The user said yes: lesson ${a.id} is in force now: "${a.rule}" ${enforced(a)} Say so in a few words.`);
            } else {
              await retire(l, true);
              lines.push(`The user said no: lesson ${l.id} ("${l.rule}") is dropped. Acknowledge it in a few words.`);
            }
          }
        }

        const p = await projectOf(cwd);
        const project = p ? String(p.slug) : null;
        metrics.turn({ project, agent });
        const lessons = await inScope(active(), { cwd, agent }, p);
        // Proposals from this thread's edited drafts and from what Learning saw it do, told once.
        for (const s of db.prepare("SELECT id, kind, lesson, meta FROM learn_signals WHERE kind IN ('edited','proposed') AND session = ? AND told = 0 AND lesson IS NOT NULL ORDER BY id").all(session)) {
          const l = get(s.lesson);
          db.prepare("UPDATE learn_signals SET told = 1 WHERE id = ?").run(s.id);
          if (!l || l.status !== "proposed") continue;
          lines.push(`${why(String(s.kind), s.meta ? JSON.parse(String(s.meta)) : {}, l)} Vyre drafted it as lesson ${l.id}, not yet in force: "${l.rule}" ${enforced(l)}`, person ? ASK : ASK_ELSEWHERE(l.id));
          asked.push(l.id);
        }

        const d = answer || prompt.trim().startsWith("/") ? null : distill(prompt);
        const soft = !d && !answer && sig.softCorrection(prompt);
        const key = d ? sig.promptKey(d, prompt) : soft ? sig.wordsKey(prompt) : null;
        let proposed = null, lesson = null;
        if (d) {
          // The same check, or for a lesson without one, the same rule. (check_json IS NULL alone
          // would make every free-text correction match the first free-text lesson.)
          const same = row(d.check
            ? db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json = ? ORDER BY id").get(JSON.stringify(d.check))
            : db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json IS NULL AND rule = ? ORDER BY id").get(d.rule));
          let widened = false;
          if (!same) {
            const sc = scopeFor(d, { project, agent, key });
            widened = Boolean(sc.widened);
            const { scope: _, prefers, ...rest } = d;
            proposed = create({ ...rest, scope: sc.scope, key, source: { kind: "prompt", session, seq, text: prompt.slice(0, 400), ...(prefers ? { prefers } : {}) } }, "proposed");
          } else {
            // The user said it again: a repeat, which is what measures whether the lesson works.
            metrics.tally(same.id, { repeats: 1 });
            db.prepare("UPDATE learn_lessons SET dormant = 0 WHERE id = ? AND dormant = 1").run(same.id);
          }
          lesson = same ? same.id : proposed.id;
          // The signal names the lesson, the new proposal included, so a reply naming it can be matched to this thread.
          note({ kind: "prompt", session, seq, project, agent, key, lesson, text: prompt.slice(0, 400) });
          if (proposed) {
            ctx.events.emit("lesson.proposed", { lesson: proposed.id, rule: proposed.rule, checked: Boolean(proposed.check) }, { thread: session });
            lines.push(`The user's prompt reads as a standing rule. Vyre drafted it as lesson ${proposed.id}, not yet in force: "${proposed.rule}" ${enforced(proposed)}${widened ? " It was said in another project too, so it would hold everywhere." : ""}`,
              `${person ? ASK : ASK_ELSEWHERE(proposed.id)} Follow the rule this turn either way.`);
            asked.push(proposed.id);
            // Plain words with no check: a model may find one, off the path.
            if (!proposed.check) jobs.enqueue("distill", key, { text: prompt.slice(0, 1000), session, lesson: proposed.id, scope: proposed.scope });
          } else if (same.status === "proposed") {
            lines.push(`Lesson ${same.id} ("${same.rule}") is still waiting for the user's answer. ${person ? ASK : ASK_ELSEWHERE(same.id)}`);
            asked.push(same.id);
          } else if (/\b(again|i told you|already said)\b/i.test(prompt)) {
            await broke(same, session, [], "prompt");
          }
        } else if (soft && key) {
          note({ kind: "prompt", session, seq, project, agent, key, text: prompt.slice(0, 400) });
        }
        // The same thing said in another session within 30 days: repeated. A plain correction no
        // shape fits becomes a job the second time, not the first.
        if (key && !db.prepare("SELECT 1 FROM learn_signals WHERE key = ? AND kind = 'repeated' AND session = ? LIMIT 1").get(key, session)
          && db.prepare("SELECT 1 FROM learn_signals WHERE key = ? AND kind = 'prompt' AND session != ? AND at >= ? LIMIT 1").get(key, session, now() - 30 * DAY)) {
          const sessions = Number(/** @type {any} */ (db.prepare("SELECT COUNT(DISTINCT session) AS n FROM learn_signals WHERE key = ? AND kind = 'prompt' AND at >= ?").get(key, now() - 30 * DAY)).n);
          note({ kind: "repeated", session, seq, project, agent, key, lesson, meta: { sessions } });
          if (!d) jobs.enqueue("distill", key, { text: prompt.slice(0, 1000), session, scope: project ? { project } : "all" });
        }

        // The turn before this one was clean unless this prompt corrects it or Stop sent it back.
        // A turn that never passed a Stop is not over, so it is not judged.
        if (t.seq >= 0 && t.started && !open) {
          const clean = !d && !soft && !(answer && !answer.yes) && !(Number(t.blocks) > 0) && !owed.length;
          if (skills.mark({ session, seq: t.seq, clean }) > 0) await skillCandidates();
        }
        await sweep(project);

        saveTurn({ session, prompt: prompt_id || null, seq, started: keep ? Number(t.started) : now(), blocks: open ? Number(t.blocks) : 0,
          owed: open ? JSON.stringify(owed) : "[]", asked: JSON.stringify([...new Set(asked)]), project, agent: agent || null, stopped: 0 });
        const reminders = lessons.filter(l => !l.check && !l.dormant && l.level !== "block" && matches(l.when, prompt));
        if (reminders.length) lines.push("Lessons the user taught. Follow them:", ...reminders.map(l => `- ${l.rule}`));
        void jobs.pump();
        return { text: lines.length ? `Vyre lessons.\n${lines.join("\n")}` : "", seq, proposed: proposed ? proposed.id : null, broke: late.map(l => l.id) };
      },
    });

    /** Why a proposal was drafted, in the words Claude passes on. */
    const why = (kind, meta, l) => {
      if (kind === "edited") return `The user edited a draft to take out what lesson ${l.id} forbids.`;
      const label = l.check && l.check.label ? l.check.label : "it";
      if (meta.why === "reverted") return `The user undid Claude's changes to ${label} in two sessions.`;
      if (meta.why === "declined") return `The user said no to ${label} ${meta.times || 3} times.`;
      if (meta.why === "untested") return "Last turn changed code after the tests failed and ended without running them again.";
      if (meta.why === "model") return "Vyre turned something the user said earlier into a rule.";
      return "Vyre noticed a pattern.";
    };

    /**
     * Where a proposal holds (ADR 0007, decision 8), in order: the user's scope word; the agent;
     * a check about this project's files or commands gives the project; style checks (characters,
     * phrases) and plain words hold everywhere. A project proposal whose key was also said in
     * another project holds everywhere, and says so.
     */
    const scopeFor = (d, { project, agent, key }) => {
      if (d.scope === "all") return { scope: "all" };
      if (d.scope === "project") return { scope: project ? { project } : "all" };
      if (agent) return { scope: { agent } };
      const local = d.check && ["path", "after", "before", "touched", "tool"].includes(d.check.kind);
      if (!local || !project) return { scope: "all" };
      const elsewhere = key && db.prepare("SELECT 1 FROM learn_signals WHERE key = ? AND project IS NOT NULL AND project != ? LIMIT 1").get(key, project);
      return elsewhere ? { scope: "all", widened: true } : { scope: { project } };
    };

    ctx.tool("learn.check", {
      effect: "write",
      description: "What the hooks ask. stage tool: may this call run, given the lessons? stage stop: may this turn end, given its final reply and the files it changed? stage brief: every active lesson, for the start of a thread.",
      callers: HOOKS_ONLY,
      input: { type: "object", required: ["stage"], properties: { stage: { type: "string", enum: ["tool", "stop", "brief"] }, session: { type: "string" }, prompt_id: { type: "string" },
        cwd: { type: "string" }, agent: { type: "string" }, tool_name: { type: "string" }, tool_input: { type: "object" }, tool_use_id: { type: "string" }, plugin_root: { type: "string" },
        text: { type: "string" }, stop_hook_active: { type: "boolean" }, headless: { type: "boolean" } } },
      run: async input => {
        const lessons = await inScope(active(), input);
        if (input.stage === "brief") {
          // A dormant lesson is out of the brief; its check still runs.
          const shown = lessons.filter(l => !l.dormant);
          if (!shown.length) return { text: "" };
          // Waiting a check out is visible: lessons in scope broken in the last seven days.
          const counts = new Map(db.prepare("SELECT lesson, COUNT(*) AS n FROM learn_signals WHERE kind = 'broken' AND at >= ? GROUP BY lesson").all(now() - WEEK).map(r => [r.lesson, r.n]));
          const broken = shown.filter(l => counts.get(l.id)).map(l => { const n = counts.get(l.id); return `Lesson ${l.id} was broken ${n} time${n === 1 ? "" : "s"} this week: ${l.rule}`; });
          return { text: ["Vyre lessons the user taught. Those marked checked are enforced by hooks: a reply or change that breaks one is sent back.",
            ...broken, ...shown.map(l => `- ${l.rule}${l.check ? " (checked)" : ""}`)].join("\n") };
        }
        const session = input.session || "";
        if (input.stage === "tool") return tool(lessons, session, input);
        return stop(lessons, session, input);
      },
    });

    /** PreToolUse. Returns { decision, reason, lesson } in the Harness rules' shape. */
    const tool = async (lessons, session, { tool_name = "", tool_input = {}, prompt_id, cwd, tool_use_id, plugin_root }) => {
      // The guards hold always, in this folder or not: a lesson for another project can be switched
      // off from here too, and the store, learned/, the hooks and the plugin outlive any one lesson.
      // Only the guards about lessons themselves wait for an active one (checks.js).
      const guard = weakens(tool_name, tool_input, { home: root, cwd, pluginRoot: plugin_root ?? null, lessons: active().length > 0 });
      if (guard) return { decision: "ask", reason: `${guard} Vyre asks the user first.`, lesson: null };
      const t = turn(session, prompt_id);
      const last = (await touchedSince(session, 0, 1))[0];
      const ran = db.prepare("SELECT command FROM learn_commands WHERE session = ? AND at > ?").all(session, last ? last.at : -1).map(r => r.command);
      if (tool_name === "Bash" && typeof tool_input.command === "string") db.prepare("INSERT INTO learn_commands (session, command, at) VALUES (?,?,?)").run(session, tool_input.command.slice(0, 2000), now());
      // A file Claude is about to change: its hash now, to tell a revert later.
      const file = session ? fileOf(tool_name, tool_input) : null;
      if (file) beforeWrite(session, path.resolve(cwd || root || os.homedir(), file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file), t.project ?? null);

      const owe = JSON.parse(t.owed || "[]");
      let verdict = { decision: null, reason: undefined, lesson: null };
      for (const l of lessons) {
        const r = atTool(l.check, { tool: tool_name, input: tool_input, ran });
        if (!r.applied) continue;
        if (!r.problem) { bump(1, 0, 0, l.level, l.id); continue; }
        if (l.level === "remind") { await broke(l, session, owe, "tool"); continue; }
        bump(1, 1, 0, l.level, l.id);
        ctx.events.emit("lesson.caught", { lesson: l.id, session: session || null, stage: "tool", tool: tool_name }, { thread: session || undefined });
        if (!verdict.decision || (verdict.decision === "ask" && l.level === "block")) {
          verdict = { decision: l.level === "block" ? "deny" : "ask", reason: held(l, r.problem), lesson: l.id };
        }
      }
      saveTurn({ ...t, owed: JSON.stringify([...new Set(owe)]) });
      // The call, by its shape, so PostToolUse (or its absence by Stop) says what became of it.
      const tracked = sig.TRACKED.has(tool_name);
      if (session && tool_use_id && (tracked || sig.isVyreTool(tool_name))) {
        const callId = String(tool_use_id);
        if (tracked) {
          const command = tool_name === "Bash" && typeof tool_input.command === "string" ? tool_input.command : null;
          addCall.run(callId, session, tool_name, command ? sig.shape(command) || null : null, command && sig.isTest(command) ? 1 : 0,
            verdict.lesson ?? null, verdict.decision ?? null, now());
        } else {
          // R031-00s: a Vyre tool call is a step of the turn. Its row holds the steps (tool names, one a line; never an argument), and only the repeated-work detector reads it.
          const steps = sig.vyreSteps(tool_name, tool_input);
          if (steps.length) addCall.run(callId, session, tool_name, steps.join("\n"), 0, null, null, now());
        }
      }
      return verdict;
    };

    /** Stop. Returns { decision: "block", reason } to send the turn back, or { decision: null }. */
    const stop = async (lessons, session, { prompt_id, text, stop_hook_active, headless }) => {
      const t = turn(session, prompt_id);
      // Claude Code says whether this Stop follows one of ours. When it does not, this is the
      // turn's first try at ending, whatever the count says.
      if (!stop_hook_active) t.blocks = 0;
      const first = t.blocks === 0;
      const rows = await touchedSince(session, t.started);
      const touched = rows.map(f => f.path);
      const changes = rows.map(f => ({ path: f.path, at: Number(f.at) }));
      const commands = db.prepare("SELECT command, at FROM learn_commands WHERE session = ? AND at >= ? ORDER BY at").all(session, t.started || 0).map(r => ({ command: String(r.command), at: Number(r.at) }));
      const failed = [];
      for (const l of lessons) {
        const r = atStop(l.check, { text: typeof text === "string" ? text : null, touched, changes, commands });
        if (r.applied && first) bump(1, 0, 0, l.level, l.id);
        if (r.problem) failed.push({ l, problem: r.problem });
      }
      const owe = JSON.parse(t.owed || "[]");
      const back = failed.filter(f => f.l.level !== "remind");
      if (back.length && t.blocks < MAX_BLOCKS) {
        t.blocks++;
        for (const { l } of back) {
          bump(0, 1, 0, l.level, l.id);
          ctx.events.emit("lesson.caught", { lesson: l.id, session: session || null, stage: "stop", attempt: t.blocks }, { thread: session || undefined });
        }
        saveTurn(t);
        return { decision: "block", reason: sentBack(t.blocks, back), lessons: back.map(f => f.l.id) };
      }
      for (const { l } of failed) await broke(l, session, owe, "stop");
      saveTurn({ ...t, owed: JSON.stringify([...new Set(owe)]), stopped: 1 });
      if (session) {
        try { await ended(session, t, rows, commands, Boolean(headless)); } catch (e) { ctx.log("turn not read: " + /** @type {Error} */ (e).message); }
      }
      return { decision: null, broken: failed.map(f => f.l.id) };
    };

    /**
     * A turn ended (no send-back): what it did becomes signals. Calls with no PostToolUse were
     * declined (or, held by a lesson, denied); a test that failed, then edits, then a pass is a
     * test-fix run, and edits with no test after them a proposal; the turn's steps are
     * fingerprinted for skills; the project's recent writes are statted for reverts.
     */
    const ended = async (session, t, rows, commands, headless = false) => {
      const project = t.project ?? null;
      const calls = db.prepare("SELECT * FROM learn_calls WHERE session = ? AND at >= ? ORDER BY at").all(session, t.started || 0);
      for (const c of calls) {
        if (c.outcome != null) continue;
        // A Vyre tool call has no PostToolUse here (only its failure is passed on): it is a step of the turn and says nothing about being declined.
        if (sig.isVyreTool(String(c.tool))) continue;
        // Headless, no one was there to say no: a call that did not run was refused by settings or
        // the permission mode, and a real answer comes as ask.answered. Nothing is inferred.
        if (headless) { setOutcome(c.id, "unanswered"); continue; }
        if (c.held === "deny") { setOutcome(c.id, "held"); continue; }
        const shape = c.shape ? String(c.shape) : null;
        const key = shape ? sig.commandKey(shape) : sig.toolKey(c.tool);
        if (c.held === "ask") {
          setOutcome(c.id, "denied");
          note({ kind: "denied", session, seq: t.seq, project, key, meta: { tool: c.tool, shape } });
          if (c.lesson) answered(Number(c.lesson), "denied", session);
        } else {
          setOutcome(c.id, "declined");
          note({ kind: "declined", session, seq: t.seq, project, key, meta: { tool: c.tool, shape } });
        }
        if (shape) await maybeHold(shape, key, session, project);
      }
      const once = kind => !db.prepare("SELECT 1 FROM learn_signals WHERE session = ? AND seq = ? AND kind = ? LIMIT 1").get(session, t.seq, kind);
      const tests = calls.filter(c => c.test && ["ok", "failed"].includes(String(c.outcome)));
      const fail = tests.find(c => c.outcome === "failed");
      const edits = fail ? rows.filter(f => Number(f.at) >= Number(fail.at) && sig.WRITERS.has(String(f.tool))) : [];
      if (fail && edits.length) {
        const last = Math.max(...edits.map(f => Number(f.at)));
        const key = "testfix:" + sig.commandKey(String(fail.shape || "tests"));
        if (tests.some(c => c.outcome === "ok" && Number(c.at) >= last)) {
          if (once("test-fix")) note({ kind: "test-fix", session, seq: t.seq, project, key, meta: { shape: fail.shape, edits: edits.length } });
        } else if (!tests.some(c => Number(c.at) >= last) && once("untested")) {
          note({ kind: "untested", session, seq: t.seq, project, key, meta: { shape: fail.shape, edits: edits.length } });
          await propose({ rule: "When the tests fail and you change code to fix them, run the tests again before you finish.", level: "remind",
            scope: project ? { project } : "all", check: { kind: "after", command: TESTS, when: CODE, label: "the tests ran after the last change" },
            source: { kind: "untested" }, key, session, why: "untested" });
        }
      }
      // R031-00s: the turn's Vyre tool calls are steps too, unless one failed (a sequence with a failed step is not what the person wants repeated).
      const vyre = calls.filter(c => sig.isVyreTool(String(c.tool)));
      const tools = vyre.some(c => c.outcome === "failed") ? [] : vyre.map(c => ({ steps: String(c.shape || "").split("\n").filter(Boolean), at: Number(c.at) }));
      const steps = stepsOf({ commands, files: rows.map(f => ({ tool: String(f.tool), path: String(f.path), at: Number(f.at) })), tools });
      skills.record({ session, seq: t.seq, project, steps });
      await sweep(project);
      housekeep();
      void jobs.pump();
    };

    // ---- Housekeeping, from Stop and at start, never on a timer ----------------------------

    /** Per-turn rows go after 7 days, at most hourly; dormancy and older rows at most daily. */
    const housekeep = () => {
      const t = now();
      if (t - Number(state("pruned") || 0) >= HOUR) {
        setState("pruned", String(t));
        const cut = t - KEEP;
        db.prepare("DELETE FROM learn_commands WHERE at < ?").run(cut);
        db.prepare("DELETE FROM learn_calls WHERE at < ?").run(cut);
        db.prepare("DELETE FROM learn_writes WHERE at < ?").run(cut);
        db.prepare("DELETE FROM learn_turns WHERE started < ?").run(cut);
      }
      if (t - Number(state("daily") || 0) >= DAY) {
        setState("daily", String(t));
        skills.prune({ days: 90 });
        metrics.prune();
        jobs.prune(30);
        for (const l of active()) if (!l.dormant && metrics.quiet(l)) {
          db.prepare("UPDATE learn_lessons SET dormant = 1 WHERE id = ?").run(l.id);
          ctx.events.emit("lesson.dormant", { lesson: l.id, level: l.level });
        }
      }
    };

    // Per-turn rows older than a week go at start too.
    housekeep();

    return { async stop() { off(); offEdit(); offRejected(); offCorrected(); offAnswered(); offText(); offStopped(); offFinished(); } };
  },
};

/** How a lesson is enforced, in one sentence for Claude and the user. */
export function enforced(l) {
  const c = l.check;
  const how = l.level === "remind" ? "Vyre will remind you of it" : "Vyre enforces it";
  if (!c) return "It has no check; Vyre will repeat it to you.";
  if (c.kind === "text") return `${how}: a reply or file with ${c.label} is sent back.`;
  if (c.kind === "touched") return `${how}: a turn that changes code without ${c.require} is sent back.`;
  if (c.kind === "before") return `${how}: a matching command is held until ${c.label ? `${c.label.replace(/ ran before .*/, "")} has run` : "the first has run"}.`;
  const held = l.level === "block" ? "denied" : l.level === "ask" ? "asked first" : "noted";
  if (c.kind === "tool") return `${how}: running ${c.label || c.tool || "it"} is ${held}${c.instead ? `; use ${c.instead} instead` : ""}.`;
  if (c.kind === "path") return `${how}: changing ${c.label || "those files"} is ${held}.`;
  if (c.kind === "after") return `${how}: a turn that ends without ${c.label || "running it after the change"} is sent back.`;
  return `${how}.`;
}

/** Does a lesson's `when` fit this prompt? "always" (or nothing) always does; otherwise a regex, or plain words. */
export function matches(when, prompt) {
  if (!when || when === "always") return true;
  try { return new RegExp(when, "i").test(prompt); } catch { return prompt.toLowerCase().includes(when.toLowerCase()); }
}
