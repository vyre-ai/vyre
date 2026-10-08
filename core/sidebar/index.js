// @ts-check
// sidebar: the lists behind the app's sidebar (SPEC-0.3.0 part 9; the rules are lib/sidebar/model.js, shared with the app).
//
// Two lists are kept here, in this module's own table, and the settings hub reads and writes them as ordinary settings (a tool store, like the planner's):
//   sidebar.default   the Space's default, by Space: { "<space id>": [entry, ...] }, "*" for every Space with none of its own. An admin sets it.
//   sidebar.mine      this person's own arrangement as { entries: [...] }, laid over the default. The same on every device (there is no sidebar per device).
// With nothing stored the built-in places are the default (PLACES, the app's old NAV).
//
// sidebar.get   the default for a Space, the person's list, the two merged, and the module screens installed here (from their manifests' `screens`).
// sidebar.edit  one change for the assistant or the app: add, remove, hide, show, move or group an entry, for "me" or for "team" (the Space default; only the person at their own
//               surface, never an assistant). "put Documents in my sidebar" is { op: "add", what: "Documents" }.
// A module screen that is not installed is not drawn and not an error; a stored list is cleaned on every read and write.

import { isPerson } from "../../lib/caller.js";
import { builtinEntries, cleanList, merge, keyOf, find, add, remove, setHidden, move, moveBefore, setGroup, MAX_ENTRIES } from "../../lib/sidebar/model.js";

const MIGRATIONS = [`CREATE TABLE sidebar_lists (k TEXT PRIMARY KEY, v TEXT NOT NULL)`];
const SPACE = /^(\*|spc_[a-z2-7]{12}|[a-z0-9][a-z0-9._-]{0,63})$/;
const str = { type: "string" };
/** Who may call: the person's surfaces and devices, and an assistant (a model session or the harness). The team's default is the person's alone, checked in the tool. */
const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const read = (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM sidebar_lists WHERE k = ?").get(k)); try { return r ? JSON.parse(String(r.v)) : null; } catch { return null; } };
    const write = (/** @type {string} */ k, /** @type {any} */ v) => {
      if (v === null || v === undefined || (Array.isArray(v) && !v.length && k === "mine")) db.prepare("DELETE FROM sidebar_lists WHERE k = ?").run(k);
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
    const mine = () => cleanList(read("mine"));
    /** The module screens installed here, from their manifests. A fixture-shaped list: [{ module, label, screens: [{ id, label, path?, icon? }] }]. */
    const modules = () => {
      /** @type {any[]} */ const out = [];
      for (const m of ctx.modules.status()) {
        if (m.state !== "running" || !Array.isArray(m.screens)) continue;
        const screens = m.screens.filter((/** @type {any} */ s) => s && typeof s.id === "string" && typeof s.label === "string").slice(0, 40).map((/** @type {any} */ s) => ({ id: s.id, label: String(s.label).slice(0, 40), ...(s.icon ? { icon: String(s.icon) } : {}), ...(s.path ? { path: String(s.path) } : {}) }));
        if (screens.length) out.push({ module: m.name, label: m.name, screens });
      }
      return out;
    };
    const spaceArg = (/** @type {any} */ i) => { const s = i && i.space === undefined ? "*" : String(i.space); if (!SPACE.test(s)) throw refuse("That is not a Space.", "bad_input"); return s; };

    // The settings hub's store for sidebar.default and sidebar.mine: no `value` reads, a `value` writes. The hub is the person's own act, so there is no further check here.
    ctx.tool("sidebar.stored", {
      effect: "write",
      description: "The stored lists behind the settings sidebar.default and sidebar.mine. Called by the settings hub as its store: with no value it reads { value }, with a value it keeps it (cleaned) and answers { value }.",
      input: { type: "object", properties: { key: { type: "string", enum: ["default", "mine"] }, value: {} }, required: ["key"] },
      run: async (/** @type {any} */ i) => {
        if (i.key !== "default" && i.key !== "mine") throw refuse("key is default or mine", "bad_input");
        const shown = () => (i.key === "default" ? defaults() : { entries: mine() });
        if (!("value" in i)) return { value: shown() };
        if (i.key === "mine") write("mine", cleanList(i.value));
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
      description: "The sidebar for a Space: the Space's default (null when none is stored, then the built-in places stand), this person's own list, the two merged, and the installed module screens that can be added.",
      input: { type: "object", properties: { space: str } },
      run: async (/** @type {any} */ i) => {
        const sp = spaceArg(i);
        const def = defaultFor(sp), own = mine();
        return { space: sp, default: def, mine: own, entries: merge(def || builtinEntries(), own), modules: modules() };
      },
    });

    ctx.tool("sidebar.edit", {
      effect: "write", callers: WHO,
      description: "Change the sidebar by one step. op is add (what: a place's or screen's name, or entry), remove, hide, show, move (before: another entry's key, or index) or group (group: a name, or null). scope is me (default) or team (the Space's default: only the person at their own surface).",
      input: { type: "object", required: ["op"], properties: { op: { type: "string", enum: ["add", "remove", "hide", "show", "move", "group"] }, what: str, key: str, entry: {}, scope: { type: "string", enum: ["me", "team"] }, space: str, group: { type: ["string", "null"] }, before: str, index: { type: "number" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        const team = i.scope === "team";
        if (team && !isPerson(meta)) throw refuse("Only the person at their own screen sets the team's sidebar. Ask them to do it, or add it for yourself.", "denied");
        const sp = spaceArg(i);
        const cat = { modules: modules() };
        const views = [...(defaultFor(sp) || []), ...mine()].filter(e => e.kind === "view");
        const cur = team ? (defaultFor(sp) || builtinEntries()) : merge(defaultFor(sp) || builtinEntries(), mine());
        // Which entry the person means: a key, an entry, or a name (the assistant's "Documents").
        let target = null;
        if (typeof i.key === "string") target = cur.find(e => keyOf(e) === i.key) || null;
        if (!target && i.entry) { const c = cleanList([i.entry])[0]; target = c || null; }
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
          default: throw refuse("op is add, remove, hide, show, move or group", "bad_input");
        }
        if (next.length > MAX_ENTRIES) throw refuse("The sidebar is full.", "bad_input");
        if (team) { const d = defaults(); d[sp] = next; write("default", d); }
        else write("mine", next);
        ctx.events.emit("sidebar.changed", { scope: team ? "default" : "mine", op: i.op, key });
        return { ok: true, key, scope: team ? "team" : "me", entries: team ? next : next };
      },
    });
    return {};
  },
};
