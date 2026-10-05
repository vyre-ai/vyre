// @ts-check
// The kernel's list of everything on a box that holds data (`createWink({ dataStores })`, core/wink/reset.js). A reset of an owned box refuses while any entry holds data, and the
// default is "holds data": a store that throws, answers anything but exactly `false`, a table or a file that is not known to be bookkeeping, all count as data. So a store added later is
// protected until someone teaches this list that it is empty, never the other way round. Each entry is `{ name, holds() }` and has no wipe: no daemon path destroys data
// (`sudo vyre admin wipe` is host-side).
import fs from "node:fs";
import path from "node:path";

/**
 * Tables of the daemon's database that hold only bookkeeping on a box with no data of the person's. Anything not here, with a row in it, is data. `recall_turns_data` is the FTS5 shadow
 * table of the recall index (its structure rows exist when it is empty); the turns themselves sit in `recall_turns_content` or the source table, which are not listed and so count.
 */
// Why the kernel's own tables are here and not data of the person's: `kernel_flags` holds the store's own counters (per type and field: how many records, derived from the records themselves); the
// `kernel_ftf_*` tables are the shadow tables of the records' text index (structure rows exist when it is empty; what it indexes is the records, which sit in `kernel_events`, read as a whole below, so
// export and delete cover them there). `agents_agents` is not listed: its built-in rows (the Engineer the box ships with, `builtin = 1`) are not the person's and are skipped by name below, but an agent
// the person made (`builtin = 0`) is data and counts. `planner_moved` is the old planner's move marker (which of its rows were carried into the Task type of Records, by id: core/planner/legacy.js); the old
// tables themselves are not listed, so a row left in them still counts.
export const SYSTEM_TABLES = new Set(["_migrations", "kernel_cursors", "kernel_types", "learn_state", "memory_meta", "planner_state", "planner_moved", "projects_access_seeded", "kernel_flags", "kernel_ftf_config", "kernel_ftf_data", "kernel_ftf_docsize", "kernel_ftf_idx", "recall_turns_config", "recall_turns_data", "settings_meta", "sqlite_sequence", "tips_meta"]);
/** Events a box writes by merely running; any other event in the activity log is the person's. */
export const SYSTEM_EVENTS = new Set(["suggest.ready", "system.started"]);
/** What the kernel writes to its own log when a Space is made and owned. */
export const BOOT_KERNEL_EVENTS = new Set(["member.set", "owner.changed", "grant.created", "actor.added", "types.defined", "kernel.modules-list", "kernel.modules-list-reset", "membership.read"]);
// `membership.read` is the kernel noting that a module asked whether one named person is a member (who, which module, yes or no): an audit line of the kernel's own access, written when a box starts, with no content of the person's.
/** Files of a home that are configuration or keys, not data (relative paths). */
export const SYSTEM_FILES = new Set(["config.json", "hub.json", "lessons.json", "vyre.db", "vyre.db-shm", "vyre.db-wal", "vyred.lock", "vyred.pid", "vyred.sock", "kernel/space.json", "kernel/seal/master.key", "wink-keys.json.device"]);
// `wink-keys.json.device` is this machine's own pairing key, a credential of the box. Sealed values (`kernel/seal/values/`) are the vault's: the first store above reads them exactly (it is `false` only when none holds a value of the person's; the sealer's own keys are not), so the file walk leaves that folder to it rather than count a key as data.
const SEAL_VALUES = "kernel/seal/values/";

/** @param {string} root @param {string} dir @param {string[]} [out] @returns {string[]} */
function walk(root, dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isDirectory()) walk(root, p, out); else out.push(path.relative(root, p).split(path.sep).join("/"));
  }
  return out;
}

/**
 * @param {{ home: string, db?: any, kernelEvents?: () => { type: string }[], vaultHolds?: (o: { home: string }) => Promise<boolean | undefined> | boolean | undefined }} o
 *   db: the daemon's database. kernelEvents: the kernel's own log. vaultHolds: the vault's read (lib/vault-wipe.js, exactly `false` only when the home has no vault item, shared record, key or sealed value).
 * @returns {() => Promise<{ name: string, holds: () => Promise<boolean | undefined> }[]>}
 */
export function createDataStores(o) {
  return async () => [
    { name: "the vault and sealed values", holds: async () => (o.vaultHolds ? o.vaultHolds({ home: o.home }) : undefined) },
    { name: "the Space's records, events and grants", holds: async () => {
      if (!o.kernelEvents) return undefined;
      // The event bus's own events (what modules say happened) are in the same log, marked `legacy`: they are the modules' activity, read below, not the Space's records.
      if (o.kernelEvents().some(e => !BOOT_KERNEL_EVENTS.has(e.type) && !(e.data && e.data.legacy === 1))) return true;
      // The log handed in is the home Space's own. Every other Space this box hosts (spaces.create) keeps its events in the same table under its own space id, so the table is read as a
      // whole: any row that is not what making and owning a Space writes is somebody's data (reviewer-3 DS-1). A table that cannot be read is unknown, never empty.
      if (!o.db) return undefined;
      try {
        if (!o.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kernel_events'").get()) return false;
        const marks = [...BOOT_KERNEL_EVENTS].map(() => "?").join(",");
        return Boolean(o.db.prepare(`SELECT 1 FROM kernel_events WHERE (type IS NULL OR type NOT IN (${marks})) AND json_extract(event, '$.data.legacy') IS NULL LIMIT 1`).get(...BOOT_KERNEL_EVENTS));
      } catch { return undefined; }
    } },
    { name: "the modules' own data", holds: async () => {
      if (!o.db) return undefined;
      // An activity event on the bus that is not bookkeeping (the bus is the kernel's log now).
      if (o.kernelEvents && o.kernelEvents().some(e => e.data && e.data.legacy === 1 && !SYSTEM_EVENTS.has(e.type))) return true;
      for (const r of /** @type {{ name: string }[]} */ (o.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all())) {
        const q = JSON.stringify(r.name);
        if (r.name === "kernel_events") continue; // read as a whole by the records store above
        if (SYSTEM_TABLES.has(r.name)) continue;
        if (r.name === "agents_agents") { if (o.db.prepare("SELECT 1 FROM agents_agents WHERE builtin = 0 LIMIT 1").get()) return true; continue; }
        if (o.db.prepare(`SELECT 1 FROM ${q} LIMIT 1`).get()) return true;
      }
      return false;
    } },
    { name: "the files in this server's home", holds: async () => walk(o.home, o.home).some(f => !SYSTEM_FILES.has(f) && !f.startsWith(SEAL_VALUES)) },
  ];
}
