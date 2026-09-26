// @ts-check
// runtime — schedules, runs and files watchers. The module's tools are thin wrappers over this.
//
// A watcher's life: Claude writes its folder (a draft), watchers.test dry-runs it, and
// watchers.create turns on exactly what was dry-run (the hash of both files is recorded). From
// then on the runtime owns it: it runs on the schedule, keeps the `since` cursor, files each new
// item once into the project and teaches it to Memory, retries a failure with backoff, and after
// three failures in a row pauses it and says so. An edit to the folder pauses it too, until it is
// dry-run and created again.
//
// Time comes from `now()` and runs are started by `tick()`, so tests drive the clock by hand.

import crypto from "node:crypto";
import * as cron from "./cron.js";
import * as folder from "./folder.js";
import { runOnce, normalize } from "./run.js";

/** Waits before the first and second retry. The third failure in a row pauses the watcher. */
export const BACKOFF_MS = [30_000, 120_000];
export const MAX_FAILURES = 3;

export const MIGRATIONS = [`
  CREATE TABLE watchers_watchers (
    name TEXT PRIMARY KEY,
    project TEXT,
    schedule TEXT,
    hash TEXT,                 -- what watchers.create turned on
    tested_hash TEXT,          -- what the last successful dry run ran
    tested_at INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 0,
    paused_why TEXT,
    since TEXT,                -- JSON: the cursor handed to the next run
    next_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0,
    last_run INTEGER,
    last_ok INTEGER,
    last_error TEXT,
    token TEXT,                -- the webhook's secret, for schedule "webhook"
    created_at INTEGER
  );
  CREATE TABLE watchers_items (
    watcher TEXT NOT NULL,
    id TEXT NOT NULL,
    project TEXT,
    kind TEXT,
    at INTEGER,
    title TEXT,
    url TEXT,
    data TEXT NOT NULL,
    filed_at INTEGER NOT NULL,
    PRIMARY KEY (watcher, id)
  );
  CREATE INDEX watchers_items_project ON watchers_items(project, filed_at);
  CREATE TABLE watchers_runs (
    id INTEGER PRIMARY KEY,
    watcher TEXT NOT NULL,
    at INTEGER NOT NULL,
    ms INTEGER,
    trigger TEXT,              -- schedule, retry, create, hook, test
    ok INTEGER NOT NULL,
    items INTEGER NOT NULL DEFAULT 0,
    filed INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    logs TEXT
  );
  CREATE INDEX watchers_runs_watcher ON watchers_runs(watcher, id);
`];

/**
 * @typedef {{ db: import("node:sqlite").DatabaseSync, dir: string,
 *   emit: (type: string, payload: object, where?: object) => any,
 *   call: (tool: string, input: object) => Promise<{ data?: any, error?: any }>,
 *   fetch: (name: string) => Promise<string>,
 *   teach: (kind: string, fact: object) => Promise<boolean>,
 *   log: (msg: string) => void, now?: () => number }} Deps
 */

