// @ts-check
// sidebar: the lists behind the app's sidebar (SPEC-0.3.0 part 9; the rules are lib/sidebar/model.js, shared with the app).
//
// Two kinds of list are kept here, in this module's own table:
//   the Space's default   by Space: { "<space id>": [entry, ...] }, "*" for every Space with none of its own. Set by the Space's OWNER or ADMIN role.
//   a person's own list   one per person, laid over the default; the same on every device (there is no sidebar per device). The box's own person is "self"; a visiting member is their id.
// The settings hub reads and writes them as ordinary settings (a tool store, like the planner's): `sidebar.default` and `sidebar.mine` (the box person's own list, as { entries }).
// With nothing stored the built-in places are the default (PLACES, the app's old NAV).
//
// sidebar.get   the default for a Space, the caller's own list, the two merged, and the module screens installed here with their own origin (from their manifests' `screens`; appmods.origin).
// sidebar.edit  one change to the caller's OWN list: add, remove, hide, show, move, group or set. An assistant may make it at once ("put Documents in my sidebar").
// sidebar.team  the same changes to the Space's default. Only the Space's owner or admin role (the person at their own surface; a visiting member needs the role). It is a held change for an
//               assistant (ASK_FIRST): the person says yes before it happens.
// A module screen that is not installed is not drawn and not an error; a stored list is cleaned on every read and write.

import { isPerson, isSpaceMember } from "../../lib/caller.js";
import { builtinEntries, cleanList, merge, keyOf, find, add, remove, setHidden, move, moveBefore, setGroup, MAX_ENTRIES } from "../../lib/sidebar/model.js";

const MIGRATIONS = [`CREATE TABLE sidebar_lists (k TEXT PRIMARY KEY, v TEXT NOT NULL)`];
const SPACE = /^(\*|spc_[a-z2-7]{12}|[a-z0-9][a-z0-9._-]{0,63})$/;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const str = { type: "string" };
/** Who may call: the person's surfaces and devices, a visiting member, and an assistant (a model session or the harness). What each may change is checked in the tool. */
const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "space", "module", "mcp", "harness"];
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

