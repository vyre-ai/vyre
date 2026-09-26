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
// with presence (learn.accept from the CLI, the Capsule or the Deck), or write a lesson
// themselves (learn.add, `/vyre remember`, `vyre learn add`).
//
// Anything that makes Vyre stricter is free; anything that makes it looser needs a person
// (ADR 0007, decision 11). learn.edit only tightens. Lowering, narrowing, removing a check,
// pinning and retiring go through learn.relax and learn.retire, which only owner surfaces may
// call and which declare presence (ADR 0004).
//
// Levels: remind (repeated to Claude, never holds anything), ask (a tool call waits for the
// user; a reply is sent back), block (a tool call is denied; a reply is sent back). A lesson
// broken again moves up one level, unless it is pinned or at its max_level.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { distill, fromEdit, invalid, atStop, atTool, weakens, sentBack, held, reply, loosens, LEVELS, MAX_BLOCKS } from "./checks.js";
import { writeSnapshot, drain, SNAPSHOT } from "./offline.js";

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
];

export { MAX_BLOCKS };
/** The surfaces a person uses. Loosening tools refuse every other caller (MCP, agents, hooks). */
const OWNER = ["cli", "local", "deck", "capsule"];
const WEEK = 7 * 24 * 3600 * 1000;
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

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
      max_level: r.max_level ?? null, pinned: Boolean(r.pinned), created: r.created, updated: r.updated,
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

    const insert = db.prepare(`INSERT INTO learn_lessons (scope, when_text, rule, check_json, level, status, source, created, updated)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    /** @returns {any} */
    const create = (l, status) => {
      clean(l);
      const at = now();
      const r = insert.run(JSON.stringify(l.scope ?? "all"), l.when || "always", l.rule.trim(), l.check ? JSON.stringify(l.check) : null,
        l.level || (l.check ? "block" : "remind"), status, JSON.stringify(l.source || { kind: "user" }), at, at);
      return get(Number(r.lastInsertRowid));
    };

    // Turns: learn.signal marks one starting (every prompt passes through Enrich); Stop counts
    // how often it sent the turn back. Claude Code's prompt_id names the turn when it sends one.
    const turnOf = session => db.prepare("SELECT * FROM learn_turns WHERE session = ?").get(session);
    const saveTurn = t => db.prepare(`INSERT INTO learn_turns (session, prompt, seq, started, blocks, owed, asked) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (session) DO UPDATE SET prompt = excluded.prompt, seq = excluded.seq, started = excluded.started, blocks = excluded.blocks, owed = excluded.owed, asked = excluded.asked`)
      .run(t.session, t.prompt ?? null, t.seq, t.started, t.blocks, t.owed, t.asked || "[]");
    const turn = (session, prompt_id) => {
      const t = turnOf(session) || { session, prompt: null, seq: 0, started: 0, blocks: 0, owed: "[]", asked: "[]" };
      // A turn Enrich never saw (vyred came up mid-turn): a new turn from here. Its block count is
      // not reset by a new prompt_id: only a real prompt (learn.signal) or a Stop that Claude Code
      // says is not a continuation (stop_hook_active false) starts the count over, so a turn at
      // the cap cannot win more tries by showing another prompt_id.
      if (prompt_id && t.prompt && t.prompt !== prompt_id) Object.assign(t, { prompt: prompt_id, seq: t.seq + 1 });
      return t;
    };

    const bump = db.prepare("UPDATE learn_lessons SET applied = applied + ?, caught = caught + ?, broken = broken + ?, level = ?, updated = ? WHERE id = ?");
    const signal = (kind, session, lesson, text = null) =>
      db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson) VALUES (?,?,?,?,?,?)").run(now(), kind, session || null, null, text, lesson ?? null);
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
      bump.run(0, 0, 1, to, now(), l.id);
      signal("broken", session, l.id);
      ctx.events.emit("lesson.broken", { lesson: l.id, session: session || null, level: from, stage }, { thread: session || undefined });
      if (to !== from) { ctx.events.emit("lesson.escalated", { lesson: l.id, from, to }); await snap(); }
      owe.push(l.id);
    };

    /**
     * The lessons that apply here: scope "all", this project, or this agent. A project scope
     * holds the slug; a lesson that holds the project's name, home or a folder still applies.
     */
    const inScope = async (lessons, { cwd, agent }) => {
      let p = null;
      if (cwd && lessons.some(l => l.scope && l.scope.project)) {
        const r = await ctx.call("projects.of", { cwd });
        p = r && r.data ? r.data : null;
      }
      const here = v => Boolean(p) && (v === p.slug || v === p.name || v === p.home || (Array.isArray(p.folders) && p.folders.includes(v)));
      return lessons.filter(l => l.scope === "all" || (l.scope.project && here(l.scope.project)) || (l.scope.agent && l.scope.agent === agent));
    };

    /** Files changed in this thread since `since`, from the Harness. */
    const touchedSince = async (session, since) => {
      const r = await ctx.call("harness.touched", { session, limit: 500 });
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
        bump.run(0, 1, 0, l.level, now(), l.id);
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
      db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson) VALUES (?,?,?,?,?,NULL)")
        .run(now(), "denied", p.session || null, null, `${p.tool} ${p.decision} by floor rule ${p.rule}`);
    });

    ctx.tool("learn.lessons", {
      description: "The lessons Vyre learned from the user, with how often each applied, was caught and was broken. status: active (default with proposed), proposed, retired or all.",
      input: { type: "object", properties: { status: { type: "string", enum: ["active", "proposed", "retired", "all"] } } },
      run: async ({ status }) => {
        const where = !status ? "status IN ('active','proposed')" : status === "all" ? "1" : "status = ?";
        return db.prepare(`SELECT * FROM learn_lessons WHERE ${where} ORDER BY id`).all(...(status && status !== "all" ? [status] : [])).map(row);
      },
    });

    ctx.tool("learn.add", {
      description: "Add a lesson the user wrote or asked for (/vyre remember). From text alone, a known shape (a banned character, a file to update with code, tests before commit) becomes a check; anything else is a reminder.",
      input: { type: "object", properties: { text: { type: "string" }, rule: { type: "string" }, when: { type: "string" }, level: { type: "string", enum: LEVELS }, scope: scopeSchema, check: checkSchema, session: { type: "string" } } },
      run: async ({ text, rule, when, level, scope, check, session }) => {
        const d = text && !rule ? distill(text) : null;
        if (!rule && !d && !text) throw new Error("say the lesson: text, or rule");
        const l = create({ rule: rule || (d ? d.rule : String(text)), when: when || (d && d.when) || "always", level: level || (d ? d.level : undefined),
          scope: await slugged(scope), check: check !== undefined ? check : d ? d.check : null, source: { kind: "remember", session: session || null, text: text || rule } }, "active");
        ctx.events.emit("lesson.learned", { lesson: l.id, rule: l.rule, level: l.level, checked: Boolean(l.check) });
        await snap();
        return l;
      },
    });

    /** Put a proposed lesson in force. `via` says how the user accepted it. */
    const activate = async (l, via) => {
      db.prepare("UPDATE learn_lessons SET status = 'active', source = ?, updated = ? WHERE id = ?").run(JSON.stringify({ ...l.source, accepted: via }), now(), l.id);
      ctx.events.emit("lesson.learned", { lesson: l.id, rule: l.rule, level: l.level, checked: Boolean(l.check) });
      await snap();
      return get(l.id);
    };
    /** Retire a lesson; a proposal the user said no to is noted as declined. */
    const retire = async (l, declined = false) => {
      db.prepare("UPDATE learn_lessons SET status = 'retired', source = ?, updated = ? WHERE id = ?")
        .run(JSON.stringify(declined ? { ...l.source, declined: true } : l.source), now(), l.id);
      ctx.events.emit("lesson.retired", { lesson: l.id, ...(declined ? { declined: true } : {}) });
      await snap();
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
    /** What a person sees before proving they are there (ADR 0004). */
    const about = (verb, id) => { const l = get(id); return l ? `${verb} Vyre lesson ${id}: "${l.rule}"` : `${verb} Vyre lesson ${id}`; };

    const levelSchema = { type: "string", enum: LEVELS };
    const changeSchema = { rule: { type: "string" }, when: { type: "string" }, level: levelSchema, scope: scopeSchema,
      check: { anyOf: [checkSchema, { type: "null" }] }, max_level: { anyOf: [levelSchema, { type: "null" }] }, pinned: { type: "boolean" } };

    ctx.tool("learn.accept", {
      description: "Accept a proposed lesson. Only the user can: from the CLI, the Capsule or the Deck, with presence. In a thread the user accepts by replying yes; nothing needs calling.",
      callers: OWNER,
      presence: { summary: ({ id }) => about("Accept", id) },
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => {
        const l = must(id);
        if (l.status === "active") return l;
        if (l.status !== "proposed") throw new Error(`lesson ${id} is ${l.status}`);
        return activate(l, "presence");
      },
    });

    ctx.tool("learn.edit", {
      description: "Tighten a lesson: raise its level, widen its scope or `when` to always, add a check where it had none, raise or lift its cap, unpin it. Anything that loosens a lesson is refused here; that is learn.relax, the user's alone.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, ...changeSchema } },
      run: async ({ id, ...change }) => {
        const l = must(id);
        clean(change);
        if (change.scope !== undefined) change.scope = await slugged(change.scope);
        const loose = loosens(l, change);
        if (loose.length) throw new Error(`this change ${loose.join(", ")}, which weakens lesson ${id}. Weakening a lesson is the user's call: learn.relax, from the CLI or the Deck.`);
        return apply(id, change);
      },
    });

    ctx.tool("learn.relax", {
      description: "Loosen a lesson: lower its level, narrow or move its scope, narrow `when`, change or remove its check, lower its cap, pin it, or rewrite its rule. Only the user can, with presence.",
      callers: OWNER,
      presence: { summary: ({ id, ...change }) => { const l = get(id); const what = l ? loosens(l, change) : []; return `${about("Relax", id)}${what.length ? `: ${what.join(", ")}` : ""}`; } },
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, ...changeSchema } },
      run: async ({ id, ...change }) => {
        must(id);
        clean(change);
        if (change.scope !== undefined) change.scope = await slugged(change.scope);
        return apply(id, change);
      },
    });

    ctx.tool("learn.retire", {
      description: "Retire a lesson, or decline a proposed one. Only the user can, with presence.",
      callers: OWNER,
      presence: { summary: ({ id }) => about("Retire", id) },
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => retire(must(id)),
    });

    const ASK = "Tell the user this in one line and ask whether to keep it. Their next message decides: a plain yes keeps it, a plain no drops it. Do not call any Vyre tool for this; accepting a lesson is the user's alone.";

    ctx.tool("learn.signal", {
      internal: true,
      description: "Enrich: a prompt starts a turn. Opens with lessons broken last turn; takes a plain yes or no as the answer to proposals told last prompt; proposes a lesson when the prompt is a correction; and returns reminders whose `when` matches.",
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, prompt_id: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" } } },
      run: async ({ session, prompt_id, prompt = "", cwd, agent }) => {
        const t = turnOf(session) || { session, seq: -1, owed: "[]", asked: "[]" };
        const owed = /** @type {number[]} */ (JSON.parse(t.owed || "[]"));
        const waiting = /** @type {number[]} */ (JSON.parse(t.asked || "[]"));
        const seq = t.seq + 1;
        const lines = [];
        /** @type {number[]} */
        const asked = [];

        // A turn that ended with a lesson broken: the next prompt opens with it.
        const late = owed.map(get).filter(l => l && l.status === "active");
        if (late.length) lines.push(`Last turn broke ${late.length === 1 ? "this lesson" : "these lessons"}. Keep ${late.length === 1 ? "it" : "them"} this turn.`, ...late.map(l => `- Lesson ${l.id}: ${l.rule}`));

        // Accept by reply. This prompt is what the user typed (Claude Code fills it), so a plain
        // yes to a proposal told last prompt accepts it here, and a plain no declines it. A lesson
        // named by number may be any proposal this thread was told about.
        const answer = reply(prompt);
        if (answer) {
          const told = id => waiting.includes(id) || Boolean(db.prepare("SELECT 1 FROM learn_signals WHERE session = ? AND lesson = ? AND kind IN ('prompt','edited') LIMIT 1").get(session, id));
          const ids = answer.id ? (told(answer.id) ? [answer.id] : []) : waiting;
          for (const l of ids.map(get)) {
            if (!l || l.status !== "proposed") continue;
            if (answer.yes) {
              const a = await activate(l, "reply");
              lines.push(`The user said yes: lesson ${a.id} is in force now: "${a.rule}" ${enforced(a)} Say so in a few words.`);
            } else {
              await retire(l, true);
              lines.push(`The user said no: lesson ${l.id} ("${l.rule}") is dropped. Acknowledge it in a few words.`);
            }
          }
        }

        const lessons = await inScope(active(), { cwd, agent });
        // Lessons proposed from this thread's edited drafts, told once.
        for (const sig of db.prepare("SELECT id, lesson FROM learn_signals WHERE kind = 'edited' AND session = ? AND told = 0 AND lesson IS NOT NULL").all(session)) {
          const l = get(sig.lesson);
          db.prepare("UPDATE learn_signals SET told = 1 WHERE id = ?").run(sig.id);
          if (l && l.status === "proposed") { lines.push(`The user edited a draft to take out what lesson ${l.id} forbids. Vyre drafted it, not yet in force: "${l.rule}" ${enforced(l)}`, ASK); asked.push(l.id); }
        }

        const d = answer || prompt.trim().startsWith("/") ? null : distill(prompt);
        let proposed = null;
        if (d) {
          // The same check, or for a lesson without one, the same rule. (check_json IS NULL alone
          // would make every free-text correction match the first free-text lesson.)
          const same = row(d.check
            ? db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json = ? ORDER BY id").get(JSON.stringify(d.check))
            : db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json IS NULL AND rule = ? ORDER BY id").get(d.rule));
          if (!same) proposed = create({ ...d, source: { kind: "prompt", session, seq, text: prompt.slice(0, 400) } }, "proposed");
          // The signal names the lesson, the new proposal included, so a reply naming it can be matched to this thread.
          db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson) VALUES (?,?,?,?,?,?)").run(now(), "prompt", session, seq, prompt.slice(0, 400), same ? same.id : proposed.id);
          if (proposed) {
            ctx.events.emit("lesson.proposed", { lesson: proposed.id, rule: proposed.rule, checked: Boolean(proposed.check) }, { thread: session });
            lines.push(`The user's prompt reads as a standing rule. Vyre drafted it as lesson ${proposed.id}, not yet in force: "${proposed.rule}" ${enforced(proposed)}`,
              `${ASK} Follow the rule this turn either way.`);
            asked.push(proposed.id);
          } else if (same.status === "proposed") {
            lines.push(`Lesson ${same.id} ("${same.rule}") is still waiting for the user's answer. ${ASK}`);
            asked.push(same.id);
          } else if (/\b(again|i told you|already said)\b/i.test(prompt)) {
            await broke(same, session, [], "prompt");
          }
        }

        saveTurn({ session, prompt: prompt_id || null, seq, started: now(), blocks: 0, owed: "[]", asked: JSON.stringify(asked) });
        const reminders = lessons.filter(l => !l.check && l.level !== "block" && matches(l.when, prompt));
        if (reminders.length) lines.push("Lessons the user taught. Follow them:", ...reminders.map(l => `- ${l.rule}`));
        return { text: lines.length ? `Vyre lessons.\n${lines.join("\n")}` : "", seq, proposed: proposed ? proposed.id : null, broke: late.map(l => l.id) };
      },
    });

    ctx.tool("learn.check", {
      description: "What the hooks ask. stage tool: may this call run, given the lessons? stage stop: may this turn end, given its final reply and the files it changed? stage brief: every active lesson, for the start of a thread.",
      input: { type: "object", required: ["stage"], properties: { stage: { type: "string", enum: ["tool", "stop", "brief"] }, session: { type: "string" }, prompt_id: { type: "string" },
        cwd: { type: "string" }, agent: { type: "string" }, tool_name: { type: "string" }, tool_input: { type: "object" }, text: { type: "string" }, stop_hook_active: { type: "boolean" } } },
      run: async input => {
        const lessons = await inScope(active(), input);
        if (input.stage === "brief") {
          if (!lessons.length) return { text: "" };
          // Waiting a check out is visible: lessons in scope broken in the last seven days.
          const counts = new Map(db.prepare("SELECT lesson, COUNT(*) AS n FROM learn_signals WHERE kind = 'broken' AND at >= ? GROUP BY lesson").all(now() - WEEK).map(r => [r.lesson, r.n]));
          const broken = lessons.filter(l => counts.get(l.id)).map(l => { const n = counts.get(l.id); return `Lesson ${l.id} was broken ${n} time${n === 1 ? "" : "s"} this week: ${l.rule}`; });
          return { text: ["Vyre lessons the user taught. Those marked checked are enforced by hooks: a reply or change that breaks one is sent back.",
            ...broken, ...lessons.map(l => `- ${l.rule}${l.check ? " (checked)" : ""}`)].join("\n") };
        }
        const session = input.session || "";
        if (input.stage === "tool") return tool(lessons, session, input);
        return stop(lessons, session, input);
      },
    });

    /** PreToolUse. Returns { decision, reason, lesson } in the Harness rules' shape. */
    const tool = async (lessons, session, { tool_name = "", tool_input = {}, prompt_id, cwd }) => {
      // The guards hold wherever a lesson is active, in this folder or not: a lesson for another
      // project can be switched off from here too.
      const guard = active().length ? weakens(tool_name, tool_input, { home: root, cwd }) : null;
      if (guard) return { decision: "ask", reason: `${guard} Vyre asks the user first.`, lesson: null };
      const t = turn(session, prompt_id);
      const last = (await touchedSince(session, 0))[0];
      const ran = db.prepare("SELECT command FROM learn_commands WHERE session = ? AND at > ?").all(session, last ? last.at : -1).map(r => r.command);
      if (tool_name === "Bash" && typeof tool_input.command === "string") db.prepare("INSERT INTO learn_commands (session, command, at) VALUES (?,?,?)").run(session, tool_input.command.slice(0, 2000), now());

      const owe = JSON.parse(t.owed || "[]");
      let verdict = { decision: null, reason: undefined, lesson: null };
      for (const l of lessons) {
        const r = atTool(l.check, { tool: tool_name, input: tool_input, ran });
        if (!r.applied) continue;
        if (!r.problem) { bump.run(1, 0, 0, l.level, now(), l.id); continue; }
        if (l.level === "remind") { await broke(l, session, owe, "tool"); continue; }
        bump.run(1, 1, 0, l.level, now(), l.id);
        ctx.events.emit("lesson.caught", { lesson: l.id, session: session || null, stage: "tool", tool: tool_name }, { thread: session || undefined });
        if (!verdict.decision || (verdict.decision === "ask" && l.level === "block")) {
          verdict = { decision: l.level === "block" ? "deny" : "ask", reason: held(l, r.problem), lesson: l.id };
        }
      }
      saveTurn({ ...t, owed: JSON.stringify([...new Set(owe)]) });
      return verdict;
    };

    /** Stop. Returns { decision: "block", reason } to send the turn back, or { decision: null }. */
    const stop = async (lessons, session, { prompt_id, text, stop_hook_active }) => {
      const t = turn(session, prompt_id);
      // Claude Code says whether this Stop follows one of ours. When it does not, this is the
      // turn's first try at ending, whatever the count says.
      if (!stop_hook_active) t.blocks = 0;
      const first = t.blocks === 0;
      const touched = (await touchedSince(session, t.started)).map(f => f.path);
      const failed = [];
      for (const l of lessons) {
        const r = atStop(l.check, { text: typeof text === "string" ? text : null, touched });
        if (r.applied && first) bump.run(1, 0, 0, l.level, now(), l.id);
        if (r.problem) failed.push({ l, problem: r.problem });
      }
      const owe = JSON.parse(t.owed || "[]");
      const back = failed.filter(f => f.l.level !== "remind");
      if (back.length && t.blocks < MAX_BLOCKS) {
        t.blocks++;
        for (const { l } of back) {
          bump.run(0, 1, 0, l.level, now(), l.id);
          ctx.events.emit("lesson.caught", { lesson: l.id, session: session || null, stage: "stop", attempt: t.blocks }, { thread: session || undefined });
        }
        saveTurn(t);
        return { decision: "block", reason: sentBack(t.blocks, back), lessons: back.map(f => f.l.id) };
      }
      for (const { l } of failed) await broke(l, session, owe, "stop");
      saveTurn({ ...t, owed: JSON.stringify([...new Set(owe)]) });
      return { decision: null, broken: failed.map(f => f.l.id) };
    };

    return { async stop() { off(); offEdit(); } };
  },
};

/** How a lesson is enforced, in one sentence for Claude and the user. */
export function enforced(l) {
  const c = l.check;
  const how = l.level === "remind" ? "Vyre will remind you of it" : "Vyre enforces it";
  if (!c) return "It has no check; Vyre will repeat it to you.";
  if (c.kind === "text") return `${how}: a reply or file with ${c.label} is sent back.`;
  if (c.kind === "touched") return `${how}: a turn that changes code without ${c.require} is sent back.`;
  if (c.kind === "before") return `${how}: a matching command is held until the tests have run.`;
  return `${how}.`;
}

/** Does a lesson's `when` fit this prompt? "always" (or nothing) always does; otherwise a regex, or plain words. */
export function matches(when, prompt) {
  if (!when || when === "always") return true;
  try { return new RegExp(when, "i").test(prompt); } catch { return prompt.toLowerCase().includes(when.toLowerCase()); }
}
