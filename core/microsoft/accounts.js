// @ts-check
// accounts (Microsoft 365): the Space's firm app, one row each in microsoft_accounts, and the work emails the owner attested for people. A row names a vault item (tenant_id, client_id,
// client_secret) and never a value. `base` points Graph at another origin, and only a loopback one: it exists for the test fakes.

export const MIGRATIONS = [
  `CREATE TABLE microsoft_accounts (name TEXT PRIMARY KEY, domain TEXT NOT NULL, auth TEXT NOT NULL, base TEXT, added INTEGER NOT NULL);`,
  `CREATE TABLE microsoft_member_emails (person TEXT PRIMARY KEY, email TEXT NOT NULL, by TEXT, at INTEGER NOT NULL);`,
];

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;

/** @param {any} v */
export function loopback(v) {
  try { const u = new URL(String(v)); return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) && u.pathname === "/" && !u.search && !u.username; } catch { return false; }
}

/** A problem with a new firm app, or null. @param {any} input */
export function check(input) {
  if (!NAME.test(String(input.name || ""))) return "name must be lowercase letters, digits and dashes, starting with a letter, at most 32";
  if (!DOMAIN.test(String(input.domain || ""))) return "domain is the firm's email domain, such as firm.com";
  if (!ITEM.test(String(input.item || ""))) return "item must name a vault item holding tenant_id, client_id and client_secret";
  if (input.base !== undefined && input.base !== null && !loopback(input.base)) return "base must be a loopback origin (it exists for test fakes)";
  return null;
}

/** @param {import("node:sqlite").DatabaseSync} db */
export function store(db) {
  const row = r => r && ({ name: String(r.name), domain: String(r.domain), firm: true, auth: JSON.parse(String(r.auth)), ...(r.base ? { base: String(r.base) } : {}), added: Number(r.added) });
  return {
    all: () => db.prepare("SELECT * FROM microsoft_accounts ORDER BY added, name").all().map(row),
    put(input, now) {
      db.prepare(`INSERT INTO microsoft_accounts (name, domain, auth, base, added) VALUES (?,?,?,?,?)
        ON CONFLICT(name) DO UPDATE SET domain = excluded.domain, auth = excluded.auth, base = excluded.base`)
        .run(input.name, String(input.domain).toLowerCase(), JSON.stringify({ type: "m365-app", item: input.item }), input.base ? new URL(input.base).origin : null, now);
      return row(db.prepare("SELECT * FROM microsoft_accounts WHERE name = ?").get(input.name));
    },
    remove: name => Number(db.prepare("DELETE FROM microsoft_accounts WHERE name = ?").run(String(name)).changes) > 0,
  };
}

/** The owner-attested work emails. @param {import("node:sqlite").DatabaseSync} db */
export function memberEmails(db) {
  return {
    get: person => { const r = /** @type {any} */ (db.prepare("SELECT person, email FROM microsoft_member_emails WHERE person = ?").get(String(person))); return r ? { id: String(r.person), email: String(r.email), verified: true } : null; },
    holder: email => { const r = /** @type {any} */ (db.prepare("SELECT person FROM microsoft_member_emails WHERE email = ?").get(String(email).toLowerCase())); return r ? String(r.person) : null; },
    all: () => db.prepare("SELECT person, email, by, at FROM microsoft_member_emails ORDER BY person").all().map(r => ({ person: String(r.person), email: String(r.email), ...(r.by ? { by: String(r.by) } : {}), at: Number(r.at) })),
    set: (person, email, by, now) => { db.prepare("INSERT INTO microsoft_member_emails (person, email, by, at) VALUES (?,?,?,?) ON CONFLICT(person) DO UPDATE SET email = excluded.email, by = excluded.by, at = excluded.at").run(String(person), String(email).toLowerCase(), by || null, now); },
    clear: person => Number(db.prepare("DELETE FROM microsoft_member_emails WHERE person = ?").run(String(person)).changes) > 0,
  };
}
