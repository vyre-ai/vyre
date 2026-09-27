// @ts-check
// remind: Watchtower's findings become todos in the planner, once, so a person is told to change
// a password without opening the vault to look (ADR 0028, decision 4).
//
// One run a day, the first after 09:00 local, and never on a faster timer (principle 8). A run
// opens what it can: on a box, the personal vault is usually locked and those items wait for a
// day it is open. Each (item, reason) raises one todo, remembered in vault_reminders so it is
// never raised twice. More than five new at once become one todo that lists them, so the planner
// stays usable. A reason that has gone away (the password was changed, the PAT renewed) marks its
// todo done. A todo the person dismissed stays quiet until the reason changes. The planner is
// reached through ctx.call; without it nothing happens and Watchtower still shows the list.
//
// The breach check rides the same daily timer, at most once a week, and only when a person opted
// in (vault.breach: "ask" in config.json) - the same gate vault.breach.check asks presence for.
// A scheduled run asks nobody (there is nobody to ask): opting in in config is the person's
// standing answer, same as scheduleReminders itself running with no per-day approval.

import { judge, breachCheck, EXPIRING_MS } from "./health.js";

export const BREACH_EVERY_MS = 7 * 86400_000;

export const REMIND_MIGRATION = `CREATE TABLE IF NOT EXISTS vault_reminders (
   name TEXT NOT NULL, reason TEXT NOT NULL, planner TEXT, state TEXT NOT NULL DEFAULT 'open', at INTEGER NOT NULL,
   PRIMARY KEY (name, reason));
 CREATE TABLE IF NOT EXISTS vault_jobs (name TEXT PRIMARY KEY, at INTEGER NOT NULL);`;

/** Reasons worth a todo, and how soon. `weak`, `2fa-available` and `unprotected` stay on the Watchtower list. */
const REASONS = {
  expired: { days: 0, priority: 1, verb: "Renew" },
  breached: { days: 3, priority: 1, verb: "Change" },
  expiring: { days: null, priority: 2, verb: "Renew" },
  rotate: { days: 14, priority: 2, verb: "Change" },
  reused: { days: 14, priority: 2, verb: "Change" },
  old: { days: 14, priority: 3, verb: "Change" },
};
const WORD = { login: "password", pat: "token", "api-key": "key", oauth: "token", cloud: "key", "db-url": "database password",
  cert: "certificate", license: "licence", wifi: "Wi-Fi password", secret: "secret", "env-set": ".env values", authenticator: "code" };
const BATCH = 5;
const DAY = 86400_000;

const json = (v, d) => { try { return v == null ? d : JSON.parse(String(v)); } catch { return d; } };
const ymd = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/**
 * One run: judge what opens, raise new todos, close the ones whose reason went away.
 * @param {import("./vault.js").Vault} vault
 * @param {(tool: string, input: any) => Promise<{ data?: any, error?: { code: string, message: string } }>} call
 * @param {{ now?: number, breached?: string[] }} [opts] breached: names from the last breach check
 */
