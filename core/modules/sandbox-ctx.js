// @ts-check
// The module's ctx, for a module that runs in the sandbox (kernel/modules/child.js). The module's own ctx lives HERE, in the host, built by the registry exactly as for a built-in module, so every
// declaration it checks (needs.tools, needs.network, needs.credentials, watches.emits, teaches.memory ...) is checked the same way; the sandbox sends each door as a message and gets JSON back. One
// contract, one place the declarations are enforced; only the transport differs. What does not cross: anything that is not a door of the contract, the built-in members, a way to name another
// caller (`ctx.call(..., { as })`), and a shared database: `ctx.store` here is the module's OWN file in its data folder, reached with async `exec`, `query` and `migrate`, never `ctx.store.db`.
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";

/** The doors of module API 1 an added module may reach (ADR 0047 section 3), by their first name. */
const DOORS = new Set(["call", "events", "store", "settings", "vault", "connections", "gate", "memory", "ask", "spend", "push", "undo", "modules", "fetch", "kernel"]);
/** Of `ctx.events`, only these: `subscribe` is handled here (a listener cannot cross as a function). `prune` is built in. */
const EVENT_DOORS = new Set(["emit", "since", "latestId", "subscribe"]);
/** Of `ctx.vault`, only `request`: `fetch` and the raw items are built in. */
const VAULT_DOORS = new Set(["request"]);
const bad = (/** @type {string} */ why) => Object.assign(new Error(why), { code: "undeclared" });

/**
 * @param {{ name: string, ctx: any, dataDir: string }} o `ctx` is the module's own host-side ctx; `dataDir` its data folder (`<home>/data/<module>`)
 * @returns {(path: string[], args: any[], io: { push: (id: number, event: any) => void }) => Promise<any>}
 */
/**
 * The SQL the exec and query doors run is the host's, so it must stay inside the module's own file: no ATTACH (another database), VACUUM INTO (a write to any path),
 * PRAGMA or extension loading, and only the verbs a module needs (the migrate door owns the table-name rule for schema changes).
 * Words inside string literals and comments are ignored when looking, so they neither hide a verb nor trip the check.
 * @param {string} name @param {any} sql @param {boolean} readOnly
 */
export function ownSql(name, sql, readOnly) {
  const text = String(sql);
  const bare = text.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, " ");
  const first = (bare.trim().match(/^[a-z]+/i) || [""])[0].toUpperCase();
  const verbs = readOnly ? ["SELECT", "WITH"] : ["SELECT", "WITH", "INSERT", "UPDATE", "DELETE", "REPLACE", "CREATE", "ALTER", "DROP"];
  if (!verbs.includes(first)) throw bad(`${name}: ctx.store.${readOnly ? "query" : "exec"} runs ${verbs.join(", ")} only`);
  if (/\b(ATTACH|DETACH|VACUUM|PRAGMA|LOAD_EXTENSION|INTO\s+OUTFILE)\b/i.test(bare)) throw bad(`${name}: ctx.store reaches this module's own database only (no ATTACH, VACUUM, PRAGMA or extensions)`);
  return text;
}

export function sandboxDoor({ name, ctx, dataDir }) {
  /** @type {any} */ let own = null;
  const ownDb = () => {
    if (!own) { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); own = open(path.join(dataDir, "module.db")); own.exec("PRAGMA trusted_schema=OFF"); }
    return own;
  };
  const offs = /** @type {Array<() => void>} */ ([]);
  const door = async (/** @type {string[]} */ at, /** @type {any[]} */ args, /** @type {{ push: (id: number, event: any) => void }} */ io) => {
    if (!Array.isArray(at) || !at.length || at.some(k => typeof k !== "string" || k === "constructor" || k === "__proto__" || k === "prototype")) throw bad(`${name}: not a door`);
    const [head, tail] = at;
    if (!DOORS.has(head)) throw bad(`${name}: ctx.${at.join(".")} is not a door of module API 1`);
    if (head === "store") {
      const a = Array.isArray(args) ? args : [];
      if (tail === "migrate") { migrate(ownDb(), name, a[0]); return null; }
      if (tail === "exec") { const r = ownDb().prepare(ownSql(name, a[0], false)).run(...(Array.isArray(a[1]) ? a[1] : [])); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
      if (tail === "query") return ownDb().prepare(ownSql(name, a[0], true)).all(...(Array.isArray(a[1]) ? a[1] : []));
      throw bad(`${name}: ctx.store.${tail} is not a door (exec, query and migrate are)`);
    }
    if (head === "events" && !EVENT_DOORS.has(tail)) throw bad(`${name}: ctx.events.${tail} is not a door`);
    if (head === "events" && tail === "subscribe") {
      const [pattern, id] = args;
      offs.push(ctx.events.on(String(pattern), (/** @type {any} */ e) => io.push(Number(id), e)));
      return true;
    }
    if (head === "vault" && !VAULT_DOORS.has(tail)) throw bad(`${name}: ctx.vault.${tail} is not a door (request is)`);
    if (head === "call") return ctx.call(String(args[0]), args[1]);
    /** @type {any} */ let target = ctx, owner = ctx;
    for (const k of at) { owner = target; target = target == null ? undefined : target[k]; }
    if (typeof target !== "function") throw bad(`${name}: ctx.${at.join(".")} is not a function`);
    return target.apply(owner, Array.isArray(args) ? args : []);
  };
  door.close = () => { for (const off of offs.splice(0)) { try { off(); } catch { /* gone */ } } if (own) { try { own.close(); } catch { /* closed */ } own = null; } };
  return door;
}
