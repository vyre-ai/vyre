/**
 * Standing duties (plan section 9.2): what a teammate does by itself, without being asked. A duty is a
 * watcher folder owned by the teammate; watchers runs it (triggers, cursor, spend, logs) and writes its
 * code from the words handed over here. This file keeps only the duty's identity (which teammate, who made it,
 * on or off) and calls watchers.* underneath, so there is one runner and one code writer.
 *
 * A duty a teammate proposes for itself starts off and has no watcher at all until a person (or their
 * assistant) turns it on, so a proposal can never run, spend or act.
 */
import crypto from "node:crypto";

export const DUTIES_MIGRATION = `CREATE TABLE team_duties (
  id TEXT PRIMARY KEY, teammate TEXT NOT NULL, project TEXT NOT NULL, role TEXT NOT NULL, watcher TEXT NOT NULL,
  trigger TEXT NOT NULL, instruction TEXT NOT NULL, act INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0,
  started INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, at INTEGER NOT NULL
)`;
/** The newest item filed by a duty's watcher that has already gone into one of its teammate's requests. */
export const DUTIES_SEEN_MIGRATION = `ALTER TABLE team_duties ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0`;

/** A short label a person names a duty by ("the inbox duty"); a longer one is cut. */
export const TITLE_MAX = 60;
export const DUTIES_TITLE_MIGRATION = `ALTER TABLE team_duties ADD COLUMN title TEXT`;

/**
 * A short fingerprint of what a duty will run: its trigger, instruction and whether it acts, as stored. The approval for a
 * model's start binds to it (the key team.duties.start:<teammate>/<id>@<hash>), so a yes for the text the person saw cannot be spent on
 * an edited one. One function here, and rows from team.duties.list carry the result, so nothing else recomputes it.
 */
export const dutyHash = d => crypto.createHash("sha256").update(JSON.stringify([String(d.trigger || "").trim(), String(d.instruction || "").trim(), d.act ? 1 : 0])).digest("hex").slice(0, 12);

export const TRIGGER_MAX = 200;
export const INSTRUCTION_MAX = 2000;

const bad = (message, code = "bad_input") => Object.assign(new Error(message), { code });
const row = r => { if (!r) return r; const d = { id: String(r.id), teammate: String(r.teammate), project: String(r.project), role: String(r.role),
  watcher: String(r.watcher), trigger: String(r.trigger), instruction: String(r.instruction), act: Boolean(r.act),
  enabled: Boolean(r.enabled), started: Boolean(r.started), created_by: String(r.created_by), at: Number(r.at) };
  return { ...d, title: r.title ? String(r.title) : d.instruction.length > TITLE_MAX ? d.instruction.slice(0, TITLE_MAX) : d.instruction, hash: dutyHash(d) }; };