export class Runtime {
  /** @param {Deps} deps */
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    this.db = deps.db;
    /** @type {Map<string, Promise<any>>} runs in flight, one per watcher */
    this.running = new Map();
    /** @type {Map<string, any[]>} webhook bodies that arrived during a run */
    this.queued = new Map();
    this.stopping = false;
    this.abort = new AbortController();
  }

  row(name) { return /** @type {any} */ (this.db.prepare("SELECT * FROM watchers_watchers WHERE name = ?").get(name)); }

  /** The watcher's folder, checked. Throws with every problem when it is not valid. */
  spec(name) {
    const f = folder.read(this.d.dir, name);
    if (f.problems.length) throw new Error(f.problems.join("; "));
    return /** @type {{ dir: string, spec: folder.Spec, hash: string }} */ (f);
  }

  /** The project a watcher files into, with its folders (what Memory scopes facts by). */
  async project(ref) {
    const r = await this.d.call("projects.list", {});
    if (r.error) return null;
    const list = r.data?.projects || [];
    const p = list.find(x => x.slug === ref) || list.find(x => String(x.name).toLowerCase() === String(ref).toLowerCase());
    return p ? { slug: p.slug, name: p.name, folders: p.workspaces?.length ? p.workspaces : [p.home] } : null;
  }

  // ------------------------------------------------------------------ tools

  /** Every watcher: on disk, turned on, or both. */
  list() {
    const rows = new Map(this.db.prepare("SELECT * FROM watchers_watchers").all().map(r => [String(r.name), /** @type {any} */ (r)]));
    const count = this.db.prepare("SELECT COUNT(*) n FROM watchers_items WHERE watcher = ?");
    const out = [];
    for (const name of new Set([...folder.names(this.d.dir), ...rows.keys()])) {
      const f = folder.read(this.d.dir, name), r = rows.get(name);
      if (!f.hash && !(r && r.enabled)) continue;   // a dry-run draft whose folder was deleted
      const on = r && r.enabled;
      const state = !f.hash && on ? "missing" : f.problems.length ? "invalid" : !on ? "draft"
        : f.hash !== r.hash ? "changed" : r.paused ? "paused" : "on";
      const schedule = f.spec?.schedule || r?.schedule || null;
      out.push({ name, state, project: f.spec?.project || r?.project || null, schedule, every: schedule ? cron.describe(schedule) : null,
        next: on && !r.paused && r.next_at ? new Date(r.next_at).toISOString() : null,
        lastRun: r?.last_run ? new Date(r.last_run).toISOString() : null, lastError: r?.last_error || null, failures: r?.failures || 0,
        pausedWhy: r?.paused ? r.paused_why : null, items: Number(count.get(name)?.n || 0), problems: f.problems });
    }
    return { dir: this.d.dir, watchers: out.sort((a, b) => a.name.localeCompare(b.name)) };
  }

  /**
   * The dry run: once, from `since` (null by default), filing nothing. A success records the
   * folder's hash, which is what watchers.create will agree to turn on.
   */
  async test(name, { since = null } = {}) {
    const f = folder.read(this.d.dir, name);
    if (f.problems.length) return { ok: false, name, problems: f.problems, dir: f.dir };
    const spec = /** @type {folder.Spec} */ (f.spec);
    const res = await this.exec(f.dir, spec, since, null);
    this.record(name, "test", res, res.items.length, 0);
    if (res.error) return { ok: false, name, error: res.error, logs: res.logs, ms: res.ms };
    const now = this.now();
    this.db.prepare(`INSERT INTO watchers_watchers (name, project, schedule, tested_hash, tested_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET tested_hash = excluded.tested_hash, tested_at = excluded.tested_at`).run(name, spec.project, spec.schedule, f.hash, now);
    const filed = this.db.prepare("SELECT 1 FROM watchers_items WHERE watcher = ? AND id = ?");
    const project = await this.project(spec.project);
    return {
      ok: true, name, project: project ? project.slug : null,
      ...(project ? {} : { warning: `no project "${spec.project}"; watchers.create will refuse until it exists (vyre projects lists them)` }),
      schedule: spec.schedule, every: cron.describe(spec.schedule), needs: spec.needs, count: res.items.length,
      alreadyFiled: res.items.filter(i => filed.get(name, i.id)).length,
      items: res.items.slice(0, 20), logs: res.logs.slice(-20), ms: res.ms, sandboxed: res.sandboxed,
      ...(res.items.length ? {} : { note: "no items. That can be right (nothing new matches), or the filter or the parsing is wrong; the logs show what it saw" }),
    };
  }

  /** Turn on what was dry-run. A scheduled watcher runs once straight away, then on its schedule. */
  async create(name) {
    const { spec, hash } = this.spec(name);
    const r = this.row(name);
    if (!r || r.tested_hash !== hash) throw new Error(`${name} has ${r && r.tested_hash ? "changed since its last dry run" : "not been dry-run"}; run watchers.test, show the user its items, then create it`);
    const project = await this.project(spec.project);
    if (!project) throw new Error(`no project "${spec.project}"; vyre projects lists them, and the watcher's project must be one of their slugs`);
    const now = this.now();
    const hook = spec.schedule === "webhook";
    const token = hook ? r.token || crypto.randomBytes(24).toString("base64url") : null;
    // Turning on again after an edit keeps the cursor, so it carries on from where it was.
    this.db.prepare(`UPDATE watchers_watchers SET project = ?, schedule = ?, hash = ?, enabled = 1, paused = 0, paused_why = NULL,
      failures = 0, last_error = NULL, token = ?, next_at = ?, created_at = COALESCE(created_at, ?) WHERE name = ?`)
      .run(project.slug, spec.schedule, hash, token, hook ? null : now, now, name);
    this.d.emit("watcher.created", { name, project: project.slug, schedule: spec.schedule }, { project: project.slug });
    if (!hook) this.kick(name, "create");
    return { name, project: project.slug, schedule: spec.schedule, every: cron.describe(spec.schedule), state: "on",
      ...(hook ? { hook: { method: "POST", path: `/v1/watchers/${name}/hook`, header: "x-vyre-token", token } } : {}) };
  }

  pause(name, why = "paused by the user") {
    const r = this.row(name);
    if (!r || !r.enabled) throw new Error(`${name} is not turned on`);
    if (r.paused) return { name, state: "paused", why: r.paused_why };
    this.db.prepare("UPDATE watchers_watchers SET paused = 1, paused_why = ? WHERE name = ?").run(why, name);
    this.d.emit("watcher.paused", { name, why }, { project: r.project });
    return { name, state: "paused", why };
  }

  resume(name) {
    const r = this.row(name);
    if (!r || !r.enabled) throw new Error(`${name} is not turned on; dry-run it with watchers.test, then watchers.create`);
    const { hash } = this.spec(name);
    if (hash !== r.hash) throw new Error(`${name} changed since it was turned on; run watchers.test and watchers.create again`);
    const next = r.schedule === "webhook" ? null : cron.next(cron.parse(r.schedule), this.now());
    this.db.prepare("UPDATE watchers_watchers SET paused = 0, paused_why = NULL, failures = 0, next_at = ? WHERE name = ?").run(next, name);
    this.d.emit("watcher.resumed", { name }, { project: r.project });
    return { name, state: "on", next: next ? new Date(next).toISOString() : null };
  }

  logs(name, limit = 10) {
    return this.db.prepare("SELECT * FROM watchers_runs WHERE watcher = ? ORDER BY id DESC LIMIT ?").all(name, limit).map(r => ({
      at: new Date(Number(r.at)).toISOString(), trigger: r.trigger, ok: Boolean(r.ok), ms: r.ms, items: r.items, filed: r.filed,
      error: r.error, logs: JSON.parse(String(r.logs || "[]")),
    }));
  }

  items({ name, project, limit = 50 } = {}) {
    const where = name ? "watcher = ?" : project ? "project = ?" : "1 = 1";
    const args = name ? [name] : project ? [project] : [];
    return this.db.prepare(`SELECT * FROM watchers_items WHERE ${where} ORDER BY filed_at DESC, COALESCE(at, 0) DESC LIMIT ?`).all(...args, limit)
      .map(r => ({ ...JSON.parse(String(r.data)), watcher: r.watcher, project: r.project, kind: r.kind, filed: new Date(Number(r.filed_at)).toISOString() }));
  }

  /** A webhook call. The token is checked in constant time; the body reaches the watcher as `hook`. */
  async hook(name, token, body) {
    const r = this.row(name);
    const want = Buffer.from(String(r?.token || "")), got = Buffer.from(String(token || ""));
    if (!r || !r.enabled || r.schedule !== "webhook" || !r.token || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      throw new Error("no such webhook, or the wrong token");
    }
    if (r.paused) throw new Error(`${name} is paused`);
    this.kick(name, "hook", body ?? null);
    return { accepted: true };
  }

  // ------------------------------------------------------------------ scheduling

  /** Start every watcher that is due. Returns the runs it started, for tests to await. */
  tick() {
    if (this.stopping) return [];
    const now = this.now();
    const due = this.db.prepare(`SELECT name FROM watchers_watchers WHERE enabled = 1 AND paused = 0
      AND next_at IS NOT NULL AND next_at <= ?`).all(now);
    return due.map(r => this.kick(String(r.name), "schedule")).filter(Boolean);
  }

  /**
   * Run a watcher now unless it is already running. A schedule that comes round mid-run is
   * skipped; a webhook call mid-run is queued, because its body is the item and must not be lost.
   */
  kick(name, trigger, hook = null) {
    if (this.stopping) return null;
    if (this.running.has(name)) {
      if (trigger === "hook") { const q = this.queued.get(name) || []; q.push(hook); this.queued.set(name, q); }
      return this.running.get(name) || null;
    }
    const p = (async () => {
      await this.fire(name, trigger, hook).catch(e => this.d.log(`${name}: ${e.message}`));
      for (let q = this.queued.get(name); q && q.length && !this.stopping; q = this.queued.get(name)) {
        await this.fire(name, "hook", q.shift()).catch(e => this.d.log(`${name}: ${e.message}`));
      }
      this.queued.delete(name);
    })().finally(() => this.running.delete(name));
    this.running.set(name, p);
    return p;
  }

  /** Wait for every run in flight. */
  async settle() { while (this.running.size) await Promise.all([...this.running.values()]); }

  /** One real run: fetch, file, teach, move the cursor on, or count a failure. */
  async fire(name, trigger, hook) {
    const r = this.row(name);
    if (!r || !r.enabled || r.paused) return;
    const started = this.now();
    if (trigger === "schedule" && r.failures) trigger = "retry";
    const f = folder.read(this.d.dir, name);
    if (f.problems.length || f.hash !== r.hash) {
      // Not a transient failure, so no retries: an edited or broken folder waits for the user.
      const why = f.problems.length ? `its folder is not valid: ${f.problems.join("; ")}` : "watch.js or watcher.json changed since it was turned on; run watchers.test and watchers.create again";
      this.record(name, trigger, { error: why, logs: [], ms: 0 }, 0, 0);
      this.db.prepare("UPDATE watchers_watchers SET last_run = ?, last_error = ? WHERE name = ?").run(started, why, name);
      this.pause(name, why);
      return;
    }
    const spec = /** @type {folder.Spec} */ (f.spec);
    let since = null;
    try { since = r.since == null ? null : JSON.parse(String(r.since)); } catch {}
    const res = await this.exec(f.dir, spec, since, hook);
    if (this.stopping) return;                     // cut short by stop(): not the watcher's failure
    if (res.error) return this.failed(name, r, trigger, res, started);

    const project = await this.project(r.project);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO watchers_items (watcher, id, project, kind, at, title, url, data, filed_at)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const fresh = [];
    for (const item of res.items) {
      const url = typeof item.url === "string" ? item.url.slice(0, 1000) : null;
      const done = insert.run(name, item.id, r.project, spec.emits, item.at, item.title, url, JSON.stringify(item), this.now());
      if (done.changes) fresh.push(item);
    }
    // Taught only with the project's folders. Without them a fact would belong everywhere,
    // and one client's items must never reach another project.
    if (project) {
      for (const item of fresh) {
        await this.d.teach("watcher.item", {
          subject: { name: typeof item.about === "string" && item.about.trim() ? item.about.trim().slice(0, 120) : name },
          text: [item.title || String(item.id), item.url].filter(Boolean).join(" · ").slice(0, 400),
          at: item.at || undefined, key: `${name}/${item.id}`, project_cwds: project.folders,
        }).catch(() => false);
      }
    } else if (fresh.length) this.d.log(`${name}: project ${r.project} is gone, so ${fresh.length} items were filed but not taught to Memory`);

    const cursor = res.cursor ?? started;
    const next = r.schedule === "webhook" ? null : cron.next(cron.parse(r.schedule), this.now());
    this.db.prepare(`UPDATE watchers_watchers SET since = ?, failures = 0, last_run = ?, last_ok = ?, last_error = NULL, next_at = ? WHERE name = ?`)
      .run(JSON.stringify(cursor), started, started, next, name);
    this.record(name, trigger, res, res.items.length, fresh.length);
    this.d.emit("watcher.fired", { name, items: fresh.length, seen: res.items.length, trigger }, { project: r.project });
  }

  failed(name, r, trigger, res, started) {
    const failures = Number(r.failures || 0) + 1;
    const pause = failures >= MAX_FAILURES;
    const next = pause ? null : this.now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    this.db.prepare("UPDATE watchers_watchers SET failures = ?, last_run = ?, last_error = ?, next_at = ? WHERE name = ?").run(failures, started, res.error, next, name);
    this.record(name, trigger, res, 0, 0);
    this.d.emit("watcher.failed", { name, error: res.error.slice(0, 300), failures, paused: pause }, { project: r.project });
    if (pause) this.pause(name, `failed ${failures} times in a row: ${res.error.slice(0, 200)}`);
  }

  /** Run in a child and check the items; a bad item is the run's error. */
  async exec(dir, spec, since, hook) {
    const res = await runOnce({ dir, needs: spec.needs, since, hook, timeoutMs: spec.timeout * 1000, fetch: this.d.fetch, signal: this.abort.signal });
    if (res.error) return res;
    try { return { ...res, items: normalize(res.items) }; }
    catch (e) { return { ...res, items: [], error: /** @type {Error} */ (e).message }; }
  }

  record(name, trigger, res, items, filed) {
    this.db.prepare("INSERT INTO watchers_runs (watcher, at, ms, trigger, ok, items, filed, error, logs) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(name, this.now(), res.ms || 0, trigger, res.error ? 0 : 1, items, filed, res.error || null, JSON.stringify(res.logs || []));
    // Keep the last 200 runs of each watcher; the log is for "why did it fail", not an archive.
    this.db.prepare("DELETE FROM watchers_runs WHERE watcher = ? AND id <= (SELECT id FROM watchers_runs WHERE watcher = ? ORDER BY id DESC LIMIT 1 OFFSET 200)").run(name, name);
  }

  async stop() { this.stopping = true; this.abort.abort(); await this.settle(); }
}
