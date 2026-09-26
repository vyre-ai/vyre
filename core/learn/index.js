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
// told to ask the user, and it becomes a lesson when the user accepts it (learn.accept), or when
// the user writes it themselves (learn.add, `/vyre remember`, `vyre learn add`).
//
// Levels: remind (repeated to Claude, never holds anything), ask (a tool call waits for the
// user; a reply is sent back), block (a tool call is denied; a reply is sent back). A lesson
// broken again moves up one level.

import { distill, invalid, atStop, atTool, weakens, sentBack, held, MAX_BLOCKS } from "./checks.js";
import { writeSnapshot, drain } from "./offline.js";

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
];

export { MAX_BLOCKS };
const LEVELS = ["remind", "ask", "block"];

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
      created: r.created, updated: r.updated,
    };
    const get = id => row(db.prepare("SELECT * FROM learn_lessons WHERE id = ?").get(id));
    const active = () => db.prepare("SELECT * FROM learn_lessons WHERE status = 'active' ORDER BY id").all().map(row);
    const must = id => { const l = get(id); if (!l) throw new Error(`no lesson ${id}`); return l; };

    /** Check a lesson's parts; throws with a readable reason. */
    const clean = ({ rule, when, level, scope, check }) => {
      if (rule !== undefined && (typeof rule !== "string" || !rule.trim() || rule.length > 400)) throw new Error("rule must be a sentence, at most 400 characters");
      if (level !== undefined && !LEVELS.includes(level)) throw new Error(`level must be one of ${LEVELS.join(", ")}`);
      if (scope !== undefined && scope !== "all" && !(scope && typeof scope === "object" && (typeof scope.project === "string" || typeof scope.agent === "string"))) {
        throw new Error('scope must be "all", { project } or { agent }');
      }
      const bad = invalid(check);
      if (bad) throw new Error(bad);
      if (when !== undefined && typeof when !== "string") throw new Error("when must be a string");
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
    const saveTurn = t => db.prepare(`INSERT INTO learn_turns (session, prompt, seq, started, blocks, owed) VALUES (?,?,?,?,?,?)
      ON CONFLICT (session) DO UPDATE SET prompt = excluded.prompt, seq = excluded.seq, started = excluded.started, blocks = excluded.blocks, owed = excluded.owed`)
      .run(t.session, t.prompt ?? null, t.seq, t.started, t.blocks, t.owed);
    const turn = (session, prompt_id) => {
      const t = turnOf(session) || { session, prompt: null, seq: 0, started: 0, blocks: 0, owed: "[]" };
      // A turn Enrich never saw (vyred came up mid-turn): a new turn from here, counted from 0.
      if (prompt_id && t.prompt && t.prompt !== prompt_id) Object.assign(t, { prompt: prompt_id, seq: t.seq + 1, blocks: 0 });
      return t;
    };

    const bump = db.prepare("UPDATE learn_lessons SET applied = applied + ?, caught = caught + ?, broken = broken + ?, level = ?, updated = ? WHERE id = ?");
    /** A lesson ended a turn (or ran a tool) still failing: count it, and move it up a level the second time. */
    const broke = (l, session, owe) => {
      const from = l.level;
      const to = l.broken + 1 >= 2 && from !== "block" ? LEVELS[LEVELS.indexOf(from) + 1] : from;
      bump.run(0, 0, 1, to, now(), l.id);
      ctx.events.emit("lesson.broken", { lesson: l.id, session: session || null, level: from }, { thread: session || undefined });
      if (to !== from) { ctx.events.emit("lesson.escalated", { lesson: l.id, from, to }); snap(); }
      owe.push(l.id);
    };

    /** The lessons that apply here: scope "all", this project, or this agent. */
    const inScope = async (lessons, { cwd, agent }) => {
      let project;
      if (lessons.some(l => l.scope && l.scope.project)) {
        const r = cwd ? await ctx.call("projects.of", { cwd }) : null;
        project = r && r.data ? r.data.project : null;
      }
      return lessons.filter(l => l.scope === "all" || (l.scope.project && l.scope.project === project) || (l.scope.agent && l.scope.agent === agent));
    };

    /** Files changed in this thread since `since`, from the Harness. */
    const touchedSince = async (session, since) => {
      const r = await ctx.call("harness.touched", { session, limit: 500 });
      return r && Array.isArray(r.data) ? r.data.filter(f => f.at >= since) : [];
    };

    // The hooks' copy of the accepted lessons, for when vyred is down (offline.js). Rewritten on
    // every change; a home that cannot be written costs the offline checks, never a tool call.
    const root = ctx.paths && ctx.paths.root;
    const snap = () => {
      if (!root) return;
      try { writeSnapshot(root, active()); } catch (e) { ctx.log("lessons snapshot not written: " + /** @type {Error} */ (e).message); }
    };
    // What the hooks caught or saw broken while vyred was down, counted now, escalation included.
    if (root) for (const e of drain(root)) {
      const l = get(e.lesson);
      if (!l || l.status !== "active") continue;
      if (e.kind === "caught") {
        bump.run(0, 1, 0, l.level, now(), l.id);
        ctx.events.emit("lesson.caught", { lesson: l.id, session: e.session || null, stage: "offline" }, { thread: e.session || undefined });
      } else if (e.kind === "broken") broke(l, e.session, []);
    }
    snap();

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
          scope, check: check !== undefined ? check : d ? d.check : null, source: { kind: "remember", session: session || null, text: text || rule } }, "active");
        ctx.events.emit("lesson.learned", { lesson: l.id, rule: l.rule, level: l.level, checked: Boolean(l.check) });
        snap();
        return l;
      },
    });

    ctx.tool("learn.accept", {
      description: "The user accepted a proposed lesson. Call only after the user has said yes to it in this conversation.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => {
        const l = must(id);
        if (l.status === "active") return l;
        if (l.status !== "proposed") throw new Error(`lesson ${id} is ${l.status}`);
        db.prepare("UPDATE learn_lessons SET status = 'active', updated = ? WHERE id = ?").run(now(), id);
        ctx.events.emit("lesson.learned", { lesson: id, rule: l.rule, level: l.level, checked: Boolean(l.check) });
        snap();
        return get(id);
      },
    });

    ctx.tool("learn.edit", {
      description: "Change a lesson: its rule, when it applies, its level, its scope or its check. The user's call; Claude is asked before it can run this.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" }, rule: { type: "string" }, when: { type: "string" }, level: { type: "string", enum: LEVELS }, scope: scopeSchema, check: { anyOf: [checkSchema, { type: "null" }] } } },
      run: async ({ id, ...change }) => {
        must(id);
        clean(change);
        const cols = { rule: "rule", when: "when_text", level: "level", scope: "scope", check: "check_json" };
        const sets = [], vals = [];
        for (const [k, col] of Object.entries(cols)) if (change[k] !== undefined) {
          sets.push(`${col} = ?`);
          vals.push(k === "scope" ? JSON.stringify(change[k]) : k === "check" ? (change[k] ? JSON.stringify(change[k]) : null) : change[k]);
        }
        if (sets.length) db.prepare(`UPDATE learn_lessons SET ${sets.join(", ")}, updated = ? WHERE id = ?`).run(...vals, now(), id);
        snap();
        return get(id);
      },
    });

    ctx.tool("learn.retire", {
      description: "Retire a lesson, or decline a proposed one. The user's call; Claude is asked before it can run this.",
      input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      run: async ({ id }) => {
        must(id);
        db.prepare("UPDATE learn_lessons SET status = 'retired', updated = ? WHERE id = ?").run(now(), id);
        ctx.events.emit("lesson.retired", { lesson: id });
        snap();
        return get(id);
      },
    });

    ctx.tool("learn.signal", {
      internal: true,
      description: "Enrich: a prompt starts a turn. Proposes a lesson when the prompt is a correction, and returns what Claude should be told: the proposal, lessons broken last turn, and reminders whose `when` matches.",
      input: { type: "object", required: ["session"], properties: { session: { type: "string" }, prompt_id: { type: "string" }, prompt: { type: "string" }, cwd: { type: "string" }, agent: { type: "string" } } },
      run: async ({ session, prompt_id, prompt = "", cwd, agent }) => {
        const t = turnOf(session) || { session, seq: -1, owed: "[]" };
        const owed = /** @type {number[]} */ (JSON.parse(t.owed || "[]"));
        saveTurn({ session, prompt: prompt_id || null, seq: t.seq + 1, started: now(), blocks: 0, owed: "[]" });
        const seq = t.seq + 1;
        const lines = [];

        const lessons = await inScope(active(), { cwd, agent });
        const late = owed.map(get).filter(l => l && l.status === "active");
        if (late.length) lines.push(`Last turn broke ${late.length === 1 ? "this lesson" : "these lessons"}. Keep ${late.length === 1 ? "it" : "them"} this turn.`, ...late.map(l => `- ${l.rule}`));

        const d = prompt.trim().startsWith("/") ? null : distill(prompt);
        let proposed = null;
        if (d) {
          // The same check, or for a lesson without one, the same rule. (check_json IS NULL alone
          // would make every free-text correction match the first free-text lesson.)
          const same = row(d.check
            ? db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json = ? ORDER BY id").get(JSON.stringify(d.check))
            : db.prepare("SELECT * FROM learn_lessons WHERE status IN ('active','proposed') AND check_json IS NULL AND rule = ? ORDER BY id").get(d.rule));
          db.prepare("INSERT INTO learn_signals (at, kind, session, seq, text, lesson) VALUES (?,?,?,?,?,?)").run(now(), "prompt", session, seq, prompt.slice(0, 400), same ? same.id : null);
          if (!same) {
            proposed = create({ ...d, source: { kind: "prompt", session, seq, text: prompt.slice(0, 400) } }, "proposed");
            ctx.events.emit("lesson.proposed", { lesson: proposed.id, rule: proposed.rule, checked: Boolean(proposed.check) }, { thread: session });
            lines.push(`The user's prompt reads as a standing rule. Vyre drafted it as lesson ${proposed.id}, not yet in force: "${proposed.rule}" ${enforced(proposed)}`,
              `Tell the user this in one line and ask whether to keep it. Only if they say yes, call the Vyre tool learn_accept with {"id": ${proposed.id}}. Follow it either way.`);
          } else if (same.status === "proposed") {
            lines.push(`Lesson ${same.id} ("${same.rule}") is still waiting for the user's yes. If this prompt is that yes, call learn_accept with {"id": ${same.id}}.`);
          } else if (/\b(again|i told you|already said)\b/i.test(prompt)) {
            broke(same, session, []);
          }
        }

        const reminders = lessons.filter(l => !l.check && l.level !== "block" && matches(l.when, prompt));
        if (reminders.length) lines.push("Lessons the user taught. Follow them:", ...reminders.map(l => `- ${l.rule}`));
        return { text: lines.length ? `Vyre lessons.\n${lines.join("\n")}` : "", seq, proposed: proposed ? proposed.id : null };
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
          return { text: ["Vyre lessons the user taught. Those marked checked are enforced by hooks: a reply or change that breaks one is sent back.",
            ...lessons.map(l => `- ${l.rule}${l.check ? " (checked)" : ""}`)].join("\n") };
        }
        const session = input.session || "";
        if (input.stage === "tool") return tool(lessons, session, input);
        return stop(lessons, session, input);
      },
    });

    /** PreToolUse. Returns { decision, reason, lesson } in the Harness rules' shape. */
    const tool = async (lessons, session, { tool_name = "", tool_input = {}, prompt_id }) => {
      const guard = lessons.length ? weakens(tool_name, tool_input) : null;
      if (guard) return { decision: "ask", reason: `${guard} Vyre asks the user first.`, lesson: null };
      const t = turn(session, prompt_id);
      const last = (await touchedSince(session, 0))[0];
      const ran = db.prepare("SELECT command FROM learn_commands WHERE session = ? AND at >= ?").all(session, last ? last.at : 0).map(r => r.command);
      if (tool_name === "Bash" && typeof tool_input.command === "string") db.prepare("INSERT INTO learn_commands (session, command, at) VALUES (?,?,?)").run(session, tool_input.command.slice(0, 2000), now());

      const owe = JSON.parse(t.owed || "[]");
      let verdict = { decision: null, reason: undefined, lesson: null };
      for (const l of lessons) {
        const r = atTool(l.check, { tool: tool_name, input: tool_input, ran });
        if (!r.applied) continue;
        if (!r.problem) { bump.run(1, 0, 0, l.level, now(), l.id); continue; }
        if (l.level === "remind") { broke(l, session, owe); continue; }
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
      for (const { l } of failed) broke(l, session, owe);
      saveTurn({ ...t, owed: JSON.stringify([...new Set(owe)]) });
      return { decision: null, broken: failed.map(f => f.l.id) };
    };

    return { async stop() { off(); } };
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