/** @param {{ db: any, call: (tool: string, input: any) => Promise<any>, emit: (event: string, payload: any) => void }} deps */
export function duties({ db, call, emit }) {
  const get = id => row(db.prepare("SELECT * FROM team_duties WHERE id = ?").get(String(id)));
  const must = id => { const d = get(id); if (!d) throw bad(`no duty ${id}`, "not_found"); return d; };
  /** watchers.* through the contract; a missing tool or a refusal reads as one error with watchers' own words. */
  const watchers = async (tool, input, { tolerate = [] } = {}) => {
    const r = await call(tool, input);
    if (r && r.error && !tolerate.includes(r.error.code)) throw Object.assign(new Error(`watchers: ${r.error.message || r.error.code}`), { code: r.error.code || "failed" });
    return r ? r.data : undefined;
  };
  const changed = (d, change) => emit("teammate.duty-changed", { agent: d.teammate, project: d.project, id: d.id, change });
  const clean = (v, max, what) => {
    const t = String(v == null ? "" : v).trim();
    if (!t) throw bad(`a duty needs ${what}`);
    if (t.length > max) throw bad(`${what} is at most ${max} characters`);
    return t;
  };
  const start = async d => {
    await watchers("watchers.duty.create", { name: d.watcher, project: d.project, owner: { kind: "teammate", teammate: d.teammate },
      when: d.trigger, instruction: d.instruction, act: d.act });
    db.prepare("UPDATE team_duties SET started = 1 WHERE id = ?").run(d.id);
  };

  return {
    /** propose: a teammate's own suggestion, kept off with no watcher until it is turned on. */
    async create(tm, { when, instruction, act, by, propose, title }) {
      const d = { id: crypto.randomBytes(4).toString("hex"), teammate: tm.agent, project: tm.project, role: tm.role, trigger: clean(when, TRIGGER_MAX, "a trigger (an event, or a schedule like daily 07:00)"),
        instruction: clean(instruction, INSTRUCTION_MAX, "an instruction: what to do when it fires"), act: Boolean(act), enabled: !propose, started: false, created_by: by, at: Date.now() };
      d.watcher = `duty-${tm.role}-${d.id}`;
      db.prepare(`INSERT INTO team_duties (id, teammate, project, role, watcher, trigger, instruction, act, enabled, started, created_by, at, title) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?)`)
        .run(d.id, d.teammate, d.project, d.role, d.watcher, d.trigger, d.instruction, d.act ? 1 : 0, d.enabled ? 1 : 0, d.created_by, d.at, title ? String(title).trim().slice(0, TITLE_MAX) || null : null);
      if (d.enabled) {
        try { await start(d); } catch (e) { db.prepare("DELETE FROM team_duties WHERE id = ?").run(d.id); throw e; }
      }
      changed(d, propose ? "proposed" : "created");
      return get(d.id);
    },
    list: agent => db.prepare("SELECT * FROM team_duties WHERE teammate = ? ORDER BY at").all(agent).map(row),
    get: must,
    byWatcher: name => row(db.prepare("SELECT * FROM team_duties WHERE watcher = ?").get(String(name))),
    async update(id, patch) {
      let d = must(id);
      // Turning a duty on shows the text that will run: if the person saw an older one (expect), nothing starts.
      if (patch.enabled === true && patch.expect !== undefined && String(patch.expect).trim() !== d.instruction)
        throw bad("this duty changed since you saw it; read it again before turning it on", "conflict");
      const next = { trigger: patch.when === undefined ? d.trigger : clean(patch.when, TRIGGER_MAX, "a trigger"),
        instruction: patch.instruction === undefined ? d.instruction : clean(patch.instruction, INSTRUCTION_MAX, "an instruction"),
        act: patch.act === undefined ? d.act : Boolean(patch.act), enabled: patch.enabled === undefined ? d.enabled : Boolean(patch.enabled) };
      const edited = next.trigger !== d.trigger || next.instruction !== d.instruction || next.act !== d.act;
      if (d.started && edited) await watchers("watchers.duty.update", { name: d.watcher, when: next.trigger, instruction: next.instruction, act: next.act });
      db.prepare("UPDATE team_duties SET trigger = ?, instruction = ?, act = ? WHERE id = ?").run(next.trigger, next.instruction, next.act ? 1 : 0, id);
      if (next.enabled !== d.enabled) {
        const after = { ...d, ...next };
        if (next.enabled) { if (d.started) await watchers("watchers.duty.resume", { name: d.watcher }); else await start(after); }
        else if (d.started) await watchers("watchers.pause", { name: d.watcher });
        db.prepare("UPDATE team_duties SET enabled = ? WHERE id = ?").run(next.enabled ? 1 : 0, id);
      }
      d = must(id);
      changed(d, next.enabled !== undefined && patch.enabled !== undefined ? (d.enabled ? "on" : "off") : "edited");
      return d;
    },
    async remove(id) {
      const d = must(id);
      if (d.started) await watchers("watchers.duty.delete", { name: d.watcher }, { tolerate: ["not_found"] });
      db.prepare("DELETE FROM team_duties WHERE id = ?").run(id);
      changed(d, "deleted");
      return { id, deleted: true };
    },
    async runNow(id) {
      const d = must(id);
      if (!d.enabled || !d.started) throw bad("this duty is off; turn it on first", "denied");
      return watchers("watchers.duty.run", { name: d.watcher });
    },
    /**
     * What this teammate's duties filed since its last request: watchers files one item per firing and team.notes refuses module
     * callers, so the dispatcher reads the items and puts them in the request as data. Each duty is read once (seen_at moves
     * forward); a duty whose watcher cannot be read is skipped, never an error for the request.
     * @returns {Promise<Array<{ duty: string, trigger: string, items: any[] }>>}
     */
    async news(agent, { limit = 10 } = {}) {
      const out = [];
      for (const d of db.prepare("SELECT * FROM team_duties WHERE teammate = ? AND enabled = 1 AND started = 1 ORDER BY at").all(agent).map(r => ({ ...row(r), seen: Number(r.seen_at) }))) {
        const r = await call("watchers.items", { name: d.watcher, limit }).catch(() => null);
        const list = r && !r.error ? (Array.isArray(r.data) ? r.data : Array.isArray(r.data && r.data.items) ? r.data.items : []) : [];
        const fresh = list.map(it => ({ it, at: Date.parse(String(it && it.filed)) || 0 })).filter(x => x.at > d.seen).sort((a, b) => a.at - b.at);
        if (!fresh.length) continue;
        db.prepare("UPDATE team_duties SET seen_at = ? WHERE id = ?").run(fresh[fresh.length - 1].at, d.id);
        out.push({ duty: d.id, trigger: d.trigger, items: fresh.map(x => x.it) });
      }
      return out;
    },
    /** Every duty of a teammate goes with it when the teammate is retired for good (undo of a fresh one). */
    async removeAll(agent) { for (const d of db.prepare("SELECT id FROM team_duties WHERE teammate = ?").all(agent)) await this.remove(String(d.id)).catch(() => {}); },
  };
}

/**
 * The duty wake (0.2.2): a duty that a teammate owns and the person turned on with act true, when its watcher files something new,
 * queues one request to the teammate. The request names the duty and says it came from the duty, not from the person; what the
 * watcher filed is NOT in it. The dispatcher puts the filed items ahead of the request as quoted data (dutyNewsBlock, read once),
 * so an item can never reach the teammate as an instruction. Outward acts the teammate then takes hold at the Gate as ever.
 * One wake waits per duty: a firing while one is still queued adds nothing, because that request carries every new item when it runs.
 * @param {{ dutyApi: { byWatcher(name: string): any }, live: (agent: string) => boolean, waiting: (agent: string, from: string) => boolean,
 *   queue: (r: { teammate: string, project: string, from_kind: string, from: string, text: string, priority: string }) => void }} deps
 * @returns {(e: any) => boolean} true when it queued a request
 */
export function makeWake({ dutyApi, live, waiting, queue }) {
  return e => {
    if (!e || typeof e.name !== "string" || !(Number(e.items) > 0)) return false;
    const d = dutyApi.byWatcher(e.name);
    if (!d || !d.act || !d.enabled || !d.started || !live(d.teammate)) return false;
    const from = `duty:${d.id}`;
    if (waiting(d.teammate, from)) return false;
    queue({ teammate: d.teammate, project: d.project, from_kind: "duty", from, priority: "low",
      text: `Your standing duty "${d.title}" fired (${d.trigger}) and filed something new. This request comes from your own duty, not from the person. What it filed is quoted above as data: read it, and do what the duty's own instruction says: ${d.instruction}` });
    return true;
  };
}