export async function remindRun(vault, call, { now = Date.now(), breached = [] } = {}) {
  const db = vault.db;
  await vault.key();
  const items = [];
  for (const r of /** @type {any[]} */ (db.prepare("SELECT * FROM vault_items ORDER BY name").all())) {
    if (!vault.rowOk("vault_items", r)) continue;
    let fields;
    // A locked personal vault is not an error here: its items wait for another day.
    try { fields = await vault.fields(r); } catch { continue; }
    items.push({ name: r.name, kind: r.kind, fields, url: r.url, hosts: json(r.hosts, []), updated: r.updated, rotate: r.rotate, details: json(r.details, {}) });
  }
  const judged = judge(items, { now, twofa: new Set() });
  const kinds = new Map(items.map(i => [i.name, i]));
  /** @type {Map<string, Set<string>>} */
  const flagged = new Map();
  for (const j of judged.items) flagged.set(j.name, new Set(j.reasons.filter(r => r in REASONS)));
  for (const n of breached) if (kinds.has(n)) (flagged.get(n) ?? flagged.set(n, new Set()).get(n))?.add("breached");

  // needs-credential and pass-expiring rows are keyed by connection or pass id, not an item
  // name; oneOffReminders owns them, on the same table, so they never collide with an item's.
  const marks = /** @type {any[]} */ (db.prepare("SELECT * FROM vault_reminders WHERE reason NOT IN ('needs-credential', 'pass-expiring')").all());
  const had = new Map(marks.map(m => [`${m.name}\n${m.reason}`, m]));
  const closed = [];
  // A reason gone away: its todo is done, and the mark goes, so it may be raised again later.
  for (const m of marks) {
    const opened = kinds.has(m.name);
    if (opened && flagged.get(m.name)?.has(m.reason)) continue;
    if (!opened && db.prepare("SELECT 1 FROM vault_items WHERE name = ?").get(m.name)) continue; // locked today, not fixed
    if (m.planner && m.state === "open") {
      const others = marks.filter(x => x.planner === m.planner && !(x.name === m.name && x.reason === m.reason));
      if (!others.length) await call("planner.done", { item: m.planner });
    }
    db.prepare("DELETE FROM vault_reminders WHERE name = ? AND reason = ?").run(m.name, m.reason);
    closed.push(`${m.name}:${m.reason}`);
  }

  // A dismissed todo keeps its mark, so it is not raised again for the same reason.
  for (const m of marks) {
    if (m.state !== "open" || !m.planner || !flagged.get(m.name)?.has(m.reason)) continue;
    const g = await call("planner.get", { item: m.planner });
    const st = g.data && g.data.item && g.data.item.state;
    if (st === "cancelled") db.prepare("UPDATE vault_reminders SET state = 'dismissed' WHERE name = ? AND reason = ?").run(m.name, m.reason);
    else if (st === "done") db.prepare("UPDATE vault_reminders SET state = 'done' WHERE name = ? AND reason = ?").run(m.name, m.reason);
  }

  /** @type {{ name: string, reason: string, kind: string, expires?: number }[]} */
  const fresh = [];
  for (const [name, reasons] of flagged) for (const reason of reasons) {
    if (had.has(`${name}\n${reason}`)) continue;
    const it = kinds.get(name);
    fresh.push({ name, reason, kind: it?.kind ?? "item", expires: it?.details?.expires });
  }
  // Worst first, so a batch keeps the most urgent reason as its own todo.
  fresh.sort((a, b) => REASONS[a.reason].priority - REASONS[b.reason].priority || a.name.localeCompare(b.name));
  const added = [];
  const mark = db.prepare("INSERT OR REPLACE INTO vault_reminders (name, reason, planner, state, at) VALUES (?,?,?,'open',?)");
  /** @param {any} input @param {{ name: string, reason: string }[]} covers */
  const add = async (input, covers) => {
    const r = await call("planner.add", { kind: "todo", list: "Vault", ...input });
    if (r.error) return r.error.code === "no_such_tool" ? "no-planner" : "failed";
    const id = r.data && (r.data.id || (r.data.item && r.data.item.id));
    for (const c of covers) mark.run(c.name, c.reason, id ? String(id) : null, now);
    added.push(...covers.map(c => `${c.name}:${c.reason}`));
    return "ok";
  };
  /** @type {Map<string, typeof fresh>} */
  const byReason = new Map();
  for (const f of fresh) (byReason.get(f.reason) ?? byReason.set(f.reason, []).get(f.reason))?.push(f);
  for (const [reason, list] of byReason) {
    const R = REASONS[/** @type {keyof typeof REASONS} */ (reason)];
    const due = d => ymd(now + d * DAY);
    if (list.length > BATCH) {
      const s = await add({ title: `${R.verb} ${list.length} ${reason === "expired" || reason === "expiring" ? "credentials" : "passwords"}: ${reason}`,
        body: list.map(f => f.name).join("\n"), tags: ["vault", "rotate", reason], priority: R.priority, due: due(R.days ?? 7) }, list);
      if (s === "no-planner") return { added, closed, planner: false };
      continue;
    }
    for (const f of list) {
      const what = WORD[/** @type {keyof typeof WORD} */ (f.kind)] || "credential";
      const when = f.expires ? ` (${reason === "expired" ? "ended" : "ends"} ${ymd(f.expires)})` : "";
      const dueDay = reason === "expiring" && f.expires ? ymd(Math.max(now, f.expires - DAY)) : due(R.days ?? 14);
      const s = await add({ title: `${R.verb} the ${what} for ${f.name}${when}`, tags: ["vault", "rotate", reason], priority: R.priority, due: dueDay }, [f]);
      if (s === "no-planner") return { added, closed, planner: false };
    }
  }
  db.prepare("INSERT OR REPLACE INTO vault_jobs (name, at) VALUES ('remind', ?)").run(now);
  return { added, closed, planner: true };
}

