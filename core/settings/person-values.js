// @ts-check
// Per person settings: the few settings that belong to one person in one Space (the theme, the notification switches), kept as a small record keyed by Space and person.
// A setting opts in with `perPerson: true` in its module.json declaration. Its account level then reads and writes the CALLING person's own row; a caller with no person on its chain
// (a module, a build with no kernel) keeps the old server-wide value. The server-wide value is copied into a person's row once, the first time that person reads or writes, and a change
// there never reaches into anyone else's row. Pure storage: who the person is comes from the kernel's chain (callPerson), never from a caller's input.

import { personOfChain, personOfMeta } from "../../lib/lent-placement.js";

export const PERSON_MIGRATIONS = [
  `CREATE TABLE settings_person (space TEXT NOT NULL, person TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (space, person, key))`,
  `CREATE TABLE settings_person_seeded (space TEXT NOT NULL, person TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (space, person))`,
];

/**
 * The person a call is from: the kernel's chain for it (exactly one person hop, no agent), else, only on a build with no kernel, the person the daemon put on the call. Null for anyone else.
 * @param {any} kernel ctx.kernel @param {any} meta
 * @returns {Promise<string | null>}
 */
export async function callPerson(kernel, meta) {
  if (!meta) return null;
  if (kernel && typeof kernel.chain === "function") {
    try { return personOfChain(await kernel.chain(meta)); } catch { return null; }
  }
  const p = personOfMeta(meta);
  return typeof p === "string" && p ? p : null;
}

/**
 * @param {import("node:sqlite").DatabaseSync | any} db @param {() => string} space the Space this home hosts ("" with no kernel)
 * @param {() => number} [now]
 */
export function personValues(db, space, now = Date.now) {
  const sp = () => String(space() || "");
  return {
    /** @param {string} person @param {string} key @returns {any} undefined when the person has no value */
    get(person, key) {
      const r = /** @type {any} */ (db.prepare("SELECT value FROM settings_person WHERE space = ? AND person = ? AND key = ?").get(sp(), String(person), key));
      return r ? JSON.parse(String(r.value)) : undefined;
    },
    /** @param {string} person @param {string} key @param {any} value */
    set(person, key, value) {
      db.prepare("INSERT INTO settings_person (space, person, key, value, at) VALUES (?,?,?,?,?) ON CONFLICT(space, person, key) DO UPDATE SET value = excluded.value, at = excluded.at")
        .run(sp(), String(person), key, JSON.stringify(value), now());
    },
    /** @param {string} person @param {string} key */
    del(person, key) { db.prepare("DELETE FROM settings_person WHERE space = ? AND person = ? AND key = ?").run(sp(), String(person), key); },
    /** Whether any person of this Space holds this value for this key. @param {string} key @param {any} value */
    anyHolds(key, value) { return Boolean(db.prepare("SELECT 1 FROM settings_person WHERE space = ? AND key = ? AND value = ? LIMIT 1").get(sp(), key, JSON.stringify(value))); },
    /** @param {string} person */
    seeded: person => Boolean(db.prepare("SELECT 1 FROM settings_person_seeded WHERE space = ? AND person = ?").get(sp(), String(person))),
    /** The one-time copy: `values` (key to value) become the person's rows, and the person is marked so it never happens again. @param {string} person @param {Record<string, any>} values */
    seed(person, values) {
      for (const [k, v] of Object.entries(values)) if (v !== undefined && this.get(person, k) === undefined) this.set(person, k, v);
      db.prepare("INSERT OR IGNORE INTO settings_person_seeded (space, person, at) VALUES (?,?,?)").run(sp(), String(person), now());
    },
  };
}