const EDIT_PROPS = { op: { type: "string", enum: ["add", "remove", "hide", "show", "move", "group", "set"] }, entries: { type: "array" }, what: str, key: str, entry: {}, space: str, group: { type: ["string", "null"] }, before: str, index: { type: "number" } };

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const read = (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM sidebar_lists WHERE k = ?").get(k)); try { return r ? JSON.parse(String(r.v)) : null; } catch { return null; } };
    const write = (/** @type {string} */ k, /** @type {any} */ v) => {
      if (v === null || v === undefined || (Array.isArray(v) && !v.length && k.startsWith("mine:"))) db.prepare("DELETE FROM sidebar_lists WHERE k = ?").run(k);
      else db.prepare("INSERT INTO sidebar_lists (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
    };
    /** The Space defaults as a map of cleaned lists. */
    const defaults = () => {
      const raw = read("default");
      /** @type {Record<string, any[]>} */ const out = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) for (const [sp, list] of Object.entries(raw)) if (SPACE.test(sp)) { const l = cleanList(list); if (l.length) out[sp] = l; }
      return out;
    };
    const defaultFor = (/** @type {string} */ space) => { const d = defaults(); return d[space] || d["*"] || null; };
    /** The person whose list a call reads and writes: a visiting member is their id, the box's own person is "self". */
    const personOf = (/** @type {any} */ meta) => {
      const m = isSpaceMember(meta) ? /^space:([^@]+)@/.exec(String((meta && meta.caller) || "")) : null;
      return m && PERSON.test(m[1]) ? m[1] : "self";
    };
    const mineOf = (/** @type {string} */ who) => cleanList(read(`mine:${who}`));
    /** The module screens installed here, from their manifests, each with the origin it is served on (appmods.origin) when that is known. */
    const modules = async () => {
      /** @type {any[]} */ const out = [];
      for (const m of ctx.modules.status()) {
        if (m.state !== "running" || !Array.isArray(m.screens)) continue;
        const screens = m.screens.filter((/** @type {any} */ s) => s && typeof s.id === "string" && typeof s.label === "string").slice(0, 40).map((/** @type {any} */ s) => ({ id: s.id, label: String(s.label).slice(0, 40), ...(s.icon ? { icon: String(s.icon) } : {}), ...(s.path ? { path: String(s.path) } : {}) }));
        if (!screens.length) continue;
        let origin = null;
        try { const o = /** @type {any} */ (await ctx.call("appmods.origin", { module: m.name })); if (o && !o.error && o.data && typeof o.data.origin === "string" && /^https:\/\//.test(o.data.origin)) origin = o.data.origin; } catch { /* no app-module host on this box */ }
        out.push({ module: m.name, label: m.name, screens, ...(origin ? { origin } : {}) });
      }
      return out;
    };
    const spaceArg = (/** @type {any} */ i) => { const s = i && i.space === undefined ? "*" : String(i.space); if (!SPACE.test(s)) throw refuse("That is not a Space.", "bad_input"); return s; };

    /**
     * May this caller set the Space's default? The person at their own surface (the Space's owner on this box), or a visiting member whose role in that Space is owner or admin. A member, a manager, a
     * temp, a model and any other caller may not.
     */
    const mayDefault = async (/** @type {any} */ meta, /** @type {string} */ space) => {
      if (isPerson(meta)) return true;
      if (!isSpaceMember(meta)) return false;
      const m = /^space:([^@]+)@(.+)$/.exec(String((meta && meta.caller) || ""));
      if (!m) return false;
      const sp = space === "*" ? m[2] : space;
      if (sp !== m[2]) return false;
      try {
        const r = /** @type {any} */ (await ctx.call("spaces.membership", { space: sp, person: m[1] }));
        const role = r && !r.error && r.data ? String(r.data.role || (r.data.membership && r.data.membership.role) || "") : "";
        return role === "owner" || role === "admin";
      } catch { return false; }
    };

    // The settings hub's store for sidebar.default and sidebar.mine: no `value` reads, a `value` writes. The hub is the box person's own act, so there is no further check here.
    ctx.tool("sidebar.stored", {
      effect: "write",
      description: "The stored lists behind the settings sidebar.default and sidebar.mine. Called by the settings hub as its store: with no value it reads { value }, with a value it keeps it (cleaned) and answers { value }.",
      input: { type: "object", properties: { key: { type: "string", enum: ["default", "mine"] }, value: {} }, required: ["key"] },
      run: async (/** @type {any} */ i) => {
        if (i.key !== "default" && i.key !== "mine") throw refuse("key is default or mine", "bad_input");
        const shown = () => (i.key === "default" ? defaults() : { entries: mineOf("self") });
        if (!("value" in i)) return { value: shown() };
        if (i.key === "mine") write("mine:self", cleanList(i.value));
        else {
          if (i.value !== null && (typeof i.value !== "object" || Array.isArray(i.value))) throw refuse("sidebar.default is an object by Space", "bad_input");
          const d = {}; for (const [sp, l] of Object.entries(i.value || {})) { if (!SPACE.test(sp)) throw refuse(`${sp} is not a Space`, "bad_input"); const c = cleanList(l); if (c.length) /** @type {any} */ (d)[sp] = c; }
          write("default", Object.keys(d).length ? d : null);
        }
        ctx.events.emit("sidebar.changed", { scope: i.key });
        return { value: shown() };
      },
    });

    ctx.tool("sidebar.get", {
      effect: "read", callers: WHO,
      description: "The sidebar for a Space: the Space's default (null when none is stored, then the built-in places stand), the caller's own list, the two merged, whether the caller may set the default, and the installed module screens that can be added.",
      input: { type: "object", properties: { space: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        const sp = spaceArg(i);
        const def = defaultFor(sp), own = mineOf(personOf(meta));
        return { space: sp, default: def, mine: own, entries: merge(def || builtinEntries(), own), modules: await modules(), can_set_default: await mayDefault(meta, sp) };
      },
    });

    /** One change to a list: `cur` is the list as it stands. */
    const apply = async (/** @type {any} */ i, /** @type {any[]} */ cur, /** @type {string} */ sp) => {
      const cat = { modules: await modules() };
      if (i.op === "set") {
        const next = cleanList(i.entries);
        if (!next.length) throw refuse("A sidebar needs at least one entry.", "bad_input");
        return { next, key: null };
      }
      const views = [...(defaultFor(sp) || []), ...mineOf("self")].filter(e => e.kind === "view");
      // Which entry the person means: a key, an entry, or a name (the assistant's "Documents").
      let target = null;
      if (typeof i.key === "string") target = cur.find(e => keyOf(e) === i.key) || null;
      if (!target && i.entry) target = cleanList([i.entry])[0] || null;
      if (!target && typeof i.what === "string") {
        const f = find(i.what, cat, /** @type {any} */ (views));
        if (!f) throw refuse(`I could not tell which one "${i.what}" is: nothing has that name, or more than one does.`, "not_found");
        target = f.entry;
      }
      if (!target) throw refuse("Say which entry: its name, or its key.", "bad_input");
      const key = keyOf(target);
      if (i.op === "add" && target.kind === "module" && !cat.modules.some(m => m.module === target.module && m.screens.some((/** @type {any} */ s) => s.id === target.screen))) throw refuse("That screen is not installed here.", "not_found");
      let next;
      switch (i.op) {
        case "add": next = add(cur, target, i.group ? { group: String(i.group) } : {}); break;
        case "remove": next = remove(cur, key); break;
        case "hide": next = setHidden(cur, key, true); break;
        case "show": next = setHidden(cur, key, false); break;
        case "group": next = setGroup(cur, key, i.group === null || i.group === undefined ? null : String(i.group)); break;
        case "move":
          if (typeof i.before === "string") next = moveBefore(cur, key, i.before);
          else if (typeof i.index === "number") next = move(cur, key, i.index);
          else throw refuse("move needs before or index", "bad_input");
          break;
        default: throw refuse("op is add, remove, hide, show, move, group or set", "bad_input");
      }
      if (next.length > MAX_ENTRIES) throw refuse("The sidebar is full.", "bad_input");
      return { next, key };
    };

    ctx.tool("sidebar.edit", {
      effect: "write", callers: WHO,
      description: "Change the caller's OWN sidebar by one step. op is add (what: a place's or screen's name, or entry), remove, hide, show, move (before: another entry's key, or index), group (group: a name, or null) or set (entries: the whole list, from the app's drag and drop). \"Put Documents in my sidebar\" is { op: \"add\", what: \"Documents\" }. The Space's default is sidebar.team.",
      input: { type: "object", required: ["op"], properties: EDIT_PROPS },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        const sp = spaceArg(i), who = personOf(meta);
        const cur = merge(defaultFor(sp) || builtinEntries(), mineOf(who));
        const { next, key } = await apply(i, cur, sp);
        write(`mine:${who}`, next);
        ctx.events.emit("sidebar.changed", { scope: "mine", op: i.op, ...(key ? { key } : {}) });
        return { ok: true, key, scope: "me", entries: next };
      },
    });

    ctx.tool("sidebar.team", {
      effect: "write", callers: WHO,
      description: "Change the Space's DEFAULT sidebar by one step (the same ops as sidebar.edit). Only the Space's owner or admin role may; an assistant's request is held for their yes first.",
      input: { type: "object", required: ["op"], properties: EDIT_PROPS },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        const sp = spaceArg(i);
        if (!(await mayDefault(meta, sp))) throw refuse("Only an owner or an admin of this Space sets the team's sidebar. You can arrange your own.", "denied");
        const cur = defaultFor(sp) || builtinEntries();
        const { next, key } = await apply(i, cur, sp);
        const d = defaults(); d[sp] = next; write("default", d);
        ctx.events.emit("sidebar.changed", { scope: "default", op: i.op, ...(key ? { key } : {}) });
        return { ok: true, key, scope: "team", entries: next };
      },
    });
    return {};
  },
};
