// @ts-check
// accounts: the Google accounts this vyred knows, one row each in google_accounts.
//
// A row names a vault item and how to use it, never a value (ADR 0015 decision 2): the service
// account's JSON or the OAuth env-set stays in the vault and is fetched at mint time under the
// google module's own grant. `base` points both APIs at another origin, and only at a loopback
// one: it exists for the test fakes, and an https base would be a way to hand tokens to any host.

export const MIGRATIONS = [
  `CREATE TABLE google_accounts (
     name TEXT PRIMARY KEY, email TEXT NOT NULL, auth TEXT NOT NULL, base TEXT, added INTEGER NOT NULL
   );`,
];

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A problem with a new account, or null. @param {any} input */
export function check(input) {
  if (!NAME.test(String(input.name || ""))) return "name must be lowercase letters, digits and dashes, starting with a letter, at most 32";
  if (!EMAIL.test(String(input.email || ""))) return "email must be the account's address";
  const a = input.auth;
  if (!a || typeof a !== "object") return "auth is required: { type: \"oauth\" | \"service-account\", item }";
  if (a.type !== "oauth" && a.type !== "service-account") return "auth.type must be oauth or service-account";
  if (!ITEM.test(String(a.item || ""))) return "auth.item must name a vault item";
  if (a.subject !== undefined && !EMAIL.test(String(a.subject))) return "auth.subject must be the address the service account acts as";
  if (a.type === "oauth" && a.subject !== undefined) return "auth.subject is for a service account; OAuth acts as whoever consented";
  if (input.base !== undefined && input.base !== null && !loopback(input.base)) return "base must be a loopback origin such as http://127.0.0.1:8080 (it exists for test fakes)";
  return null;
}

function loopback(base) {
  try {
    const u = new URL(String(base));
    return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.pathname === "/" && !u.search && !u.username;
  } catch { return false; }
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function store(db) {
  const row = r => r && ({ name: String(r.name), email: String(r.email), auth: JSON.parse(String(r.auth)),
    ...(r.base ? { base: String(r.base) } : {}), added: Number(r.added) });
  return {
    /** @returns {import("./api.js").Account[] & any[]} */
    all: () => db.prepare("SELECT * FROM google_accounts ORDER BY added, name").all().map(row),
    get: name => row(db.prepare("SELECT * FROM google_accounts WHERE name = ?").get(String(name))),
    put(input, now) {
      const a = input.auth;
      // A service account acts as a person; by default the one whose address the account is.
      const auth = a.type === "service-account" ? { type: a.type, item: a.item, subject: a.subject || input.email } : { type: a.type, item: a.item };
      const base = input.base ? new URL(input.base).origin : null;
      db.prepare(`INSERT INTO google_accounts (name, email, auth, base, added) VALUES (?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET email = excluded.email, auth = excluded.auth, base = excluded.base`)
        .run(input.name, input.email, JSON.stringify(auth), base, now);
      return this.get(input.name);
    },
    remove: name => Number(db.prepare("DELETE FROM google_accounts WHERE name = ?").run(String(name)).changes) > 0,
  };
}

/**
 * The accounts a read goes to: the one named, or every one.
 * @param {any[]} all @param {string} [name]
 */
export function forRead(all, name) {
  if (!all.length) throw Object.assign(new Error("no Google account is connected · add one with `vyre connect add google <name> --email <address> --item <vault item>`"), { code: "no_account" });
  if (name === undefined) return all;
  const one = all.find(a => a.name === name);
  if (!one) throw Object.assign(new Error(`no Google account named ${name}; the accounts are ${all.map(a => a.name).join(", ")}`), { code: "no_account" });
  return [one];
}

/**
 * The one account a write goes from: the one named, or the only one. Two and none named is a
 * question, never a guess: an invite from the wrong address is a mistake the person sees.
 * @param {any[]} all @param {string} [name]
 */
export function forWrite(all, name) {
  const list = forRead(all, name);
  if (list.length > 1) throw Object.assign(new Error(`say which account this goes from: ${list.map(a => a.name).join(", ")}`), { code: "ambiguous" });
  return list[0];
}
