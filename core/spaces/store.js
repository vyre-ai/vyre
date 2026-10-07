// @ts-check
// spaces: the SQLite side. Every table is prefixed spaces_. Reads are cheap and nothing here polls.
// The stores below have the shapes lib/spaces/ asks for: a key-value store for the create flow (homes.js), a
// MembershipStore (members.js), an invite store with an atomic update (invites.js) and the module-local pairing
// code service. The database handle is synchronous, so a read-modify-write inside one function is atomic in the process.

import crypto from "node:crypto";

export const MIGRATIONS = [
  `
  CREATE TABLE spaces_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE spaces_space (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    display_name TEXT,
    created_by TEXT NOT NULL,
    status TEXT NOT NULL,
    home TEXT,
    root_public TEXT,
    workspace_id TEXT,
    aliases TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX spaces_space_name ON spaces_space (name);
  CREATE TABLE spaces_member (
    space TEXT NOT NULL,
    person TEXT NOT NULL,
    role TEXT NOT NULL,
    scope TEXT,
    expires INTEGER,
    added_by TEXT,
    added_at INTEGER,
    expired INTEGER NOT NULL DEFAULT 0,
    expired_at INTEGER,
    PRIMARY KEY (space, person)
  );
  CREATE INDEX spaces_member_person ON spaces_member (person);
  CREATE TABLE spaces_role_name (
    space TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (space, role)
  );
  CREATE TABLE spaces_invite (
    id TEXT PRIMARY KEY,
    space TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX spaces_invite_space ON spaces_invite (space);
  CREATE TABLE spaces_pairing (
    scope TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
];

const parse = (/** @type {any} */ s, /** @type {any} */ fallback = null) => { if (s === null || s === undefined) return fallback; try { return JSON.parse(s); } catch { return fallback; } };

/** The create flow's key-value store (lib/spaces/homes.js `deps.store`). JSON values. @param {any} db */
export function kvStore(db) {
  return {
    async get(/** @type {string} */ key) {
      const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(key));
      return r ? parse(r.value) : null;
    },
    async put(/** @type {string} */ key, /** @type {any} */ value) {
      db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
    },
    async delete(/** @type {string} */ key) { db.prepare("DELETE FROM spaces_kv WHERE key = ?").run(key); },
  };
}

/** @param {any} r */
const memberOut = r => {
  if (!r) return undefined;
  /** @type {any} */
  const m = { space: r.space, person: r.person, role: r.role, added_by: r.added_by, added_at: r.added_at };
  const scope = parse(r.scope);
  if (Array.isArray(scope)) m.scope = scope;
  if (r.expires !== null && r.expires !== undefined) m.expires = Number(r.expires);
  if (r.expired) { m.expired = true; m.expired_at = Number(r.expired_at); }
  return Object.freeze(m);
};

/** The MembershipStore lib/spaces/members.js wants: get, put, delete, list. @param {any} db */
// SHIM(legacy labels): deleted in the kernel default-on commit; a Space the kernel hosts keeps its memberships in the kernel.
export function membershipStore(db) {
  return {
    get(/** @type {string} */ space, /** @type {string} */ person) {
      return memberOut(db.prepare("SELECT * FROM spaces_member WHERE space = ? AND person = ?").get(space, person));
    },
    put(/** @type {any} */ rec) {
      db.prepare(`INSERT INTO spaces_member (space, person, role, scope, expires, added_by, added_at, expired, expired_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(space, person) DO UPDATE SET role = excluded.role, scope = excluded.scope, expires = excluded.expires, added_by = excluded.added_by,
        added_at = excluded.added_at, expired = excluded.expired, expired_at = excluded.expired_at`)
        .run(rec.space, rec.person, rec.role, rec.scope ? JSON.stringify(rec.scope) : null, rec.expires ?? null, rec.added_by ?? null, rec.added_at ?? null,
          rec.expired ? 1 : 0, rec.expired_at ?? null);
    },
    delete(/** @type {string} */ space, /** @type {string} */ person) {
      return db.prepare("DELETE FROM spaces_member WHERE space = ? AND person = ?").run(space, person).changes > 0;
    },
    list(/** @type {string} */ space) {
      return /** @type {any[]} */ (db.prepare("SELECT * FROM spaces_member WHERE space = ? ORDER BY added_at, person").all(space)).map(memberOut);
    },
  };
}

/** Display names of the roles, per space. @param {any} db */
export function roleNames(db) {
  return {
    load(/** @type {string} */ space) {
      /** @type {Record<string, string>} */
      const out = {};
      for (const r of /** @type {any[]} */ (db.prepare("SELECT role, name FROM spaces_role_name WHERE space = ?").all(space))) out[r.role] = r.name;
      return out;
    },
    save(/** @type {string} */ space, /** @type {Record<string, string>} */ names) {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM spaces_role_name WHERE space = ?").run(space);
        for (const [role, name] of Object.entries(names)) db.prepare("INSERT INTO spaces_role_name (space, role, name) VALUES (?,?,?)").run(space, role, name);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
    },
  };
}

/** The invite store for ONE space. `update` runs the function on the stored record and stores its result in one synchronous step,
 *  so two accepts of one single-use link cannot both win. A function that throws stores nothing. @param {any} db @param {string} space */
export function inviteStore(db, space) {
  const read = (/** @type {string} */ id) => {
    const r = /** @type {any} */ (db.prepare("SELECT data FROM spaces_invite WHERE id = ? AND space = ?").get(id, space));
    return r ? parse(r.data) : undefined;
  };
  return {
    get: (/** @type {string} */ id) => read(id),
    put(/** @type {any} */ rec) {
      db.prepare("INSERT INTO spaces_invite (id, space, data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data").run(rec.id, space, JSON.stringify(rec));
    },
    list() { return /** @type {any[]} */ (db.prepare("SELECT data FROM spaces_invite WHERE space = ? ORDER BY rowid").all(space)).map(r => parse(r.data)); },
    update(/** @type {string} */ id, /** @type {(rec: any) => any} */ fn) {
      const cur = read(id);
      if (!cur) return undefined;
      const next = fn(structuredClone(cur));
      db.prepare("UPDATE spaces_invite SET data = ? WHERE id = ? AND space = ?").run(JSON.stringify(next), id, space);
      return structuredClone(next);
    },
  };
}

/**
 * The pairing code service: ONE module-local implementation of `startCode` and `verifyCode` for lib/spaces/homes.js. Tailnet's real
 * server pairing replaces this function and nothing else changes. Six digits, kept as a hash, single use, and the lib counts tries
 * and the lifetime. @param {any} db @param {{ now: () => number }} clock @param {{ ttlMs: number }} opts
 */
export function pairingService(db, clock, opts) {
  const scopeOf = (/** @type {string} */ spaceId, /** @type {any} */ ctx) => (ctx && ctx.joinId ? `${spaceId}/${ctx.joinId}` : spaceId);
  const hash = (/** @type {string} */ scope, /** @type {string} */ code) => crypto.createHash("sha256").update(`vyre-spaces-pairing-v1\n${scope}\n${code}`).digest("hex");
  return {
    async startCode(/** @type {string} */ spaceId, /** @type {any} */ ctx) {
      const scope = scopeOf(spaceId, ctx);
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const expiresAt = clock.now() + opts.ttlMs;
      db.prepare("INSERT INTO spaces_pairing (scope, code_hash, expires_at) VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at")
        .run(scope, hash(scope, code), expiresAt);
      return { code, expiresAt };
    },
    async verifyCode(/** @type {string} */ spaceId, /** @type {string} */ code, /** @type {any} */ ctx) {
      const scope = scopeOf(spaceId, ctx);
      const r = /** @type {any} */ (db.prepare("SELECT code_hash, expires_at FROM spaces_pairing WHERE scope = ?").get(scope));
      if (!r || clock.now() > Number(r.expires_at)) return false;
      const a = Buffer.from(String(r.code_hash)), b = Buffer.from(hash(scope, String(code)));
      const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (ok) db.prepare("DELETE FROM spaces_pairing WHERE scope = ?").run(scope);
      return ok;
    },
  };
}

/** The spaces table. @param {any} db */
export function spaceTable(db) {
  /** @param {any} r */
  const out = r => r && ({
    id: r.id, name: r.name, label: r.label, displayName: r.display_name ?? null, createdBy: r.created_by, status: r.status, home: parse(r.home),
    rootPublic: r.root_public ?? null, workspaceId: r.workspace_id ?? null, aliases: parse(r.aliases, []), warnings: parse(r.warnings, []),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
  });
  return {
    get: (/** @type {string} */ id) => out(db.prepare("SELECT * FROM spaces_space WHERE id = ?").get(id)),
    byName: (/** @type {string} */ name) => out(db.prepare("SELECT * FROM spaces_space WHERE name = ?").get(name)),
    all: () => /** @type {any[]} */ (db.prepare("SELECT * FROM spaces_space ORDER BY created_at, id").all()).map(out),
    /** @param {{ id: string, name: string, label: string, displayName?: string|null, createdBy: string, status: string, now: number }} s */
    insert(s) {
      db.prepare("INSERT INTO spaces_space (id, name, label, display_name, created_by, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(s.id, s.name, s.label, s.displayName ?? null, s.createdBy, s.status, s.now, s.now);
    },
    /** @param {string} id @param {Record<string, any>} patch @param {number} now */
    patch(id, patch, now) {
      const cols = { status: "status", home: "home", rootPublic: "root_public", workspaceId: "workspace_id", aliases: "aliases", warnings: "warnings", name: "name", label: "label", displayName: "display_name" };
      const sets = [], args = [];
      for (const [k, v] of Object.entries(patch)) {
        const col = /** @type {any} */ (cols)[k];
        if (!col) continue;
        sets.push(`${col} = ?`);
        args.push(["home", "aliases", "warnings"].includes(k) ? JSON.stringify(v) : v ?? null);
      }
      sets.push("updated_at = ?"); args.push(now);
      db.prepare(`UPDATE spaces_space SET ${sets.join(", ")} WHERE id = ?`).run(...args, id);
    },
    delete: (/** @type {string} */ id) => db.prepare("DELETE FROM spaces_space WHERE id = ?").run(id),
  };
}

/**
 * When this device first saw each op of each identity list it verifies (seq -> ms), kept in the module's table so it survives a restart. A newcomer's age counts
 * from here (kernel/identity/chain.js seenAt), never from a time its adder wrote. Synchronous: the chain verifier asks for it in the middle of a check.
 * @param {any} db
 */
export function seenStore(db) {
  const read = (/** @type {string} */ id) => { const r = /** @type {any} */ (db.prepare("SELECT value FROM spaces_kv WHERE key = ?").get(`seen/${id}`)); return r ? parse(r.value) || {} : null; };
  return {
    has: (/** @type {string} */ id) => read(id) !== null,
    get: (/** @type {string} */ id, /** @type {number} */ seq) => { const m = read(id); return m && m[seq] !== undefined ? Number(m[seq]) : undefined; },
    mark: (/** @type {string} */ id, /** @type {number} */ seq, /** @type {number} */ ts) => {
      const m = read(id) || {};
      if (m[seq] !== undefined) return;
      m[seq] = ts;
      db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(`seen/${id}`, JSON.stringify(m));
    },
  };
}
