// @ts-check
// settings: one way to read and change every setting, at account or project level.
//
// It holds no settings itself. Each module declares its own in module.json ("settings"; the
// shape and the stores are in core/config/settings.js), and this module serves the ones of
// running modules as tools, so the Deck's Settings and `vyre config` are drawn from one list. A
// project's value beats the account's, which beats the default. A session's own chips (model,
// effort, mode) beat all three, but those live with the session, not here.
//
// A person changes settings on their own surfaces, with no confirm step and no presence proof, security
// settings included (the charter's "security without friction", PLAN.md C25): every change is logged
// and can be undone instead. A preview still says what a change loosens or widens, so a surface can
// show it. Agents may read settings, and settings.resolve hands a starting session its Vyre-owned values. An agent changes
// one only through settings.request, and only when the person asked for that change in their own
// words in this conversation (PLAN.md C25 and P17: vault.said.match); otherwise never.
// Every change is logged, and settings.undo reverses one with no prompt.

import fs from "node:fs";
import { coerce, read, write, whereIs, needsConfirm } from "../config/settings.js";
import { claudeHome } from "../config/index.js";
import { readHub, writeHub, hubPath, digest, levelOf } from "./hub.js";
import { withinOrThrow } from "../../lib/within.js";
import { isOwnerDevice } from "../../lib/caller.js";
import { settingTo } from "../../lib/said/setting.js";

const PEOPLE = ["cli", "local", "deck", "capsule"];
const MIGRATIONS = [
  `CREATE TABLE settings_values (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, by TEXT, at INTEGER,
     PRIMARY KEY (scope, key))`,
  // The hub's revision (ADR 0035): one more on every change, whoever made it.
  `CREATE TABLE settings_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  // Every change, so each can be shown ("Changed by kit, just now") and undone without a prompt
  // (PLAN.md C25). prev and next are JSON, or NULL for "no value at this level". Secret keys keep
  // no values here, only that they changed.
  `CREATE TABLE settings_changes (id TEXT PRIMARY KEY, key TEXT NOT NULL, level TEXT NOT NULL, target TEXT,
     prev TEXT, next TEXT, by TEXT NOT NULL, said TEXT, at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0)`,
];
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A device's id: the owner's tailnet node ("tailnet:<login>"), a relay device, or "mac:<host>". */
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9:._@-]{0,127}$/;
/** A thread's id. */
const THREAD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const str = { type: "string" };

// How the groups a module names are shown, in order. A group no one declared doesn't appear; an
// unknown group goes last under its own name.
export const GROUPS = [
  ["models", "Models and thinking"], ["permissions", "Permissions"], ["sessions", "Sessions"], ["teammates", "Teammates"],
  ["notifications", "Notifications"], ["tips", "Tips"], ["appearance", "Appearance"], ["planner", "Planner"], ["memory", "Memory"], ["vault", "Vault"], ["files", "Files and terminal"],
  ["tools", "Tools"], ["updates", "Updates"], ["devices", "Devices"], ["assistant", "Assistant"],
];

/** What a secret setting's value reads as to anyone but the person. */
export const MASK = "•••• set";

/**
 * A secret setting's value as a caller who isn't the person sees it: an object keeps its names
 * with every value masked, anything else is MASK. Unset stays unset; other keys pass through.
 * @param {any} d @param {any} value
 */
export const maskFor = (d, value) => {
  if (!d || !d.secret || value === undefined || value === null) return value;
  if (typeof value === "object" && !Array.isArray(value)) return Object.fromEntries(Object.keys(value).map(k => [k, MASK]));
  return MASK;
};

/**
 * Whether a caller is the person, for reading secret values: one of the person's own surfaces
 * with no agent label, or the owner's device over the tailnet or the relay with a person session.
 * @param {string} caller @param {any} meta
 */
export const isPerson = (caller, meta) => {
  const c = String(caller);
  if (/(?:^|[\s:])agent:/.test(c)) return false;
  if (PEOPLE.includes(c)) return true;
  return isOwnerDevice({ caller: c }) && Boolean(meta && meta.person);
};

/**
 * What settings.changed may say of the new value (ADR 0035): the value at the level that changed,
 * or null for a reset, and nothing at all for a secret key. Events reach agents.
 * @param {any} d @param {any} value
 */
export const said = (d, value) => (d && d.secret ? {} : { value: value === undefined ? null : value });

/** The label another module sees when this one passes a person's change on. @param {string} caller */
export const asPerson = caller => {
  const c = String(caller);
  if (PEOPLE.includes(c)) return c;
  // The owner's own Deck over the tailnet or the relay (it has a person session, or the registry
  // would have refused the call) is the Deck. Nothing else is a person, and never passes as one.
  if (isOwnerDevice({ caller: c })) return "deck";
  throw Object.assign(new Error(`${c} is not a person's surface`), { code: "denied" });
};

