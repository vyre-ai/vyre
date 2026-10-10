// @ts-check
// runtime: schedules, runs and files watchers. The module's tools are thin wrappers over this.
//
// A watcher's life: Claude writes its folder (a draft), watchers.test dry-runs it, and
// watchers.create turns on exactly what was dry-run (the hash of both files is recorded). From
// then on the runtime owns it: it runs on the schedule, keeps the `since` cursor, files each new
// item once into the project and teaches it to Memory, retries a failure with backoff, and after
// three failures in a row pauses it and says so. An edit to the folder pauses it too, until it is
// dry-run and created again.
//
// Three kinds of schedule: cron, "webhook" (vyred's /v1/watchers/<name>/hook, token-checked), and
// "event": the watcher runs when an event of its `on` type is emitted whose payload matches its
// `where`. For hook.received (core/hooks, an internet webhook through the Wink public gate) the runtime reads the
// delivery with hooks.delivery and hands it to the watcher, which stays in its sandbox and never
// calls a tool itself.
//
// Time comes from `now()` and runs are started by `tick()`, so tests drive the clock by hand.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as cron from "./cron.js";
import * as folder from "./folder.js";
import { runOnce, normalize } from "./run.js";
import { parseWhen } from "./when.js";
import { buildPreset } from "./presets.js";
import { wakeText, DEFAULT_PER_DAY } from "./wake.js";
import { DUTY_NAME, DUTY_WATCH_JS } from "./duty.js";
import { systemZone } from "../../lib/time/index.js";

/** Schedules that are not cron: nothing is due on a clock. */
const PUSHED = new Set(["webhook", "event"]);

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
`, `
  CREATE TABLE watchers_spend (watcher TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (watcher, day));
`, `
  CREATE TABLE watchers_wakes (watcher TEXT NOT NULL, day TEXT NOT NULL, posts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (watcher, day));