/**
 * When the next run is due: the first 09:00 local after the last run, or in a minute when that
 * time has already passed (vyred was off at nine).
 * @param {number|null} last @param {number} now
 */
export function nextRun(last, now) {
  /** The first 09:00 local strictly after t. @param {number} t */
  const after = t => { const x = new Date(t); x.setHours(9, 0, 0, 0); if (x.getTime() <= t) x.setDate(x.getDate() + 1); return x.getTime(); };
  // Never run: today's 09:00, or soon when that has passed.
  const due = last == null ? new Date(now).setHours(9, 0, 0, 0) : after(last);
  return due <= now ? now + 60_000 : due;
}

/**
 * The daily timer. One setTimeout at a time; it re-arms after each run. `stop` clears it.
 * @param {import("./vault.js").Vault} vault
 * @param {(tool: string, input: any) => Promise<any>} call
 * @param {{ log?: (m: string) => void, clock?: () => number, local?: boolean }} [opts] local: a Mac, which
 *   leaves reminders to its box when it is paired with one, so a person is not told twice
 */
/**
 * Every login's password against known breaches, k-anonymously. Same shape vault.breach.check
 * uses; this is the version a scheduled run makes, with no person there to see it happen.
 * @param {import("./vault.js").Vault} vault @param {{ fetch: typeof globalThis.fetch }} deps
 * @returns {Promise<string[]>} names
 */
async function scheduledBreachCheck(vault, { fetch }) {
  const rows = /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_items WHERE kind = 'login' ORDER BY name").all());
  const entries = [];
  for (const r of rows) {
    if (!vault.rowOk("vault_items", r)) continue;
    try { const f = await vault.fields(r); if (f.password) entries.push({ name: r.name, password: f.password }); } catch {}
  }
  return (await breachCheck(entries, { fetch })).breached;
}

const lastBreach = vault => { const r = /** @type {any} */ (vault.db.prepare("SELECT at FROM vault_jobs WHERE name = 'breach'").get()); return r ? Number(r.at) : null; };

/**
 * A reminder outside Watchtower's own item-by-item rules: one todo per key while `byKey` names
 * it, keyed `<reason>:<...>` in vault_reminders (shared with remindRun, which only ever touches
 * its own REASONS-listed rows), closed the moment a key drops out, quiet once dismissed. Both
 * needs-credential connections and expiring passes are one of these; only what is being watched
 * and how its todo reads differ.
 * @param {import("./vault.js").Vault} vault @param {(tool: string, input: any) => Promise<any>} call
 * @param {string} reason @param {Map<string, any>} byKey @param {(row: any) => string} titleOf
 * @param {{ tags: string[], priority: number, due: number }} todo @param {number} now
 */