/** What a caller may see about one key, without its value. @param {any} d */
export const describe = d => ({
  key: d.key, module: d.module, group: d.group || d.module, label: d.label, ...(d.help ? { help: d.help } : {}), type: d.type,
  ...(d.enum ? { enum: d.enum } : {}), ...(d.labels ? { labels: d.labels } : {}), ...(d.choices ? { choices: d.choices } : {}),
  ...(d.min !== undefined ? { min: d.min } : {}), ...(d.max !== undefined ? { max: d.max } : {}),
  levels: d.levels, apply: d.apply, owner: d.store && d.store.claude ? "C" : "V", ...(d.advanced ? { advanced: true } : {}), ...(d.hidden ? { hidden: true } : {}),
  ...(d.security ? { security: d.security } : {}), ...(d.confirm ? { confirm: d.confirm } : {}), ...(d.loosens ? { loosens: d.loosens } : {}),
  ...(d.default !== undefined ? { default: d.default } : {}), ...(d.secret ? { secret: true } : {}),
});

/** @type {{ start(ctx: any): Promise<{ stop(): Promise<void> }> }} */
export default {
  async start(ctx) {
    /**
     * Is this call the person's own? Decided by the kernel's chain for the call (`ctx.kernel.chain(meta)`: exactly one person hop, no agent), never by the caller's label. Only a build with no kernel
     * (development) falls back to the label rule; a packaged daemon always has the kernel.
     * @param {any} meta @returns {Promise<boolean>}
     */
    const personCall = async meta => {
      if (!ctx.kernel || typeof ctx.kernel.chain !== "function") return isPerson(meta && meta.caller, meta);
      try { const c = await ctx.kernel.chain(meta); return Boolean(c && Array.isArray(c.hops) && c.hops.length === 1 && c.hops[0].actor && c.hops[0].actor.kind === "person"); } catch { return false; }
    };
    ctx.store.migrate(MIGRATIONS);
    const conf = () => (ctx.config && ctx.config.settings) || {};
    /** @returns {any[]} */
    const decls = () => (typeof ctx.declaredSettings === "function" ? ctx.declaredSettings() : []);

    /** @type {import("../config/settings.js").Env} */
    const env = {
      db: ctx.store.db,
      root: ctx.paths.root,
      live: ctx.config,
      call: (tool, input, as) => (as ? ctx.call(tool, input, { as }) : ctx.call(tool, input)),
      // A temp, dev or trial home gets <root>/claude, never the person's ~/.claude (claudeHome).
      claudeDir: () => conf().claude_dir || claudeHome(ctx.paths.root),
      projectHome: async slug => {
        const r = await ctx.call("projects.list", {});
        const list = r && r.data ? (Array.isArray(r.data) ? r.data : r.data.projects) : null;
        const p = Array.isArray(list) ? list.find(x => x && x.slug === slug) : null;
        return p ? String(p.home) : null;
      },
    };

    // ---- where a value lives: a level and its target (ADR 0035) -------------------------------------
    // account has no target; project is a slug, device a device id, session a thread id. A narrower
    // level wins: session > device > project > account > default.
    /** @typedef {"account"|"project"|"device"|"session"} Lv */
    /** @typedef {{ project: string|null, device: string|null, session: string|null }} At */
    const ORDER = /** @type {const} */ (["session", "device", "project", "account"]);
    const targetOf = (/** @type {Lv} */ lv, /** @type {At} */ at) => (lv === "account" ? null : at[lv]);
    const scopeKey = (/** @type {Lv} */ lv, /** @type {string|null} */ target) => (lv === "account" ? "account" : `${lv}:${target}`);

    // ---- the hub file (ADR 0035) ------------------------------------------------------------------
    // settings_values holds what is in effect; hub.json mirrors it for the person to edit. A hand
    // edit is checked like settings.set: plain changes apply, a bad value is kept out and named on
    // its row, and one that needs a confirm or a proof waits for the person (pending).
    const root = ctx.paths.root;
    const meta = (/** @type {string} */ k) => /** @type {any} */ (ctx.store.db.prepare("SELECT v FROM settings_meta WHERE k = ?").get(k))?.v;
    const setMeta = (/** @type {string} */ k, /** @type {string} */ v) => ctx.store.db.prepare("INSERT INTO settings_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
    const rev = () => Number(meta("rev") || 0);
    /** @type {Map<string, string>} */ const hubProblems = new Map();
    /** @type {Map<string, { value: any }>} */ const pending = new Map();
    const pkey = (/** @type {string} */ key, /** @type {Lv} */ lv, /** @type {string|null} */ target) => `${scopeKey(lv, target)}\t${key}`;
    const pendingOf = (/** @type {any} */ d, /** @type {At} */ at, /** @type {(v: any) => any} */ show) => {
      for (const lv of /** @type {const} */ (["device", "project", "account"])) {
        const target = targetOf(lv, at);
        if (lv !== "account" && !target) continue;
        const p = pending.get(pkey(d.key, lv, target));
        if (p) return { pending: { level: lv, ...(target ? { [lv]: target } : {}), value: p.value === undefined ? null : show(p.value), from: "hub.json" } };
      }
      return {};
    };
    let seen = { digest: "", mtime: 0, size: -1 };
    const noteFile = () => { try { const st = fs.statSync(hubPath(root)); seen = { ...seen, mtime: st.mtimeMs, size: st.size }; } catch {} };
    /** Secret keys never go into hub.json, which is plain text and in every backup (e2e review). */
    const secretKeys = () => new Set(decls().filter(d => d.secret).map(d => d.key));
    /** Every Vyre-owned value in effect, as a hub, secret keys left out. */
    const fromTable = () => {
      const secret = secretKeys();
      const h = { account: /** @type {Record<string, any>} */ ({}), projects: /** @type {Record<string, Record<string, any>>} */ ({}), devices: /** @type {Record<string, Record<string, any>>} */ ({}) };
      for (const r of /** @type {any[]} */ (ctx.store.db.prepare("SELECT scope, key, value FROM settings_values ORDER BY scope, key").all())) {
        if (secret.has(String(r.key))) continue;
        const v = JSON.parse(String(r.value)), sc = String(r.scope);
        if (sc === "account") h.account[r.key] = v;
        else if (sc.startsWith("project:")) (h.projects[sc.slice(8)] ||= {})[r.key] = v;
        else if (sc.slice(0, sc.indexOf(":") + 1) === "device:") (h.devices[sc.slice(sc.indexOf(":") + 1)] ||= {})[r.key] = v; // a settings SCOPE ("device:<id>"), not a caller label
      }
      return h;
    };
    const rebuild = (/** @type {import("./hub.js").Hub} */ h) => { const t = fromTable(); h.account = t.account; h.projects = t.projects; h.devices = t.devices; };
    /**
     * The one write of the hub: `change` edits it, rev goes up by one, and the new rev comes back
     * for the event. A file that isn't JSON is moved aside to hub.json.bad and rebuilt from what
     * is in effect, so the person's text is kept and nothing they didn't touch is lost.
     * @param {(h: import("./hub.js").Hub) => void} [change]
     */
    const commit = (change = () => {}) => {
      const next = rev() + 1;
      let broken = false;
      try { readHub(root); } catch { broken = true; }
      if (broken) try { fs.renameSync(hubPath(root), hubPath(root) + ".bad"); } catch {}
      seen.digest = writeHub(root, broken ? rebuild : change, { rev: next }).digest;
      hubProblems.delete("hub.json");
      setMeta("rev", String(next));
      noteFile();
      return next;
    };
    /** A change through settings.set or reset: mirror a hub-held value, bump rev for any other. */
    const mirror = (/** @type {any} */ d, /** @type {Lv} */ lv, /** @type {string|null} */ target, /** @type {any} */ value) => {
      pending.delete(pkey(d.key, lv, target));
      const held = !d.store && !d.secret && lv !== "session";
      return commit(held ? h => { const bag = levelOf(h, lv, target); if (value === undefined) delete bag[d.key]; else bag[d.key] = value; } : undefined);
    };

    // ---- check and choicesFrom: a module's own say, with a deadline --------------------------------
    const DEADLINE = 500;
    const inTime = (/** @type {Promise<any>} */ p, /** @type {string} */ tool) => withinOrThrow(p, DEADLINE, () => Object.assign(new Error(`${tool} took too long`), { code: "bad_input" }));
    /** A key's own check, called as this module: it refuses, never passes by default. */
    const checked = async (/** @type {any} */ d, /** @type {any} */ value, /** @type {Lv} */ lv, /** @type {string|null} */ target) => {
      if (!d.check || !d.check.tool || value === undefined) return;
      const tool = String(d.check.tool);
      const r = await inTime(ctx.call(tool, { key: d.key, value, level: lv, ...(target ? { [lv]: target } : {}) }), tool);
      if (r && r.error) throw Object.assign(new Error(r.error.code === "no_such_tool" ? `${tool} is not running, so ${d.key} can't be checked` : r.error.message), { code: "bad_input" });
      if (!r || !r.data || r.data.ok !== true) throw Object.assign(new Error((r && r.data && r.data.message) || `${tool} refused this value`), { code: "bad_input" });
    };
    /** Choices a module names at run time: [{id, label}] or strings, read by `read`. Null when it can't say. */
    const choicesOf = async (/** @type {any} */ d) => {
      if (!d.choicesFrom || !d.choicesFrom.tool) return null;
      try {
        const r = await inTime(ctx.call(String(d.choicesFrom.tool), {}), String(d.choicesFrom.tool));
        const list = r && r.data ? (d.choicesFrom.read ? String(d.choicesFrom.read).split(".").reduce((/** @type {any} */ x, k) => (x == null ? x : x[k]), r.data) : r.data) : null;
        if (!Array.isArray(list)) return null;
        const items = list.map(x => (typeof x === "string" ? { id: x, label: x } : x && typeof x.id === "string" ? { id: x.id, label: String(x.label || x.id) } : null)).filter(Boolean);
        return /** @type {{ id: string, label: string }[]} */ (items);
      } catch { return null; }
    };

    /** Read a person's edit of hub.json and apply, hold or refuse each change in it. */
    const reconcile = async () => {
      let text = "";
      try { text = fs.readFileSync(hubPath(root), "utf8"); } catch { return; }
      noteFile();
      if (digest(text) === seen.digest) return;
      seen.digest = digest(text);
      let h;
      try { h = readHub(root); } catch (e) { hubProblems.set("hub.json", /** @type {Error} */ (e).message); ctx.log(/** @type {Error} */ (e).message); return; }
      if (!h) return;
      const all = decls();
      const byKey = new Map(all.map(d => [d.key, d]));
      const known = new Set();
      hubProblems.clear();
      /** @type {[Lv, string|null, Record<string, any>][]} */
      const places = [["account", null, h.account],
        ...Object.entries(h.projects).map(([p, bag]) => /** @type {any} */ (["project", p, bag])),
        ...Object.entries(h.devices).map(([p, bag]) => /** @type {any} */ (["device", p, bag]))];
      // A level the file stopped naming has had its values removed: those are resets.
      for (const r of /** @type {any[]} */ (ctx.store.db.prepare("SELECT DISTINCT scope FROM settings_values WHERE scope != 'account'").all())) {
        const [lv, ...rest] = String(r.scope).split(":");
        const target = rest.join(":");
        if ((lv === "project" && !(target in h.projects)) || (lv === "device" && !(target in h.devices))) places.push([/** @type {Lv} */ (lv), target, {}]);
      }
      let changed = 0;
      for (const [lv, target, bag] of places) {
        if (lv === "project" && !SLUG.test(String(target))) { hubProblems.set("hub.json", `hub.json: ${target} is not a project's slug`); continue; }
        if (lv === "device" && !DEVICE.test(String(target))) { hubProblems.set("hub.json", `hub.json: ${target} is not a device id`); continue; }
        for (const k of Object.keys(bag)) {
          const d = byKey.get(k);
          if (!d) hubProblems.set(k, `hub.json: no setting ${k}`);
          else if (d.store) hubProblems.set(k, `hub.json doesn't hold ${k}; it is kept in ${await whereIs(env, d, lv, target)}`);
          else if (!d.levels.includes(lv)) hubProblems.set(k, `hub.json: ${k} isn't set per ${lv}`);
          else if (d.secret) hubProblems.set(k, `hub.json never holds ${k}, a secret; set it in the Deck or with vyre config`);
        }
        for (const d of all) {
          if (d.store || d.secret || !d.levels.includes(lv)) continue;
          const raw = bag[d.key];
          const now = (await level(d, lv, target)).value;
          let value;
          try { value = raw === undefined ? undefined : coerce(d, raw); }
          catch (e) { hubProblems.set(d.key, `hub.json: ${d.key}: ${/** @type {Error} */ (e).message}; ${JSON.stringify(now ?? d.default ?? null)} still applies`); continue; }
          if (JSON.stringify(value) === JSON.stringify(now)) { pending.delete(pkey(d.key, lv, target)); continue; }
          known.add(pkey(d.key, lv, target));
          const held = (value === undefined && d.security === "loosens") || needsConfirm(d, value, now);
          if (held) { pending.set(pkey(d.key, lv, target), { value }); ctx.log(`hub.json asks to ${value === undefined ? "reset" : "change"} ${d.key}; it waits for the person`); continue; }
          try { await checked(d, value, lv, target); }
          catch (e) { hubProblems.set(d.key, `hub.json: ${d.key}: ${/** @type {Error} */ (e).message}`); continue; }
          pending.delete(pkey(d.key, lv, target));
          await write(env, d, lv, target, value, "local", "hub.json");
          const r = rev() + 1;
          setMeta("rev", String(r));
          changed++;
          ctx.events.emit("settings.changed", { key: d.key, level: lv, ...(target ? { [lv]: target } : {}), apply: d.apply, rev: r, by: "hub.json", ...said(d, value) });
          ctx.log(`${d.key} ${value === undefined ? "reset" : "set"} at ${lv}${target ? " " + target : ""} from hub.json`);
        }
      }
      // A pending ask the file no longer makes goes too.
      for (const k of [...pending.keys()]) if (!known.has(k)) pending.delete(k);
      return changed;
    };
    /** A missed file event is caught on the next read: the file's size or mtime moved. */
    const fresh = async () => {
      let st;
      try { st = fs.statSync(hubPath(root)); } catch { return; }
      if (st.mtimeMs !== seen.mtime || st.size !== seen.size) await reconcile();
    };
    /** @param {string} key */
    const declOf = key => {
      const d = decls().find(x => x.key === key);
      if (!d) throw Object.assign(new Error(`no setting ${key}; settings.schema or vyre config list shows them all`), { code: "not_found" });
      return d;
    };
    /** @param {any} project */
    const slugOf = project => {
      if (project == null || project === "") return null;
      if (!SLUG.test(String(project))) throw Object.assign(new Error("project is a project's slug"), { code: "bad_input" });
      return String(project);
    };
    /**
     * Where a call looks: its project, its device (the caller's own when it names none: the
     * owner's tailnet node or a relay-paired device), and its session.
     * @param {any} i @param {any} meta @returns {At & { ownDevice: boolean }}
     */
    const atOf = async (i, meta) => {
      const project = slugOf(i.project);
      let device = i.device == null || i.device === "" ? null : String(i.device);
      if (device && !DEVICE.test(device)) throw Object.assign(new Error("device is a device's id"), { code: "bad_input" });
      const caller = String((meta && meta.caller) || "");
      const own = !device && isOwnerDevice({ caller }) && (await personCall(meta));
      if (own) device = caller;
      const session = i.session == null || i.session === "" ? null : String(i.session);
      if (session && !THREAD.test(session)) throw Object.assign(new Error("session is a thread's id"), { code: "bad_input" });
      return { project, device, session, ownDevice: own };
    };

    /** One level's stored value, or undefined, and why it couldn't be read. */
    const level = async (/** @type {any} */ d, /** @type {Lv} */ lv, /** @type {string|null} */ target) => {
      if (!d.levels.includes(lv) || (lv !== "account" && !target)) return { value: undefined };
      try { return { value: await read(env, d, lv, target) }; }
      catch (e) { return { value: undefined, error: /** @type {any} */ (e).code || "failed", message: /** @type {Error} */ (e).message }; }
    };

    /**
     * The value in effect and where it came from. A secret key's values are masked unless the
     * caller is the person (clear: true).
     * @param {any} d @param {At} at
     */
    const effective = async (d, at, clear = true) => {
      const got = await Promise.all(ORDER.map(lv => level(d, lv, targetOf(lv, at))));
      const by = Object.fromEntries(ORDER.map((lv, n) => [lv, got[n]]));
      const show = (/** @type {any} */ v) => (clear ? v : maskFor(d, v));
      const win = ORDER.find(lv => by[lv].value !== undefined);
      const value = show(win ? by[win].value : d.default);
      const source = win || (d.default !== undefined ? "default" : "unset");
      const bad = got.find(g => g.error && g.error !== "unavailable");
      const unavailable = got.some(g => g.error === "unavailable");
      return {
        ...describe(d), value, source,
        ...Object.fromEntries(ORDER.filter(lv => by[lv].value !== undefined).map(lv => [lv, show(by[lv].value)])),
        ...(at.device && d.levels.includes("device") ? { device_id: at.device } : {}),
        available: !unavailable,
        ...(bad ? { problem: bad.message } : hubProblems.has(d.key) ? { problem: hubProblems.get(d.key) } : {}),
        ...pendingOf(d, at, show),
      };
    };

    // First start: the file is made from what is in effect. Later starts read the person's edits
    // made while vyred was off.
    if (!fs.existsSync(hubPath(root))) commit(rebuild);
    else await reconcile();
    let timer = /** @type {any} */ (null);
    /** @type {fs.FSWatcher|null} */ let watcher = null;
    try {
      watcher = fs.watch(root, (_ev, name) => {
        if (name !== "hub.json") return;
        clearTimeout(timer);
        timer = setTimeout(() => { reconcile().catch(e => ctx.log(`hub.json: ${/** @type {Error} */ (e).message}`)); }, 120);
        timer.unref?.();
      });
      watcher.on("error", () => {});
    } catch {}

    // A thread's own chips change in sessions (Shift+Tab, the model picker): the hub says so too,
    // as the session level, so a surface follows one event for every level (ADR 0035). Which
    // setting a chip is comes from the sessions module's declarations, never from here.
    const CHIPS = /** @type {Record<string, [string, string]>} */ ({ "model.switched": ["sessions.model", "model"], "effort.switched": ["sessions.effort", "effort"],
      "thinking.switched": ["sessions.thinking", "on"], "mode.changed": ["sessions.mode", "mode"] });
    const offChips = ctx.events.on("*", (/** @type {any} */ e) => {
      const chip = CHIPS[e && e.type];
      if (!chip || !e.thread) return;
      const d = decls().find(x => x.key === chip[0]);
      if (!d) return;
      const r = rev() + 1;
      setMeta("rev", String(r));
      const v = e.payload ? e.payload[chip[1]] : undefined;
      ctx.events.emit("settings.changed", { key: d.key, level: "session", session: String(e.thread), apply: d.apply, rev: r, by: "session", ...said(d, v) });
    });

    /** A key as the schema shows it, with the choices its module names now. */
    const described = async (/** @type {any} */ d) => {
      const out = describe(d);
      const items = await choicesOf(d);
      if (items) return { ...out, type: out.type === "string" ? "enum" : out.type, enum: items.map(x => x.id), labels: Object.fromEntries(items.map(x => [x.id, x.label])) };
      return d.choicesFrom ? { ...out, choices_unavailable: true } : out;
    };

    ctx.tool("settings.schema", {
      effect: "read",
      description: "Every setting the running modules declare, with its key, group, type, choices, settable levels, when a change applies, and whether changing it loosens security.",
      input: { type: "object", properties: {} },
      run: async () => {
        await fresh();
        const keys = await Promise.all(decls().map(described));
        const known = new Map(GROUPS);
        const used = [...new Set(keys.map(k => k.group))];
        const groups = [...GROUPS.filter(([id]) => used.includes(id)), ...used.filter(g => !known.has(g)).map(g => [g, g])];
        return { groups: groups.map(([id, label]) => ({ id, label })), keys,
          hub: { file: hubPath(root), rev: rev(), ...(hubProblems.has("hub.json") ? { problem: hubProblems.get("hub.json") } : {}) } };
      },
    });

    const where = { project: { type: "string", description: "scope to this project" }, device: { type: "string", description: "defaults to the caller's own" }, session: { type: "string", description: "scope to this session" } };
    ctx.tool("settings.get", {
      description: "Settings, each with the value in effect and its source. Give key for one, group for a group, nothing for all. Secrets are masked.",
      input: { type: "object", properties: { key: str, group: str, ...where } },
      run: async (i, meta) => {
        const at = await atOf(i, meta);
        const clear = await personCall(meta);
        await fresh();
        if (i.key) return effective(declOf(i.key), at, clear);
        const list = decls().filter(d => !i.group || (d.group || d.module) === i.group);
        return { project: at.project, ...(at.device ? { device: at.device } : {}), settings: await Promise.all(list.map(d => effective(d, at, clear))) };
      },
    });

    ctx.tool("settings.snapshot", {
      description: "Every setting's value in effect for one surface: values, sources, levels and a rev. Compare rev after a reconnect, then follow settings.changed. Secrets masked.",
      input: { type: "object", properties: where },
      run: async (i, meta) => {
        const at = await atOf(i, meta);
        const clear = await personCall(meta);
        await fresh();
        const rows = await Promise.all(decls().map(d => effective(d, at, clear)));
        /** @type {Record<string, any>} */ const values = {}, sources = {}, levels = {};
        for (const r of rows) {
          if (r.value === undefined) continue;
          values[r.key] = r.value;
          sources[r.key] = r.source;
          const own = Object.fromEntries(ORDER.filter(lv => r[lv] !== undefined).map(lv => [lv, r[lv]]));
          if (Object.keys(own).length) levels[r.key] = own;
        }
        return { rev: rev(), device: at.device, ...(at.project ? { project: at.project } : {}), ...(at.session ? { session: at.session } : {}), values, sources, levels };
      },
    });

    /**
     * @param {any} i @param {any} meta @param {any} raw the new value, undefined to reset
     * @param {{ said?: string, ask?: (to: string) => Promise<string | null>, refusal?: string }} [o] settings.request passes `ask`: it matches the person's words to the change once its level, target and value are known, and returns the intent that covered it
     */
    const change = async (i, meta, raw, o = {}) => {
      const caller = String(meta && meta.caller);
      let intent = typeof o.said === "string" && o.said !== "" ? o.said : "";
      const asked = intent !== "" || typeof o.ask === "function";
      // A caller vouched as an agent ("cli agent:kit", "mcp:agent:kit") is never the person,
      // whatever surface kind it rides on. It changes a setting only through settings.request.
      if (!asked && /(?:^|[\s:])agent:/.test(caller)) throw Object.assign(new Error("settings are the person's own; an agent never changes one"), { code: "denied" });
      const d = declOf(i.key);
      const at = await atOf(i, meta);
      // A level said, or the narrowest one this call names: a session, a device named outright
      // (never the caller's own by default), a project, else the account.
      const lv = /** @type {Lv} */ (i.level || (at.session && d.levels.includes("session") ? "session"
        : at.device && !at.ownDevice && d.levels.includes("device") ? "device"
        : at.project && d.levels.includes("project") ? "project" : "account"));
      if (!d.levels.includes(lv)) throw Object.assign(new Error(`${d.key} is set at ${d.levels.join(" or ")} level, not ${lv}`), { code: "bad_input" });
      const target = targetOf(lv, at);
      if (lv !== "account" && !target) throw Object.assign(new Error(`a ${lv} setting needs ${lv}`), { code: "bad_input" });
      const value = raw === undefined ? undefined : coerce(d, raw);
      if (o.ask) {
        // The recorder writes account and project asks with a value; a reset, a device or a session change is never recorded, so it is never covered.
        if (raw === undefined || (lv !== "account" && lv !== "project")) throw Object.assign(new Error(o.refusal || "the person did not ask for this change"), { code: "denied" });
        intent = (await o.ask(settingTo({ key: d.key, value, level: lv, target: target == null ? undefined : String(target) }))) || "";
        if (!intent) throw Object.assign(new Error(o.refusal || "the person did not ask for this change"), { code: "denied" });
      }
      const whereTo = await whereIs(env, d, lv, target);
      const before = await level(d, lv, target);
      const tag = target ? { [lv]: target } : {};
      // What would change, for the person to see first. Nothing is written.
      if (i.preview) return { key: d.key, level: lv, ...tag, where: whereTo, before: before.value, after: value,
        ...(needsConfirm(d, value, before.value) ? { confirm: d.loosens || `This lets Claude do more without asking: ${d.label}.` } : {}) };
      await checked(d, value, lv, target);
      // A change the person asked an agent for is still the person's: stores that call a module's
      // setter call it as vyred acting for them ("local"), and the log names the agent.
      await write(env, d, lv, target, value, asked ? "local" : ((await personCall(meta)) ? asPerson(caller) : (() => { throw Object.assign(new Error(`${caller} is not a person's surface`), { code: "denied" }); })()), caller);
      const r = mirror(d, lv, target, value);
      const id = logChange(d, lv, target, before.value, value, caller, asked ? intent : null);
      ctx.events.emit("settings.changed", { key: d.key, level: lv, ...tag, apply: d.apply, rev: r, change: id, by: asked ? caller : "person", ...said(d, value) });
      // An agent changed a guard because the person asked: asking is approving, so there is no confirm, but the person is
      // always told, loudly, with an Undo that needs no proof (settings.undo). The event never carries a value.
      if (asked && (needsConfirm(d, value, before.value) || (value === undefined && d.security === "loosens"))) {
        ctx.events.emit("settings.loosened", { change: id, key: d.key, label: String(d.label || d.key).slice(0, 80), level: lv, ...tag, by: caller, said: intent });
      }
      ctx.log(`${d.key} ${raw === undefined ? "reset" : "set"} at ${lv}${target ? " " + target : ""} by ${caller} (${whereTo})`);
      return effective(d, at);
    };

    /** Record one change; its id. Secret keys record that they changed, never their values. */
    const logChange = (/** @type {any} */ d, /** @type {string} */ lv, /** @type {any} */ target, /** @type {any} */ prev, /** @type {any} */ next, /** @type {string} */ by, /** @type {string|null} */ saidId) => {
      const id = "chg_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      const js = (/** @type {any} */ v) => d.secret || v === undefined ? null : JSON.stringify(v);
      ctx.store.db.prepare("INSERT INTO settings_changes (id, key, level, target, prev, next, by, said, at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, d.key, lv, target == null ? null : String(target), js(prev), js(next), by, saidId, Date.now());
      return id;
    };

    const LEVEL = { type: "string", enum: ["account", "project", "device", "session"] };

    ctx.tool("settings.set", {
      effect: "write",
      description: "Change a setting at account level, or for one project, device or session (give it). The value is checked against the setting's type, and by its module when it names a check. preview: true returns what would change and writes nothing, with confirm naming what it widens or loosens. No confirm step and no proof: every change is logged (settings.changes) and can be undone (settings.undo). Returns the value now in effect.",
      input: { type: "object", required: ["key", "value"], properties: { key: str, value: {}, level: LEVEL, ...where,
        preview: { type: "boolean" }, confirm: { type: "boolean" } } },
      callers: PEOPLE,
      run: async (i, meta) => {
        if (i.value === null) throw Object.assign(new Error("use settings.reset to remove a value"), { code: "bad_input" });
        return change(i, meta, i.value);
      },
    });

    ctx.tool("settings.reset", {
      effect: "write",
      description: "Remove a setting's value at one level, so the next level down (then the default) applies again. Logged and undoable like settings.set.",
      input: { type: "object", required: ["key"], properties: { key: str, level: LEVEL, ...where, preview: { type: "boolean" }, confirm: { type: "boolean" } } },
      callers: PEOPLE,
      run: async (i, meta) => change(i, meta, undefined),
    });

    // An agent changing a setting for the person (PLAN.md C25): only when the person asked for this
    // change in their own words in this conversation. vyred decides that from the person's own
    // turns (P17), never from the agent's say-so: vault.said.match answers for the calling thread.
    // No match, or no gate to ask: refused, and the agent tells the person to ask.
    ctx.tool("settings.request", {
      description: "Change or reset a setting the person asked you to in this conversation. Refused unless their own words asked for it.",
      input: { type: "object", required: ["key"], properties: { key: str, value: { description: "the new value; leave out with reset" }, reset: { type: "boolean", description: "true clears the setting instead of setting value" }, level: LEVEL, ...where } },
      callers: ["mcp"],
      run: async (i, meta) => {
        const refuse = (/** @type {string} */ m) => { throw Object.assign(new Error(m), { code: "denied" }); };
        const thread = meta && typeof meta.thread === "string" && meta.thread ? meta.thread : null;
        if (!thread) refuse("settings.request works only inside a conversation with the person");
        const d = declOf(String(i.key));
        if (i.reset !== true && !("value" in i)) throw Object.assign(new Error("give value, or reset: true"), { code: "bad_input" });
        if (i.reset !== true && i.value === null) throw Object.assign(new Error("use reset: true to clear a setting"), { code: "bad_input" });
        if (d.secret) refuse(`${d.label || d.key} holds a secret; the person changes it in Settings`);
        // The match is made inside change(), once the level, the project and the value are resolved: the person's words must name the key, the value and the level, and a plain ask is used up by this one change (consume).
        const ask = async (/** @type {string} */ to) => {
          /** @type {string[]} */ let lineage = [];
          try { const l = await ctx.call("threads.lineage", { thread }); if (l && l.data && Array.isArray(l.data.lineage)) lineage = l.data.lineage.map(String); } catch {}
          const agent = meta && typeof (/** @type {any} */ (meta)).agent === "string" ? (/** @type {any} */ (meta)).agent : "";
          const m = await ctx.call("vault.said.match", { kind: "setting", to: [to], consume: true, thread, ...(lineage.length ? { lineage } : {}), ...(agent ? { agent } : {}) }).catch(() => ({ error: { code: "unavailable" } }));
          return !m.error && m.data && m.data.matched === true && typeof m.data.id === "string" ? m.data.id : null;
        };
        const { reset, ...rest } = i;
        return change({ ...rest, preview: false }, meta, reset === true ? undefined : i.value, { ask, refusal: `${d.label || d.key} changes only when the person asks for it, to that value and at that level. Tell them they can change it in Settings, or ask you to in their own words.` });
      },
    });

    // Undo one change: the value before it comes back at the same level, with no prompt (C25).
    ctx.tool("settings.undo", {
      effect: "write",
      description: "Undo one settings change (its id from settings.changed or settings.changes): the value before it comes back at the same level. No confirm and no proof.",
      input: { type: "object", required: ["change"], properties: { change: str } },
      callers: PEOPLE,
      run: async (i, meta) => {
        const row = /** @type {any} */ (ctx.store.db.prepare("SELECT * FROM settings_changes WHERE id = ?").get(String(i.change)));
        if (!row) throw Object.assign(new Error(`no change ${i.change}; settings.changes lists them`), { code: "not_found" });
        if (row.undone) throw Object.assign(new Error("that change is already undone"), { code: "bad_input" });
        const d = declOf(row.key);
        if (d.secret) throw Object.assign(new Error(`${d.key} is secret; set it again in Settings`), { code: "bad_input" });
        const at = { [row.level]: row.target };
        const prev = row.prev === null ? undefined : JSON.parse(row.prev);
        const r = await change({ key: row.key, level: row.level, ...(row.target ? at : {}), confirm: true }, meta, prev);
        ctx.store.db.prepare("UPDATE settings_changes SET undone = 1 WHERE id = ?").run(row.id);
        return r;
      },
    });

    // Recent changes, newest first: what the Deck shows as "Changed by <who>, <when>" with Undo.
    ctx.tool("settings.changes", {
      effect: "read",
      description: "Recent settings changes, newest first: {id, key, level, target, by, said, at, undone}. Give key for one setting's history.",
      input: { type: "object", properties: { key: str, limit: { type: "number" } } },
      run: async (i) => {
        const limit = Math.min(Math.max(Number(i.limit) || 20, 1), 200);
        const rows = i.key ? ctx.store.db.prepare("SELECT id, key, level, target, by, said, at, undone FROM settings_changes WHERE key = ? ORDER BY at DESC LIMIT ?").all(String(i.key), limit)
          : ctx.store.db.prepare("SELECT id, key, level, target, by, said, at, undone FROM settings_changes ORDER BY at DESC LIMIT ?").all(limit);
        return rows.map((/** @type {any} */ r) => ({ ...r, undone: Boolean(r.undone) }));
      },
    });

    // A module writing its own settings (ADR 0033), the only path that isn't a person's. It is
    // narrow on purpose: the calling module's own "<module>." keys, kept in Vyre's settings table
    // only, never a key that asks for a confirm or loosens security. A key kept in config.json,
    // Claude Code's files or a tool is refused, since writing those reaches past the module's own
    // rows (a tool store is called as the person). It never goes through change(), so none of
    // that can be reached from here.
    ctx.tool("settings.write", {
      description: "A module sets or clears one of its own settings (kept by Vyre, no confirm, not loosening security). Modules only.",
      internal: true,
      callers: ["module"],
      input: { type: "object", required: ["key"], properties: { key: str, value: {}, level: { type: "string", enum: ["account", "project"] }, project: str } },
      run: async (i, { caller }) => {
        const who = String(caller);
        const mod = who.startsWith("module:") ? who.slice("module:".length) : null;
        const refuse = (/** @type {string} */ m) => { throw Object.assign(new Error(m), { code: "denied" }); };
        if (!mod) refuse("settings.write is for modules");
        if (!String(i.key).startsWith(mod + ".")) refuse(`${mod} may write only its own settings (${mod}.*)`);
        const d = declOf(i.key);
        if (d.module !== mod) refuse(`${i.key} is declared by ${d.module}, not ${mod}`);
        if (d.store) refuse(`${d.key} is kept outside Vyre's settings table; only the person changes it`);
        if (d.confirm || d.security === "loosens") refuse(`${d.key} needs the person's confirm; only the person changes it`);
        const project = slugOf(i.project);
        const lv = i.level || (project && d.levels.includes("project") ? "project" : "account");
        if (!d.levels.includes(lv)) throw Object.assign(new Error(`${d.key} is set at ${d.levels.join(" or ")} level, not ${lv}`), { code: "bad_input" });
        if (lv === "project" && !project) throw Object.assign(new Error("a project setting needs project"), { code: "bad_input" });
        const value = i.value === undefined || i.value === null ? undefined : coerce(d, i.value);
        const target = lv === "project" ? project : null;
        // The key's own check tool (ADR 0035) holds a module's write to what it holds the person's.
        await checked(d, value, lv, target);
        await write(env, d, lv, target, value, who, who);
        // The same record and event as a person's change: the hub's new rev, and the value only
        // for a key that isn't secret.
        const rev = mirror(d, lv, target, value);
        ctx.events.emit("settings.changed", { key: d.key, level: lv, ...(target ? { project: target } : {}), apply: d.apply, rev, ...said(d, value), by: who });
        ctx.log(`${d.key} ${value === undefined ? "reset" : "set"} at ${lv}${target ? " " + target : ""} by ${who}`);
        return effective(d, { project, device: null, session: null, ownDevice: false }, false);
      },
    });

    ctx.tool("settings.resolve", {
      description: "The Vyre-owned values a session starting now in this project should use, as {key: value}. Unset keys are left out.",
      internal: true,
      input: { type: "object", properties: { project: str } },
      run: async i => {
        const at = { project: slugOf(i.project), device: null, session: null };
        await fresh();
        const rows = await Promise.all(decls().filter(d => !(d.store && d.store.claude)).map(d => effective(d, at)));
        return Object.fromEntries(rows.filter(r => r.value !== undefined).map(r => [r.key, r.value]));
      },
    });

    return { async stop() { clearTimeout(timer); watcher?.close(); if (typeof offChips === "function") offChips(); } };
  },
};