`];

/** Steps added after v0.3.0 (test/migrations-append-only.test.js): the list the module runs is [...MIGRATIONS, ...DEF_MIGRATIONS, ...LATE_MIGRATIONS], so a released step never moves. */
export const LATE_MIGRATIONS = [`
  CREATE TABLE watchers_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`];

/**
 * @typedef {{ db: import("node:sqlite").DatabaseSync, dir: string,
 *   emit: (type: string, payload: object, where?: object) => any, notice?: (text: string) => any,
 *   call: (tool: string, input: object) => Promise<{ data?: any, error?: any }>,
 *   fetch: (name: string, watcher: string, field?: string) => Promise<string>,
 *   teach: (kind: string, fact: object) => Promise<boolean>,
 *   log: (msg: string) => void, now?: () => number,
 *   listen?: (type: string, fn: (event: any) => void) => (() => void) }} Deps
 */

/** Does a vault.push event's scope ({projects, agents}) cover this project? */
export function pushInScope(scope, project) {
  const p = scope && scope.projects;
  return p === "*" || (Array.isArray(p) && (p.includes("*") || p.includes(project)));
}

/** A watcher name is checked before it is ever joined into a path or looked up. */
function mustName(name) {
  if (!folder.NAME.test(String(name || "")) || String(name).length > 60) throw Object.assign(new Error(`"${String(name).slice(0, 60)}" is not a watcher name`), { code: "bad_input" });
}

export class Runtime {
  /** @param {Deps} deps */
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || Date.now;
    /** The Space's time zone for cron schedules: the server's own unless the Space sets one. */
    this.zone = deps.zone || systemZone;
    this.db = deps.db;
    /** @type {Map<string, Promise<any>>} runs in flight, one per watcher */
    this.running = new Map();
    /** @type {Map<string, { trigger: string, hook: any }[]>} webhook bodies and events that arrived during a run */
    this.queued = new Map();
    /** @type {Map<string, () => void>} event types listened for, for schedule "event" */
    this.subs = new Map();
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
      const every = schedule === "event" && f.spec ? describeOn(f.spec) : schedule ? cron.describe(schedule, this.zone()) : null;
      out.push({ name, state, hash: f.hash || null, title: f.spec?.summary?.do || null, project: f.spec?.project || r?.project || null, schedule, every,
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
  async test(name, { since = null, event = null } = {}) {
    const f = folder.read(this.d.dir, name);
    if (f.problems.length) return { ok: false, name, problems: f.problems, dir: f.dir };
    const spec = /** @type {folder.Spec} */ (f.spec);
    // An event watcher can be dry-run on a real event's payload (a hook.received from
    // hooks.list), which must match its where, so a dry run cannot read another route's delivery.
    if (event && (spec.schedule !== "event" || !folder.matches(spec.where, event))) {
      return { ok: false, name, problems: [spec.schedule !== "event" ? "event is for a watcher that runs on an event" : `the event does not match where ${JSON.stringify(spec.where)}`], dir: f.dir };
    }
    const res = await this.exec(f.dir, spec, since, event ? await this.eventInput(/** @type {string} */ (spec.on), event) : null);
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
      schedule: spec.schedule, every: spec.schedule === "event" ? describeOn(spec) : cron.describe(spec.schedule, this.zone()), needs: spec.needs, count: res.items.length,
      alreadyFiled: res.items.filter(i => filed.get(name, i.id)).length,
      items: res.items.slice(0, 20), logs: res.logs.slice(-20), ms: res.ms, sandboxed: res.sandboxed, networkIsolated: res.isolated === true, wall: res.wall || null,
      ...(res.items.length ? {} : { note: "no items. That can be right (nothing new matches), or the filter or the parsing is wrong; the logs show what it saw" }),
    };
  }

  /**
   * What the card shows before the one tap. The safety-relevant lines (what it reads, whether it can
   * act, what it costs) come from the folder itself, never from `summary`, which is only the
   * author's description; `hash` is what Turn on must still match (watchers.create refuses if it moved).
   */
  card(name) {
    const { spec, hash } = this.spec(name);
    const r = this.row(name);
    const when = spec.schedule === "event" ? describeOn(spec) : cron.describe(spec.schedule, this.zone());
    const duty = spec.owner != null && spec.owner.kind === "teammate";
    const wakes = spec.about && spec.about.session && spec.act ? spec.about.session : null;
    return {
      name, hash, project: spec.project, state: !r || !r.enabled ? "draft" : r.paused ? "paused" : r.hash !== hash ? "changed" : "on",
      owner: spec.owner ? { ...spec.owner } : { kind: "project", project: spec.project },
      lines: {
        when: spec.summary ? spec.summary.when : spec.when ? `Runs ${when} (${spec.when})` : `Runs ${when}`,
        ...(spec.summary && spec.summary.check ? { check: spec.summary.check } : {}),
        do: spec.summary ? spec.summary.do : duty && spec.instruction ? spec.instruction.split("\n")[0].slice(0, 240) : "Files what it finds into the project, marked as from outside",
      },
      facts: {
        reads: spec.source ? ["github (your connected account, read only)"] : spec.net ? Object.keys(spec.net) : [],
        readsText: spec.source ? "Reads the new comments other people leave on this session's pull requests, from GitHub through your connected account (read only)" : spec.net ? `Reads ${Object.keys(spec.net).join(", ")}` : "Reads nothing from the web",
        credentials: spec.net ? Object.entries(spec.net).filter(([, v]) => v.vault || v.credential || v.google).map(([h, v]) => ({ host: h, item: v.vault || v.credential || `google:${v.google}`, how: v.google ? "your connected Google account, read only" : v.credential ? "the vault calls it, read only" : "Vyre adds it to requests" })) : [],
        acts: wakes ? `Posts what it finds into session ${wakes} as quoted notes, up to ${spec.wake ? spec.wake.maxPerDay : DEFAULT_PER_DAY} times a day; never as an instruction`
          : duty && spec.act ? "May take actions for its teammate; anything outward that you did not ask for holds for you" : "Never acts: it reads and files",
        cost: spec.ask ? `Asks a model, at most $${spec.ask.dailyUsd} a day` : "No model cost",
        schedule: when,
      },
      described: spec.summary ? "by its author" : "by Vyre",
    };
  }

  /** Turn on what was dry-run. A scheduled watcher runs once straight away, then on its schedule. */
  async create(name, { hash: shown = null } = {}) {
    const { spec, hash } = this.spec(name);
    if (shown && shown !== hash) throw new Error(`${name} changed after its card was shown; show the card again, then turn it on`);
    const r = this.row(name);
    if (!r || r.tested_hash !== hash) throw new Error(`${name} has ${r && r.tested_hash ? "changed since its last dry run" : "not been dry-run"}; run watchers.test, show the user its items, then create it`);
    const project = await this.project(spec.project);
    if (!project) throw new Error(`no project "${spec.project}"; vyre projects lists them, and the watcher's project must be one of their slugs`);
    const now = this.now();
    const hook = spec.schedule === "webhook", pushed = PUSHED.has(spec.schedule);
    const token = hook ? r.token || crypto.randomBytes(24).toString("base64url") : null;
    // Turning on again after an edit keeps the cursor, so it carries on from where it was.
    this.db.prepare(`UPDATE watchers_watchers SET project = ?, schedule = ?, hash = ?, enabled = 1, paused = 0, paused_why = NULL,
      failures = 0, last_error = NULL, token = ?, next_at = ?, created_at = COALESCE(created_at, ?) WHERE name = ?`)
      .run(project.slug, spec.schedule, hash, token, pushed ? null : now, now, name);
    this.d.emit("watcher.created", { name, project: project.slug, schedule: spec.schedule }, { project: project.slug });
    if (!pushed) this.kick(name, "create");
    if (spec.schedule === "event") this.subscribe();
    return { name, project: project.slug, schedule: spec.schedule, every: spec.schedule === "event" ? describeOn(spec) : cron.describe(spec.schedule, this.zone()), state: "on",
      ...(hook ? { hook: { method: "POST", path: `/v1/watchers/${name}/hook`, header: "x-vyre-token", token } } : {}) };
  }

  /**
   * A teammate's duty: the folder is written here from plain words (the code is the fixed template
   * in duty.js), marked as dry-run, and turned on. The person's own ask already covered it, so there
   * is no separate dry-run step; teammates makes no call until a person turned the duty on.
   * @param {{ name: string, project: string, owner: { kind: string, teammate: string }, when: string, instruction: string, act?: boolean }} d
   */
  async createDuty(d) {
    if (!DUTY_NAME.test(String(d.name || ""))) throw new Error(`a duty's name starts with duty-, like duty-reviewer-1a2b3c4d`);
    if (this.row(d.name)?.enabled) throw new Error(`${d.name} already exists; use watchers.update`);
    this.writeDuty(d);
    const { hash, spec } = this.spec(d.name);
    this.db.prepare(`INSERT INTO watchers_watchers (name, project, schedule, tested_hash, tested_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET tested_hash = excluded.tested_hash, tested_at = excluded.tested_at`).run(d.name, spec.project, spec.schedule, hash, this.now());
    try { return await this.create(d.name); }
    catch (e) { fs.rmSync(path.join(this.d.dir, d.name), { recursive: true, force: true }); this.db.prepare("DELETE FROM watchers_watchers WHERE name = ? AND enabled = 0").run(d.name); throw e; }
  }

  /**
   * A preset watcher, from a few plain fields: written, hashed as dry-run (there is no live fetch to
   * try), and left OFF with its card, so one tap turns it on. The grant the vault needs comes back
   * as the exact command, since a module's use of an api-credential is the person's to allow.
   * @param {{ kind: string, project: string, credential?: string, [k: string]: any }} o
   */
  async createPreset(o, resolved = {}) {
    const p = buildPreset(o, resolved);
    if (!(await this.project(o.project))) throw new Error(`no project "${o.project}"; vyre projects lists them`);
    const dir = path.join(this.d.dir, p.name);
    if (this.row(p.name)?.enabled || fs.existsSync(dir)) throw new Error(`${p.name} already exists; watchers.card shows it`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify(p.json, null, 2));
    fs.writeFileSync(path.join(dir, "watch.js"), p.code);
    const f = folder.read(this.d.dir, p.name);
    if (f.problems.length) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(f.problems.join("; ")); }
    this.db.prepare(`INSERT INTO watchers_watchers (name, project, schedule, tested_hash, tested_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET tested_hash = excluded.tested_hash, tested_at = excluded.tested_at`).run(p.name, p.json.project, f.spec ? f.spec.schedule : "event", f.hash, this.now());
    return { ...this.card(p.name), grant: `vyre vault grant ${o.google ? (typeof this.d.googleItem === "function" ? await this.d.googleItem(o.google).catch(() => null) : null) || "<the Google account's vault item>" : o.credential} watchers --watcher ${p.name}`, ...(o.google ? { note: `reads your connected Google account ${o.google}, read only, once the person grants its vault item to this watcher` } : {}) };
  }

  /** Change a duty's trigger, words or act flag. It keeps its cursor and whether it is on or paused. */
  async updateDuty(d) {
    mustName(d.name);
    const r = this.row(d.name);
    const cur = this.spec(d.name).spec;
    if (!r || !cur.owner) throw Object.assign(new Error(`${d.name} is not a duty (team.duties.list shows a teammate's duties)`), { code: "not_found" });
    this.writeDuty({ project: cur.project, owner: cur.owner, when: d.when, instruction: d.instruction, act: d.act, name: d.name, current: cur });
    const { hash, spec } = this.spec(d.name);
    const next = PUSHED.has(spec.schedule) ? null : cron.next(cron.parse(spec.schedule), this.now(), this.zone());
    this.db.prepare("UPDATE watchers_watchers SET tested_hash = ?, tested_at = ?, hash = ?, schedule = ?, next_at = ? WHERE name = ?").run(hash, this.now(), hash, spec.schedule, r.paused ? null : next, d.name);
    if (spec.schedule === "event") this.subscribe();
    return { name: d.name, state: r.paused ? "paused" : "on", schedule: spec.schedule };
  }

  writeDuty(d) {
    mustName(d.name);
    const bad = [];
    folder.checkOwner(d.owner, bad);
    if (bad.length) throw new Error(bad.join("; "));
    if (d.owner.kind !== "teammate") throw new Error("a duty is owned by a teammate");
    if (typeof d.project !== "string" || !d.project.trim()) throw new Error("a duty needs project");
    const cur = d.current || {};
    const when = String(d.when === undefined ? cur.when : d.when);
    const t = parseWhen(when);
    const dir = path.join(this.d.dir, d.name);
    fs.mkdirSync(dir, { recursive: true });
    const json = { name: d.name, project: d.project, when, ...(t.on ? { on: t.on, ...(t.where ? { where: t.where } : {}) } : { schedule: t.schedule }),
      owner: { kind: "teammate", teammate: d.owner.teammate }, instruction: d.instruction === undefined ? cur.instruction : d.instruction,
      act: d.act === undefined ? cur.act === true : Boolean(d.act), emits: "duty.fired", timeout: 60 };
    fs.writeFileSync(path.join(dir, "watcher.json"), JSON.stringify(json, null, 2));
    fs.writeFileSync(path.join(dir, "watch.js"), DUTY_WATCH_JS);
  }

  /** Stop and forget a watcher. A duty's folder goes too; its filed items stay, as history. */
  remove(name) {
    mustName(name);
    const r = this.row(name);
    const f = folder.read(this.d.dir, name);
    if (!r && !f.hash) throw Object.assign(new Error(`no watcher ${name} (watchers.list shows them)`), { code: "not_found" });
    this.db.prepare("DELETE FROM watchers_watchers WHERE name = ?").run(name);
    if (DUTY_NAME.test(name)) { fs.rmSync(path.join(this.d.dir, name), { recursive: true, force: true }); if (this.d.defs) void this.d.defs.forget(name).catch(() => {}); }
    this.d.emit("watcher.deleted", { name }, { project: r?.project || f.spec?.project });
    return { name, deleted: true };
  }

  /** Run a turned-on watcher now and say what happened. */
  async run(name) {
    mustName(name);
    const r = this.row(name);
    if (!r || !r.enabled || r.paused) throw Object.assign(new Error(`${name} is not on; turn it on first (watchers.resume if it is paused)`), { code: "denied" });
    await this.kick(name, "run");
    return this.logs(name, 1);
  }

  pause(name, why = "paused by the user") {
    const r = this.row(name);
    if (!r || !r.enabled) throw new Error(`${name} is not turned on`);
    if (r.paused) return { name, state: "paused", why: r.paused_why };
    this.db.prepare("UPDATE watchers_watchers SET paused = 1, paused_why = ? WHERE name = ?").run(why, name);
    this.d.emit("watcher.paused", { name, why }, { project: r.project });
    return { name, state: "paused", why };
  }

  resume(name, { hash: shown = null } = {}) {
    const r = this.row(name);
    if (!r || !r.enabled) throw new Error(`${name} is not turned on; dry-run it with watchers.test, then watchers.create`);
    const { hash } = this.spec(name);
    if (shown && shown !== hash) throw new Error(`${name} changed after its card was shown; show the card again, then turn it on`);
    if (hash !== r.hash) throw new Error(`${name} changed since it was turned on; run watchers.test and watchers.create again`);
    const next = PUSHED.has(r.schedule) ? null : cron.next(cron.parse(r.schedule), this.now(), this.zone());
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
    this.zoneCheck(now);
    const due = this.db.prepare(`SELECT name FROM watchers_watchers WHERE enabled = 1 AND paused = 0
      AND next_at IS NOT NULL AND next_at <= ?`).all(now);
    return due.map(r => this.kick(String(r.name), "schedule")).filter(Boolean);
  }

  /**
   * Schedules ran in the machine's local time before they ran in the Space's zone. Once, when the zone a watcher's cron runs in changes (the first tick after the upgrade included), every enabled
   * cron watcher is re-aimed at its next time in the new zone, and the person is told which ones actually fire at a different moment (an event, and a to-do in the planner).
   * @param {number} now
   */
  zoneCheck(now) {
    const zone = this.zone();
    const row = this.db.prepare("SELECT v FROM watchers_state WHERE k = 'cron_zone'").get();
    const before = row ? String(row.v) : systemZone();
    if (before === zone && row) return;
    this.db.prepare("INSERT INTO watchers_state (k, v) VALUES ('cron_zone', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(zone);
    if (before === zone) return;
    const fmt = (/** @type {number|null} */ t) => (t == null ? null : new Date(t).toISOString());
    /** @type {{ name: string, schedule: string, was: string|null, now: string|null }[]} */ const moved = [];
    for (const r of this.db.prepare("SELECT name, schedule FROM watchers_watchers WHERE enabled = 1 AND paused = 0").all()) {
      const schedule = String(r.schedule);
      if (PUSHED.has(schedule)) continue;
      let c; try { c = cron.parse(schedule); } catch { continue; }
      const was = cron.next(c, now, before), next = cron.next(c, now, zone);
      this.db.prepare("UPDATE watchers_watchers SET next_at = ? WHERE name = ?").run(next, String(r.name));
      if (was !== next) moved.push({ name: String(r.name), schedule, was: fmt(was), now: fmt(next) });
    }
    if (!moved.length) return;
    this.d.emit("watcher.schedule-moved", { zone_before: before, zone_now: zone, watchers: moved });
    if (this.d.notice) {
      const list = moved.slice(0, 10).map(m => `${m.name} (${cron.describe(m.schedule, zone)})`).join("; ");
      Promise.resolve(this.d.notice(`Watcher schedules now follow the Space's time zone (${zone}), not this machine's (${before}). ${moved.length} fire at a different time than before: ${list}${moved.length > 10 ? " and more" : ""}.`)).catch(() => {});
    }
  }

  /**
   * Run a watcher now unless it is already running. A schedule that comes round mid-run is
   * skipped; a webhook call or an event mid-run is queued, because it carries the item and must
   * not be lost.
   */
  kick(name, trigger, hook = null) {
    if (this.stopping) return null;
    if (this.running.has(name)) {
      if (trigger === "hook" || trigger === "event") { const q = this.queued.get(name) || []; q.push({ trigger, hook }); this.queued.set(name, q); }
      return this.running.get(name) || null;
    }
    const p = (async () => {
      await this.fire(name, trigger, hook).catch(e => this.d.log(`${name}: ${e.message}`));
      for (let q = this.queued.get(name); q && q.length && !this.stopping; q = this.queued.get(name)) {
        const next = /** @type {{ trigger: string, hook: any }} */ (q.shift());
        await this.fire(name, next.trigger, next.hook).catch(e => this.d.log(`${name}: ${e.message}`));
      }
      this.queued.delete(name);
    })().finally(() => this.running.delete(name));
    this.running.set(name, p);
    return p;
  }

  // ------------------------------------------------------------------ events

  /**
   * Listen for every event type an event watcher that is turned on runs on. Once listened for, a
   * type stays so until stop: an unused listener costs one query per such event, and nothing runs
   * while no event comes.
   */
  subscribe() {
    if (!this.d.listen || this.stopping) return;
    const rows = this.db.prepare("SELECT name FROM watchers_watchers WHERE enabled = 1 AND schedule = 'event'").all();
    for (const r of rows) {
      const on = folder.read(this.d.dir, String(r.name)).spec?.on;
      if (on && !this.subs.has(on)) this.subs.set(on, this.d.listen(on, e => { this.onEvent(e).catch(err => this.d.log(`event ${on}: ${err.message}`)); }));
    }
  }

  /** An event came: run each watcher turned on for its type whose where matches its payload. */
  async onEvent(event) {
    if (this.stopping) return;
    const rows = this.db.prepare("SELECT name FROM watchers_watchers WHERE enabled = 1 AND paused = 0 AND schedule = 'event'").all();
    for (const r of rows) {
      const name = String(r.name);
      const spec = folder.read(this.d.dir, name).spec;
      // A folder edited since it was turned on is caught by fire(), which pauses it; one whose
      // type or where no longer fits this event is not run for it.
      if (!spec || spec.on !== event.type || !folder.matches(spec.where, event.payload)) continue;
      // A connection's push reaches only the projects it is granted to (vault's scope); no scope, no run.
      if (event.type === "vault.push" && !pushInScope(event.payload && event.payload.scope, spec.project)) continue;
      this.kick(name, "event", await this.eventInput(event.type, event.payload));
    }
  }

  /**
   * What an event watcher gets as `hook`: the event's type and payload, and for hook.received the
   * delivery itself (headers and body), read here because the watcher cannot call tools.
   */
  async eventInput(type, payload) {
    const input = { event: type, ...(payload && typeof payload === "object" ? payload : {}) };
    if (type !== "hook.received") return input;
    const r = await this.d.call("hooks.delivery", { id: String(payload && payload.id) });
    if (r.error) { this.d.log(`hook.received ${payload && payload.id}: ${r.error.message}`); return { ...input, delivery: null }; }
    return { ...input, delivery: r.data };
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
    if (project && spec.memory !== false) {
      for (const item of fresh) {
        await this.d.teach("watcher.item", {
          subject: { name: typeof item.about === "string" && item.about.trim() ? item.about.trim().slice(0, 120) : name },
          text: [item.title || String(item.id), typeof item.quote === "string" && item.quote ? `"${item.quote.slice(0, 200)}"` : null, item.url].filter(Boolean).join(" · ").slice(0, 500),
          at: item.at || undefined, key: `${name}/${item.id}`, project_cwds: project.folders,
        }).catch(() => false);
      }
    } else if (fresh.length && spec.memory !== false) this.d.log(`${name}: project ${r.project} is gone, so ${fresh.length} items were filed but not taught to Memory`);

    const cursor = res.cursor ?? started;
    const next = PUSHED.has(r.schedule) ? null : cron.next(cron.parse(r.schedule), this.now(), this.zone());
    this.db.prepare(`UPDATE watchers_watchers SET since = ?, failures = 0, last_run = ?, last_ok = ?, last_error = NULL, next_at = ? WHERE name = ?`)
      .run(JSON.stringify(cursor), started, started, next, name);
    if (fresh.length && spec.about && spec.about.session && spec.act) await this.wake(spec, fresh, res.logs);
    this.record(name, trigger, res, res.items.length, fresh.length);
    this.d.emit("watcher.fired", { name, items: fresh.length, seen: res.items.length, trigger }, { project: r.project });
  }

  failed(name, r, trigger, res, started) {
    if (res.unisolated) {
      this.d.forgetWall?.();      // the next run finds the wall again, instead of trusting one that stopped answering
      // Not the watcher's failure and not retried in a hurry: nothing ran, the machine cannot keep it off the network.
      this.db.prepare("UPDATE watchers_watchers SET last_run = ?, last_error = ?, next_at = ? WHERE name = ?").run(started, res.error, this.now() + 3_600_000, name);
      this.record(name, trigger, res, 0, 0);
      this.d.emit("watcher.failed", { name, error: res.error.slice(0, 300), failures: Number(r.failures || 0), paused: false }, { project: r.project });
      return;
    }
    const failures = Number(r.failures || 0) + 1;
    const pause = failures >= MAX_FAILURES;
    const next = pause ? null : this.now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    this.db.prepare("UPDATE watchers_watchers SET failures = ?, last_run = ?, last_error = ?, next_at = ? WHERE name = ?").run(failures, started, res.error, next, name);
    this.record(name, trigger, res, 0, 0);
    this.d.emit("watcher.failed", { name, error: res.error.slice(0, 300), failures, paused: pause }, { project: r.project });
    if (pause) this.pause(name, `failed ${failures} times in a row: ${res.error.slice(0, 200)}`);
  }

  /** Run in a child and check the items; a bad item is the run's error. */
  /**
   * A watcher whose items come from a first-party tool Vyre calls itself (no watcher code, no child, nothing
   * of its own to reach the network with): today github.session.review, the new comments from other people
   * on the pull requests of a session's branch. The first run only learns where to start from. Each item
   * is outside text and is filed and quoted as such; the cursor is the tool's own.
   */
  async execSource(spec, since) {
    const t0 = Date.now(), base = { logs: /** @type {string[]} */ ([]), sandboxed: true, isolated: true, wall: "source" };
    const r = await this.d.call(/** @type {{ tool: string }} */ (spec.source).tool, { project: spec.project, session: /** @type {{ session: string }} */ (spec.about).session, ...(since ? { since: String(since) } : {}) });
    if (r.error) return { ...base, items: [], cursor: null, ms: Date.now() - t0, error: `${spec.source && spec.source.tool}: ${r.error.message || r.error.code}` };
    const data = r.data || {};
    const start = new Date(this.now()).toISOString().replace(/\.\d+Z$/, "Z");
    if (since == null) return { ...base, logs: ["starting from now"], items: [], cursor: typeof data.cursor === "string" ? data.cursor : start, ms: Date.now() - t0, error: null };
    const raw = (Array.isArray(data.items) ? data.items : []).map(i => ({ id: i.id, title: i.title, about: i.author, quote: i.quote, url: i.url, at: i.at }));
    try {
      const items = normalize(raw);
      return { ...base, logs: [`${items.length} new`], items, cursor: typeof data.cursor === "string" ? data.cursor : String(since), ms: Date.now() - t0, error: null };
    } catch (e) { return { ...base, items: [], cursor: null, ms: Date.now() - t0, error: /** @type {Error} */ (e).message }; }
  }

  async exec(dir, spec, since, hook) {
    if (spec.source) return this.execSource(spec, since);
    const res = await runOnce({ dir, needs: spec.needs, since, hook, timeoutMs: spec.timeout * 1000, fetch: (n, field) => this.d.fetch(n, spec.name, field), signal: this.abort.signal, wall: typeof this.d.wall === "function" ? this.d.wall() : this.d.wall, findWall: this.d.findWall, viaRequest: spec.net ? async (url, init) => {
        const rule = spec.net[url.hostname];
        if (rule && rule.google) {
          // A connected Google account: the google module reads for it (Gmail and Calendar reads only), the token never leaves it.
          const method = String((init && init.method) || "GET").toUpperCase();
          if (method !== "GET") throw new Error(`${method} is not allowed from a watcher; only GET`);
          if (typeof this.d.google !== "function") throw new Error("the google module is not running on this machine");
          // no grant, no read: a person grants the account's vault item to this watcher, for a dry run as for a run
          if (typeof this.d.googleGranted !== "function" || !(await this.d.googleGranted(rule.google, spec.name))) {
            const item = typeof this.d.googleItem === "function" ? await this.d.googleItem(rule.google).catch(() => null) : null;
            throw new Error(`the Google account ${rule.google} is not granted to this watcher; a person runs: vyre vault grant ${item || "<the account's vault item>"} watchers --watcher ${spec.name}`);
          }
          const query = {};
          for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
          const r = await this.d.google({ account: rule.google, method, path: url.pathname, ...(url.search ? { query } : {}) });
          return { status: Number(r.status), url: url.href, headers: {}, body: JSON.stringify(r.body ?? {}), truncated: false };
        }
        if (!rule || !rule.credential) return undefined;
        const method = String((init && init.method) || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") throw new Error(`${method} is not allowed from a watcher; only GET and HEAD`);
        if (typeof this.d.request !== "function") throw new Error("the vault is not running on this machine");
        const r = await this.d.request({ credential: rule.credential, method, url: url.href, watcher: spec.name });
        return { status: Number(r.status), url: url.href, headers: Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)])), body: typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? ""), truncated: false };
      } : null,
      askFn: spec.ask ? (prompt => this.askModel(spec, prompt)) : null, hosts: spec.net ? Object.keys(spec.net) : null,
      netAuth: spec.net ? async url => {
        const rule = spec.net[url.hostname];   // the exact declared host, never a subdomain
        if (!rule || !rule.vault) return undefined;
        const value = await this.d.fetch(rule.vault, spec.name, rule.field);
        return { host: url.hostname, header: rule.header, value: rule.scheme ? `${rule.scheme} ${value}` : String(value) };
      } : undefined, netOptions: typeof this.d.netOptions === "function" ? this.d.netOptions() : this.d.netOptions });
    if (res.error) return res;
    try { return { ...res, items: normalize(res.items) }; }
    catch (e) { return { ...res, items: [], error: /** @type {Error} */ (e).message }; }
  }

  /**
   * Wake the session this watcher is about: ONE post per run with what is new, as quoted untrusted data
   * (core/watchers/wake.js), after four checks every time: the watcher is owned by that session, the
   * thread exists, it belongs to the watcher's project, and today's budget is not spent. A refusal skips
   * the post and says why in the run's log; the items are filed either way, and nothing is retried.
   * @param {folder.Spec} spec @param {any[]} fresh the items filed by this run @param {string[]} logs the run's log lines
   */
  async wake(spec, fresh, logs) {
    const name = spec.name, thread = /** @type {{ session: string }} */ (spec.about).session;
    const skip = why => { logs.push(`not woken: ${why}`); this.d.log(`${name}: not woken: ${why}`); };
    if (!spec.owner || spec.owner.kind !== "session" || spec.owner.thread !== thread) return skip("the watcher is not owned by that session");
    if (typeof this.d.thread !== "function" || typeof this.d.post !== "function") return skip("this machine cannot post to a session");
    let info;
    try { info = await this.d.thread(thread); } catch { info = null; }
    if (!info) return skip(`no session ${thread}`);
    if (info.project !== spec.project) return skip("the session belongs to another project");
    const day = new Date(this.now()).toISOString().slice(0, 10), cap = spec.wake ? spec.wake.maxPerDay : DEFAULT_PER_DAY;
    const used = Number(/** @type {any} */ (this.db.prepare("SELECT posts FROM watchers_wakes WHERE watcher = ? AND day = ?").get(name, day))?.posts || 0);
    if (used >= cap) return skip(`already woke it ${used} times today (the most is ${cap})`);
    const { text, shown } = wakeText(name, fresh);
    try { await this.d.post(thread, text, `watcher:${name}`); }
    catch (e) { return skip(`the post was refused: ${/** @type {Error} */ (e).message}`); }
    this.db.prepare(`INSERT INTO watchers_wakes (watcher, day, posts) VALUES (?,?,1) ON CONFLICT(watcher, day) DO UPDATE SET posts = posts + 1`).run(name, day);
    this.d.emit("watcher.woke", { name, thread, items: shown }, { project: spec.project });
    logs.push(`woke session ${thread} with ${shown} item${shown === 1 ? "" : "s"}`);
  }

  /**
   * A watcher's one way to a model: a judgment fed back into its own code (is this relevant, which
   * of these). No tools, no vault values, never a decision to send. The dollars are already in
   * core/spend: the switchboard's thread.finished for the quick session lands in the ledger by
   * itself, so recording again here would count it twice. What core/spend cannot do is say which
   * watcher spent it, so this keeps only a per-watcher tally for watcher.json's ask.dailyUsd, and
   * asks core/spend whether the provider's own daily cap still has room (spend.check).
   */
  async askModel(spec, prompt) {
    const sp = this.d.spend;
    if (typeof this.d.ask !== "function") throw new Error("no model is available to a watcher on this machine yet");
    if (!sp) throw new Error("a watcher cannot ask a model while the spend ledger is off");
    const day = new Date(this.now()).toISOString().slice(0, 10), cap = spec.ask ? spec.ask.dailyUsd : 0;
    const standing = await sp.check();
    if (standing && standing.ok === false) throw new Error(standing.line || "today's model budget is reached");
    const used = Number(/** @type {any} */ (this.db.prepare("SELECT usd FROM watchers_spend WHERE watcher = ? AND day = ?").get(spec.name, day))?.usd || 0);
    if (used >= cap) throw new Error(`${spec.name} reached its daily model budget of $${cap}`);
    const r = await this.d.ask(prompt, { purpose: `watcher:${spec.name}`, maxUsd: Math.max(0.001, cap - used) });
    this.db.prepare(`INSERT INTO watchers_spend (watcher, day, usd, calls) VALUES (?,?,?,1)
      ON CONFLICT(watcher, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1`).run(spec.name, day, Number(r && r.usd) || 0);
    return String((r && r.text) || "");
  }

  record(name, trigger, res, items, filed) {
    this.db.prepare("INSERT INTO watchers_runs (watcher, at, ms, trigger, ok, items, filed, error, logs) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(name, this.now(), res.ms || 0, trigger, res.error ? 0 : 1, items, filed, res.error || null, JSON.stringify(res.logs || []));
    // Keep the last 200 runs of each watcher; the log is for "why did it fail", not an archive.
    this.db.prepare("DELETE FROM watchers_runs WHERE watcher = ? AND id <= (SELECT id FROM watchers_runs WHERE watcher = ? ORDER BY id DESC LIMIT 1 OFFSET 200)").run(name, name);
  }

  async stop() {
    this.stopping = true;
    for (const off of this.subs.values()) off();
    this.subs.clear();
    this.abort.abort();
    await this.settle();
  }
}

/** "on hook.received where route is northwind-orders". */
function describeOn(spec) {
  const w = spec.where ? Object.entries(spec.where).map(([k, v]) => `${k} is ${v}`).join(" and ") : "";
  return `on ${spec.on}${w ? ` where ${w}` : ""}`;
}