async function oneOffReminders(vault, call, reason, byKey, titleOf, todo, now) {
  const marks = /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_reminders WHERE reason = ?").all(reason));
  const had = new Map(marks.map(m => [m.name, m]));
  const closed = [];
  for (const m of marks) {
    if (byKey.has(m.name)) continue;
    if (m.planner && m.state === "open") await call("planner.done", { item: m.planner }).catch(() => {});
    vault.db.prepare("DELETE FROM vault_reminders WHERE name = ? AND reason = ?").run(m.name, reason);
    closed.push(m.name);
  }
  for (const m of marks) {
    if (m.state !== "open" || !m.planner || !byKey.has(m.name)) continue;
    const g = await call("planner.get", { item: m.planner });
    const st = g.data && g.data.item && g.data.item.state;
    if (st === "cancelled") vault.db.prepare("UPDATE vault_reminders SET state = 'dismissed' WHERE name = ? AND reason = ?").run(m.name, reason);
    else if (st === "done") vault.db.prepare("UPDATE vault_reminders SET state = 'done' WHERE name = ? AND reason = ?").run(m.name, reason);
  }
  const added = [];
  for (const [key, row] of byKey) {
    if (had.has(key)) continue;
    const r = await call("planner.add", { kind: "todo", list: "Vault", title: titleOf(row), tags: todo.tags, priority: todo.priority, due: ymd(now + todo.due) });
    if (r.error) return { added, closed, planner: r.error.code !== "no_such_tool" };
    const id = r.data && (r.data.id || (r.data.item && r.data.item.id));
    vault.db.prepare("INSERT OR REPLACE INTO vault_reminders (name, reason, planner, state, at) VALUES (?, ?, ?, 'open', ?)").run(key, reason, id ? String(id) : null, now);
    added.push(key);
  }
  return { added, closed, planner: true };
}

/**
 * A connection stuck at needs_credential (a module registered one, but nothing has filled it
 * yet) gets one todo, keyed `connection:<id>`, closed the moment it becomes ready.
 * @param {import("./vault.js").Vault} vault @param {(tool: string, input: any) => Promise<any>} call
 * @param {import("./connections.js").Connections} connections @param {number} now
 */
async function needsCredentialReminders(vault, call, connections, now) {
  const rows = (await connections.list({}, "cli")).connections.filter(r => r.state === "needs_credential");
  const byKey = new Map(rows.map(r => [`connection:${r.id}`, r]));
  const titleOf = row => { const need = row.needs && row.needs[0]; return need ? `Connect ${row.label}: ${need.module} needs its ${need.need}` : `Connect ${row.label}`; };
  return oneOffReminders(vault, call, "needs-credential", byKey, titleOf, { tags: ["vault", "connection"], priority: 3, due: 14 * DAY }, now);
}

/**
 * A share pass within EXPIRING_MS of its end gets one heads-up, keyed `pass:<id>`, before an
 * agent's (or a person's) access to it lapses mid-task. Closed once it is renewed, revoked, or
 * finally expires (it then drops out of activePasses on its own).
 * @param {import("./vault.js").Vault} vault @param {(tool: string, input: any) => Promise<any>} call @param {number} now
 */
async function expiringPassReminders(vault, call, now) {
  const passes = vault.activePasses().filter(p => p.expires && p.expires - now <= EXPIRING_MS);
  const byKey = new Map(passes.map(p => [`pass:${p.id}`, p]));
  const titleOf = p => `Renew or revoke the pass for ${p.holder}: it ends ${ymd(p.expires)} (${p.items.length === 1 ? p.items[0] : `${p.items.length} items`})`;
  return oneOffReminders(vault, call, "pass-expiring", byKey, titleOf, { tags: ["vault", "pass"], priority: 2, due: EXPIRING_MS }, now);
}

/**
 * One tick: the opted-in weekly breach check (if due), needs-credential connections, then the
 * daily reminder run. Split out of scheduleReminders so a test can call it without waiting on a
 * real timer.
 * @param {import("./vault.js").Vault} vault @param {(tool: string, input: any) => Promise<any>} call
 * @param {{ log?: (m: string) => void, clock?: () => number, local?: boolean,
 *   breach?: { enabled: boolean, fetch: typeof globalThis.fetch, everyMs?: number },
 *   connections?: import("./connections.js").Connections }} [opts] local: a Mac, which leaves
 *   reminders to its box when it is paired with one, so a person is not told twice. breach:
 *   opted in (vault.breach: "ask") runs the check at most once a week, folded into the same
 *   daily timer rather than a second one (principle 8).
 */
