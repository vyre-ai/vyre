// @ts-check
// accounts: the GitHub accounts this vyred knows, one row each in github_accounts.
//
// A row names a vault item and never a value (ADR 0016 decision 2, ADR 0041): the token stays in
// the vault and is fetched at call time under the github module's own grant.

export const MIGRATIONS = [
  `CREATE TABLE github_accounts (
     name TEXT PRIMARY KEY, login TEXT NOT NULL, avatar_url TEXT, item TEXT NOT NULL, added INTEGER NOT NULL
   );`,
  `CREATE TABLE github_projects (
     project TEXT PRIMARY KEY, account TEXT NOT NULL, full_name TEXT NOT NULL, default_branch TEXT NOT NULL,
     home TEXT NOT NULL, added INTEGER NOT NULL
   );`,
  // What a session's commits say about who made them: GitHub's own numeric id (for the noreply
  // address), the display name and the public email, when GitHub shows one.
  `ALTER TABLE github_accounts ADD COLUMN user_id INTEGER;
   ALTER TABLE github_accounts ADD COLUMN display_name TEXT;
   ALTER TABLE github_accounts ADD COLUMN email TEXT;`,
];

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** @param {import("node:sqlite").DatabaseSync} db */
export function store(db) {
  const row = r => r && ({ name: String(r.name), login: String(r.login), avatar_url: r.avatar_url ? String(r.avatar_url) : null, item: String(r.item), added: Number(r.added), user_id: r.user_id ? Number(r.user_id) : null, display_name: r.display_name ? String(r.display_name) : null, email: r.email ? String(r.email) : null });
  return {
    all: () => /** @type {any[]} */ (db.prepare("SELECT * FROM github_accounts ORDER BY added, name").all()).map(row),
    get: name => row(db.prepare("SELECT * FROM github_accounts WHERE name = ?").get(String(name))),
    put({ name, login, avatar_url, item, user_id, display_name, email }, now) {
      if (!NAME.test(String(name || ""))) throw Object.assign(new Error("name must be lowercase letters, digits and dashes, starting with a letter, at most 32"), { code: "bad_input" });
      if (!ITEM.test(String(item || ""))) throw Object.assign(new Error("item must name a vault item"), { code: "bad_input" });
      const uid = Number.isInteger(user_id) && user_id > 0 ? user_id : null;
      db.prepare(`INSERT INTO github_accounts (name, login, avatar_url, item, added, user_id, display_name, email) VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET login = excluded.login, avatar_url = excluded.avatar_url, item = excluded.item,
          user_id = COALESCE(excluded.user_id, github_accounts.user_id), display_name = COALESCE(excluded.display_name, github_accounts.display_name),
          email = COALESCE(excluded.email, github_accounts.email)`)
        .run(name, login, avatar_url || null, item, now, uid, display_name || null, email || null);
      return this.get(name);
    },
    remove: name => Number(db.prepare("DELETE FROM github_accounts WHERE name = ?").run(String(name)).changes) > 0,
  };
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function projectStore(db) {
  const row = r => r && ({ project: String(r.project), account: String(r.account), full_name: String(r.full_name), default_branch: String(r.default_branch), home: String(r.home), added: Number(r.added) });
  return {
    get: project => row(db.prepare("SELECT * FROM github_projects WHERE project = ?").get(String(project))),
    put({ project, account, full_name, default_branch, home }, now) {
      db.prepare(`INSERT INTO github_projects (project, account, full_name, default_branch, home, added) VALUES (?,?,?,?,?,?)
        ON CONFLICT(project) DO UPDATE SET account = excluded.account, full_name = excluded.full_name, default_branch = excluded.default_branch, home = excluded.home`)
        .run(project, account, full_name, default_branch, home, now);
      return this.get(project);
    },
    remove: project => Number(db.prepare("DELETE FROM github_projects WHERE project = ?").run(String(project)).changes) > 0,
  };
}

/**
 * The one account a call goes through: the one named, or the only one. Two and none named is a
 * question, never a guess.
 * @param {any[]} all @param {string} [name]
 */
export function forOne(all, name) {
  if (!all.length) throw Object.assign(new Error("no GitHub account is connected · connect one with github.connect"), { code: "no_account" });
  if (name === undefined) {
    if (all.length > 1) throw Object.assign(new Error(`say which account: ${all.map(a => a.name).join(", ")}`), { code: "ambiguous" });
    return all[0];
  }
  const one = all.find(a => a.name === name);
  if (!one) throw Object.assign(new Error(`no GitHub account named ${name}; the accounts are ${all.map(a => a.name).join(", ")}`), { code: "no_account" });
  return one;
}

/**
 * The name and email a session commits as: the account's own, never a guessed address. A public
 * email is used when GitHub shows one; otherwise GitHub's <id>+<login> noreply address, which
 * needs the numeric id. With no id known there is no identity to set.
 * @param {{ login: string, user_id?: number | null, display_name?: string | null, email?: string | null }} acct
 * @returns {{ name: string, email: string } | null}
 */
export function commitIdentity(acct) {
  if (!acct || !acct.login) return null;
  const email = acct.email || (acct.user_id ? `${acct.user_id}+${acct.login}@users.noreply.github.com` : null);
  return email ? { name: acct.display_name || acct.login, email } : null;
}
