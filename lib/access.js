// @ts-check
// access: the ONE shape for "who may use or edit this thing", shared by agents, flows (and later projects and vault items).
//
// A grant is { kind, id, subject: person | role, level: "use" | "edit", added_by }. "edit" includes "use". The creator, the owner and the admins
// always have both and are not stored here (the module that owns the thing says who they are). Each module keeps its own rows in its own store
// with a table of its own named `<module>_access`, so there is one shape and one set of rules, not one shared database.
//
//   migration  = accessMigration("agents_access")  the SQL step a module appends to its MIGRATIONS (a module's tables start with its own name)
//   a = new Access(db, "agents_access")            over the module's store
//   a.set(id, { kind: "person"|"role", subject, level }, by)   level null removes
//   a.list(id)                                      [{ kind, subject, level, by }]
//   a.level(id, { person, role })                   "edit" | "use" | "none" (stored grants only)
//
// What a level lets a person do is in LEVELS: the actions each module checks. The words are "Can use" and "Can edit".

export const LEVELS = Object.freeze({
  agent: Object.freeze({ use: Object.freeze(["agents.use", "agents.used"]), edit: Object.freeze(["agents.use", "agents.used", "agents.edit"]) }),
  flow: Object.freeze({ use: Object.freeze(["flows.use", "flows.run"]), edit: Object.freeze(["flows.use", "flows.run", "flows.edit", "flows.define"]) }),
  project: Object.freeze({ use: Object.freeze(["projects.use"]), edit: Object.freeze(["projects.use", "projects.edit"]) }),
  vault: Object.freeze({ use: Object.freeze(["vault.use"]), edit: Object.freeze(["vault.use", "vault.edit"]) }),
});
export const LEVEL_WORDS = Object.freeze({ use: "Can use", edit: "Can edit" });

const TABLE = /^[a-z]{2,20}_access$/;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;
const bad = (/** @type {string} */ m) => Object.assign(new Error(m), { code: "bad_input" });

/** The SQL step that makes a module's access table, named `<module>_access`. @param {string} table */
export function accessMigration(table) {
  if (!TABLE.test(table)) throw new Error("the table is <module>_access");
  return `CREATE TABLE ${table} (id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject TEXT NOT NULL, level TEXT NOT NULL, added_by TEXT, at INTEGER NOT NULL, PRIMARY KEY (id, subject_kind, subject))`;
}

/** Whether a level allows an action for this kind of thing. @param {string} kind @param {string} level @param {string} action */
export const allows = (kind, level, action) => Boolean(/** @type {any} */ (LEVELS)[kind]?.[level]?.includes(action));

export class Access {
  /** @param {any} db a module's store @param {string} table the module's access table */
  constructor(db, table) { if (!TABLE.test(table)) throw new Error("the table is <module>_access"); this.db = db; this.table = table; }

  /** @param {string} id */
  list(id) {
    return /** @type {any[]} */ (this.db.prepare(`SELECT subject_kind, subject, level, added_by FROM ${this.table} WHERE id = ? ORDER BY at`).all(id))
      .map(r => ({ kind: String(r.subject_kind), subject: String(r.subject), level: String(r.level), by: r.added_by == null ? null : String(r.added_by) }));
  }

  /**
   * @param {string} id @param {{ kind: string, subject: string, level: string | null }} g @param {string | null} by
   */
  set(id, g, by) {
    if (!["person", "role"].includes(g.kind) || typeof g.subject !== "string" || !SUBJECT.test(g.subject)) throw bad("name a person or a role");
    if (g.level === null || g.level === undefined) { this.db.prepare(`DELETE FROM ${this.table} WHERE id = ? AND subject_kind = ? AND subject = ?`).run(id, g.kind, g.subject); return; }
    if (g.level !== "use" && g.level !== "edit") throw bad("level is use or edit");
    this.db.prepare(`INSERT INTO ${this.table} (id, subject_kind, subject, level, added_by, at) VALUES (?,?,?,?,?,?) ON CONFLICT(id, subject_kind, subject) DO UPDATE SET level = excluded.level, added_by = excluded.added_by, at = excluded.at`)
      .run(id, g.kind, g.subject, g.level, by, Date.now());
  }

  /** The most this person (or their role) was given. @param {string} id @param {{ person?: string | null, role?: string | null }} who @returns {"edit" | "use" | "none"} */
  level(id, who) {
    const mine = this.list(id).filter(r => (r.kind === "person" && who.person && r.subject === who.person) || (r.kind === "role" && who.role && r.subject === who.role));
    return mine.some(r => r.level === "edit") ? "edit" : mine.length ? "use" : "none";
  }

  /** Everything given on a thing goes with it. @param {string} id */
  clear(id) { this.db.prepare(`DELETE FROM ${this.table} WHERE id = ?`).run(id); }
}