export async function remindTick(vault, call, { log = () => {}, clock = Date.now, local = false, breach, connections } = {}) {
  const paired = local && Boolean((await call("link.status", {}))?.data?.linked);
  let breached = [];
  if (!paired && breach && breach.enabled) {
    const due = clock() - (lastBreach(vault) ?? -Infinity) >= (breach.everyMs || BREACH_EVERY_MS);
    if (due) {
      try {
        breached = await scheduledBreachCheck(vault, { fetch: breach.fetch });
        vault.db.prepare("INSERT OR REPLACE INTO vault_jobs (name, at) VALUES ('breach', ?)").run(clock());
      } catch (e) { log(`vault: breach check skipped this week (${/** @type {Error} */ (e).message})`); }
    }
  }
  const now = clock();
  let needsCred = { added: [], closed: [] };
  if (!paired && connections) {
    try { needsCred = await needsCredentialReminders(vault, call, connections, now); }
    catch (e) { log(`vault: connection reminders skipped today (${/** @type {Error} */ (e).message})`); }
  }
  let expiring = { added: [], closed: [] };
  if (!paired) {
    try { expiring = await expiringPassReminders(vault, call, now); }
    catch (e) { log(`vault: pass reminders skipped today (${/** @type {Error} */ (e).message})`); }
  }
  const r = paired ? { added: [], closed: [] } : await remindRun(vault, call, { now, breached });
  const added = [...r.added, ...needsCred.added, ...expiring.added], closed = [...r.closed, ...needsCred.closed, ...expiring.closed];
  if (added.length || closed.length) log(`vault: ${added.length} reminders added, ${closed.length} closed`);
  return { added, closed, breached };
}

/**
 * @param {import("./vault.js").Vault} vault
 * @param {(tool: string, input: any) => Promise<any>} call
 * @param {{ log?: (m: string) => void, clock?: () => number, local?: boolean,
 *   breach?: { enabled: boolean, fetch: typeof globalThis.fetch, everyMs?: number } }} [opts]
 */
export function scheduleReminders(vault, call, opts = {}) {
  const { clock = Date.now } = opts;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let stopped = false;
  const lastRun = () => { const r = /** @type {any} */ (vault.db.prepare("SELECT at FROM vault_jobs WHERE name = 'remind'").get()); return r ? Number(r.at) : null; };
  const arm = () => {
    if (stopped) return;
    const wait = Math.max(60_000, nextRun(lastRun(), clock()) - clock());
    timer = setTimeout(async () => {
      try { await remindTick(vault, call, opts); }
      catch (e) { (opts.log || (() => {}))(`vault: reminders skipped today (${/** @type {Error} */ (e).message})`); }
      arm();
    }, Math.min(wait, 2 ** 31 - 1));
    timer.unref?.();
  };
  arm();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
}

/**
 * An item was changed on purpose (rotated): its open reminders are done now, not tomorrow.
 * @param {import("./vault.js").Vault} vault @param {(tool: string, input: any) => Promise<any>} call @param {string} name
 */
export async function settle(vault, call, name) {
  const marks = /** @type {any[]} */ (vault.db.prepare("SELECT * FROM vault_reminders WHERE name = ?").all(name));
  for (const m of marks) {
    const shared = vault.db.prepare("SELECT COUNT(*) AS n FROM vault_reminders WHERE planner = ? AND name != ?").get(m.planner, name);
    if (m.planner && m.state === "open" && !/** @type {any} */ (shared).n) await call("planner.done", { item: m.planner });
  }
  vault.db.prepare("DELETE FROM vault_reminders WHERE name = ? AND reason != 'reused'").run(name);
}
