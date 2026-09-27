// @ts-check
// tips: one short, useful line at a time about the part of Vyre the person is using, the parts
// they have not tried, and what an update brought. Every module ships its own tips in its
// manifest (teaches.tips, checked by ./check.js), so a module added from outside teaches itself
// the same way. This module only chooses (./pick.js) and remembers what was shown.
//
// It never nags: nothing while an ask or a turn is on screen, one tip per surface per gap, six a
// day, a tip retires after two showings, a dismissed one never returns, and tips.enabled turns
// them all off. A surface asks with tips.next; nothing here pushes a tip anywhere.

import { build } from "../daemon/build.js";
import { checkTips, compareVersions } from "./check.js";
import { pick, DEFAULTS } from "./pick.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const MIN = 60_000, WEEK = 7 * 86_400_000;
const MIGRATIONS = [
  `CREATE TABLE tips_shown (id TEXT PRIMARY KEY, shows INTEGER NOT NULL DEFAULT 0, last_at INTEGER, dismissed_at INTEGER);
   CREATE TABLE tips_used (module TEXT PRIMARY KEY, uses INTEGER NOT NULL DEFAULT 0, last_at INTEGER);
   CREATE TABLE tips_log (at INTEGER NOT NULL, surface TEXT NOT NULL, id TEXT NOT NULL, module TEXT NOT NULL);
   CREATE INDEX tips_log_at ON tips_log (at);
   CREATE TABLE tips_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
const SETTINGS = { enabled: "tips.enabled", gapMinutes: "tips.gap_minutes" };
const str = { type: "string" };
const surfaceIn = { type: "string", enum: ["capsule", "deck", "chat", "phone", "cli", "glass"] };

/** Test seam: a fake clock per home. @type {Map<string, { now: () => number }>} */
export const seams = new Map();

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const seam = seams.get(ctx.paths && ctx.paths.root);
    const now = () => (seam ? seam.now() : Date.now());
    const vyre = () => (ctx.config && ctx.config.tips && ctx.config.tips.version) || build().version;

    // The declared tips of every running module, checked once, again when modules change.
    /** @type {{ tips: import("./check.js").Tip[], versions: Map<string, { version: string, firstParty: boolean }> } | null} */
    let declared = null;
    const all = () => {
      if (declared) return declared;
      const list = typeof ctx.declaredTips === "function" ? ctx.declaredTips() : [];
      /** @type {import("./check.js").Tip[]} */
      const tips = [];
      const versions = new Map();
      for (const d of list) {
        const r = checkTips(d.module, d.tips);
        for (const p of r.problems) ctx.log(`${d.module}: ${p}`);
        tips.push(...r.tips);
        versions.set(d.module, { version: String(d.version || "0.0.0"), firstParty: d.firstParty !== false });
      }
      return (declared = { tips, versions });
    };
    const offModules = ctx.events.on("modules.changed", () => { declared = null; });

    // Settings from the hub (native-core's settings module), else config.tips, else the defaults.
    /** @type {Partial<typeof DEFAULTS> | null} */
    let settings = null;
    const readSettings = async () => {
      if (settings) return settings;
      const conf = (ctx.config && ctx.config.tips) || {};
      /** @type {any} */
      const s = { ...(conf.enabled !== undefined ? { enabled: conf.enabled !== false } : {}), ...(conf.gap_minutes ? { gapMinutes: Number(conf.gap_minutes) } : {}) };
      for (const [k, key] of Object.entries(SETTINGS)) {
        const r = await ctx.call("settings.get", { key });
        const v = r && r.data && r.data.value;
        if (v !== undefined && v !== null) s[k] = k === "enabled" ? v !== false : Number(v);
      }
      return (settings = s);
    };
    const offSettings = ctx.events.on("settings.changed", () => { settings = null; });

    const meta = (/** @type {string} */ key) => { const r = db.prepare("SELECT value FROM tips_meta WHERE key = ?").get(key); return r ? String(r.value) : null; };
    const setMeta = (/** @type {string} */ key, /** @type {string} */ value) => db.prepare("INSERT INTO tips_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);

    // Which version a tip is measured against: Vyre's own for first-party modules, the module's
    // own for one added from outside. "vyre" or the module's name is the key its seen version is kept under.
    const keyOf = (/** @type {import("./check.js").Tip} */ t) => (all().versions.get(t.module)?.firstParty === false ? `m:${t.module}` : "vyre");
    const runningOf = (/** @type {string} */ key) => (key === "vyre" ? vyre() : all().versions.get(key.slice(2))?.version || "0.0.0");

    // A version that moved since the last start (ran:) is an update, announced once. What's new
    // is what came after the version the person last saw (seen:), which moves only when they
    // acknowledge it. A first start records both and offers no "what's new".
    /** @type {{ key: string, from: string, to: string }[]} */
    const moved = [];
    const keys = new Set(["vyre", ...[...all().versions].filter(([, v]) => !v.firstParty).map(([m]) => `m:${m}`)]);
    for (const key of keys) {
      const to = runningOf(key), from = meta(`ran:${key}`);
      if (from === null) { setMeta(`ran:${key}`, to); if (meta(`seen:${key}`) === null) setMeta(`seen:${key}`, to); continue; }
      if (compareVersions(to, from) > 0) moved.push({ key, from, to });
      if (from !== to) setMeta(`ran:${key}`, to);
    }
    db.prepare("DELETE FROM tips_log WHERE at < ?").run(now() - WEEK);
    for (const m of moved) {
      const count = all().tips.filter(t => keyOf(t) === m.key && compareVersions(t.since, m.from) > 0 && compareVersions(t.since, m.to) <= 0).length;
      ctx.events.emit("tips.updated", { module: m.key === "vyre" ? null : m.key.slice(2), from: m.from, to: m.to, count });
    }

    const state = () => {
      /** @type {Map<string, { shows: number, last: number, dismissed: boolean }>} */
      const shown = new Map();
      for (const r of /** @type {any[]} */ (db.prepare("SELECT id, shows, last_at, dismissed_at FROM tips_shown").all())) shown.set(String(r.id), { shows: Number(r.shows), last: Number(r.last_at || 0), dismissed: r.dismissed_at != null });
      /** @type {Map<string, number>} */
      const used = new Map();
      for (const r of /** @type {any[]} */ (db.prepare("SELECT module, uses FROM tips_used").all())) used.set(String(r.module), Number(r.uses));
      const log = /** @type {any[]} */ (db.prepare("SELECT at, surface FROM tips_log WHERE at >= ?").all(now() - 86_400_000)).map(r => ({ at: Number(r.at), surface: String(r.surface) }));
      /** @type {Map<string, number>} */
      const lastTipAt = new Map();
      for (const r of /** @type {any[]} */ (db.prepare("SELECT module, MAX(at) AS at FROM tips_log GROUP BY module").all())) lastTipAt.set(String(r.module), Number(r.at));
      return { shown, used, log, lastTipAt };
    };

    /** Count a use of a module, at most once per five minutes, so a surface asking often counts once. */
    const use = (/** @type {string} */ module) => {
      const t = now();
      const r = /** @type {any} */ (db.prepare("SELECT last_at FROM tips_used WHERE module = ?").get(module));
      if (r && t - Number(r.last_at || 0) < 5 * MIN) return;
      db.prepare("INSERT INTO tips_used (module, uses, last_at) VALUES (?, 1, ?) ON CONFLICT (module) DO UPDATE SET uses = uses + 1, last_at = excluded.last_at").run(module, t);
    };
    const find = (/** @type {string} */ id) => {
      const t = all().tips.find(x => x.id === id);
      if (!t) throw Object.assign(new Error(`no tip ${id}; tips.list shows them`), { code: "not_found" });
      return t;
    };
    const markShown = (/** @type {import("./check.js").Tip} */ t, /** @type {string} */ surface) => {
      const at = now();
      db.prepare("INSERT INTO tips_shown (id, shows, last_at) VALUES (?, 1, ?) ON CONFLICT (id) DO UPDATE SET shows = shows + 1, last_at = excluded.last_at").run(t.id, at);
      db.prepare("INSERT INTO tips_log (at, surface, id, module) VALUES (?, ?, ?, ?)").run(at, surface, t.id, t.about);
      use(t.about);
    };
    /** What a surface draws. `whatsnew` says it came with an update. */
    const view = (/** @type {import("./check.js").Tip} */ t) => {
      const seen = meta(`seen:${keyOf(t)}`);
      return { id: t.id, module: t.module, about: t.about, text: t.text, level: t.level, since: t.since,
        ...(t.key ? { key: t.key } : {}), ...(t.command ? { command: t.command } : {}), ...(t.docs ? { docs: t.docs } : {}),
        whatsnew: seen !== null && compareVersions(t.since, seen) > 0 };
    };

    ctx.tool("tips.next", {
      description: "The one tip a surface may show now, or none and why (off, busy, gap, spread, cap, none). Pass the surface, and in context the module the person is in, first on the surface's very first open (one welcome tip, once), idle when they have paused, busy while an ask, a prompt or a running turn is on screen. mark: true records it as shown, for a surface that draws it at once (the CLI); otherwise call tips.seen when it is drawn.",
      callers: PEOPLE,
      input: { type: "object", required: ["surface"], properties: {
        surface: surfaceIn, mark: { type: "boolean" },
        context: { type: "object", properties: { module: str, idle: { type: "boolean" }, busy: { type: "boolean" }, first: { type: "boolean" } } } } },
      run: async ({ surface, context = {}, mark = false }) => {
        if (context.module) use(String(context.module));
        const s = state();
        const r = pick({ tips: all().tips, surface, context, now: now(), settings: await readSettings(), ...s,
          welcomed: meta(`welcomed:${surface}`) !== null,
          running: t => runningOf(keyOf(t)), seenVersion: t => meta(`seen:${keyOf(t)}`) });
        // The welcome is spent once offered, drawn or not: a surface's first open happens once.
        if (context.first && meta(`welcomed:${surface}`) === null && r.why !== "busy" && r.why !== "off") setMeta(`welcomed:${surface}`, String(now()));
        if (!r.tip) return { tip: null, why: r.why };
        if (mark) markShown(r.tip, surface);
        return { tip: view(r.tip), why: r.why };
      },
    });

    ctx.tool("tips.seen", {
      description: "A surface drew this tip: it counts toward the gap, the daily cap and the tip's two showings. acted: true when the person followed it (Show me, or ran the command), which retires it.",
      callers: PEOPLE,
      input: { type: "object", required: ["id", "surface"], properties: { id: str, surface: surfaceIn, acted: { type: "boolean" } } },
      run: async ({ id, surface, acted = false }) => {
        const t = find(id);
        markShown(t, surface);
        if (acted) db.prepare("UPDATE tips_shown SET dismissed_at = ? WHERE id = ?").run(now(), t.id);
        return { id: t.id, retired: acted };
      },
    });

    ctx.tool("tips.used", {
      description: "The person used this module (opened its view, ran its verb), without asking for a tip. First-use tips give way to power tips after three uses, and a used module gets no never-used tips.",
      callers: PEOPLE,
      input: { type: "object", required: ["module"], properties: { module: str } },
      run: async ({ module }) => (use(String(module)), { module }),
    });

    ctx.tool("tips.dismiss", {
      description: "Never show this tip again, or with module every tip about that module.",
      callers: PEOPLE,
      input: { type: "object", properties: { id: str, module: str } },
      run: async ({ id, module }) => {
        if (!id && !module) throw Object.assign(new Error("pass id or module"), { code: "bad_input" });
        const list = id ? [find(id)] : all().tips.filter(t => t.about === module);
        const at = now();
        for (const t of list) db.prepare("INSERT INTO tips_shown (id, shows, dismissed_at) VALUES (?, 0, ?) ON CONFLICT (id) DO UPDATE SET dismissed_at = excluded.dismissed_at").run(t.id, at);
        return { dismissed: list.length };
      },
    });

    ctx.tool("tips.whatsnew", {
      description: "Tips that came after the version the person last saw (or after `since`), newest first, for the page `vyre update` prints and the Deck's one quiet card. ack: true records that they saw it, so these stop counting as new.",
      callers: PEOPLE,
      input: { type: "object", properties: { since: str, surface: surfaceIn, ack: { type: "boolean" } } },
      run: async ({ since, surface, ack = false }) => {
        const tips = all().tips.filter(t => {
          const from = since || meta(`seen:${keyOf(t)}`);
          return from !== null && compareVersions(t.since, from) > 0 && compareVersions(t.since, runningOf(keyOf(t))) <= 0 && (!surface || t.surfaces.includes(surface));
        }).sort((a, b) => compareVersions(b.since, a.since) || a.module.localeCompare(b.module) || a.order - b.order);
        const out = { version: vyre(), from: since || meta("seen:vyre"), tips: tips.map(view) };
        if (ack) for (const key of keys) setMeta(`seen:${key}`, runningOf(key));
        return out;
      },
    });

    ctx.tool("tips.list", {
      description: "Every tip the running modules declare, with how often each was shown and whether it was dismissed. For Settings and `vyre tips`.",
      callers: [...PEOPLE, "mcp", "module"],
      input: { type: "object", properties: { module: str, surface: surfaceIn } },
      run: async ({ module, surface }) => {
        const { shown } = state();
        return { tips: all().tips.filter(t => (!module || t.about === module || t.module === module) && (!surface || t.surfaces.includes(surface)))
          .map(t => ({ ...view(t), surfaces: t.surfaces, trigger: t.trigger, shows: shown.get(t.id)?.shows || 0, dismissed: Boolean(shown.get(t.id)?.dismissed) })) };
      },
    });

    ctx.tool("tips.reset", {
      description: "Bring every tip back: forget what was shown, dismissed and used. Settings' \"Show tips again\".",
      callers: PEOPLE,
      input: { type: "object", properties: {} },
      run: async () => {
        db.exec("DELETE FROM tips_shown; DELETE FROM tips_used; DELETE FROM tips_log; DELETE FROM tips_meta WHERE key LIKE 'welcomed:%';");
        return { reset: true };
      },
    });

    return { async stop() { for (const off of [offModules, offSettings]) if (typeof off === "function") off(); } };
  },
};
