// @ts-check
// sidebar: the lists behind the app's sidebar (SPEC-0.3.0 part 9; the rules are lib/sidebar/model.js, shared with the app).
//
// Two kinds of list are kept here, in this module's own table:
//   the Space's default   by Space: { "<space id>": [entry, ...] }, "*" for every Space with none of its own. Set by the Space's OWNER or ADMIN role.
//   a person's own list   one per person, laid over the default; the same on every device (there is no sidebar per device). The box's own person is the identity that owns the box; a team
//                         member is their own id, kept on the team's server.
// The settings hub reads and writes the box person's lists as ordinary settings (a tool store, like the planner's): `sidebar.default` and `sidebar.mine` (as { entries }).
// With nothing stored the built-in places are the default (PLACES, the app's old NAV).
//
// sidebar.get   the default for a Space, the caller's own list, the two merged, whether the caller may set the default, and the module screens installed here with their own origin.
// sidebar.edit  one change to the caller's OWN list: add, remove, hide, show, move, group or set. An assistant may make it at once ("put Documents in my sidebar").
// sidebar.team  the same changes to the Space's default. Only the Space's owner or admin role (the person at their own surface). It is a held change for an assistant (ASK_FIRST): the person
//               says yes before it happens.
// A team member reaches all three through the Space's kernel (kernel/remote, service `sidebar`, core/sidebar/service.js), which runs the internal tool sidebar.serve with the member's person and
// the ROLE the kernel states: a member's request names neither.
// A module screen that is not installed is not drawn and not an error; a stored list is cleaned on every read and write.

import { isPerson } from "../../lib/caller.js";
import { createSidebarService } from "./service.js";
import { pinEntry, PIN_KINDS, builtinEntries, cleanList, merge, keyOf, find, add, remove, setHidden, move, moveBefore, setGroup, MAX_ENTRIES } from "../../lib/sidebar/model.js";

const MIGRATIONS = [`CREATE TABLE sidebar_lists (k TEXT PRIMARY KEY, v TEXT NOT NULL)`];
/** The caller the daemon's own sidebar service arrives as. */
const DOOR = "module:vyred";
const SPACE = /^(\*|spc_[a-z2-7]{12}|[a-z0-9][a-z0-9._-]{0,63})$/;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const str = { type: "string" };
/** Who may call: the person's surfaces and devices, a module, and an assistant (a model session or the harness). What each may change is checked in the tool. */
const WHO = ["cli", "local", "deck", "capsule", "mobile", "tailnet", "device", "module", "mcp", "harness"];
const refuse = (/** @type {string} */ message, /** @type {string} */ code) => Object.assign(new Error(message), { code });
const NO_DEFAULT = "Only an owner or an admin of this Space sets the team's sidebar. You can arrange your own.";

/** The roles that set a Space's default. @param {string | null | undefined} role */
export const roleSetsDefault = role => role === "owner" || role === "admin";

const EDIT_PROPS = { op: { type: "string", enum: ["add", "remove", "hide", "show", "move", "group", "set", "reset"], description: "set takes the whole list in entries; reset drops the caller's own list (sidebar.edit only)" }, entries: { type: "array", description: "the whole list, for op set" }, what: { type: "string", description: "a place's or screen's name, for op add" }, key: str, entry: {}, space: str, group: { type: ["string", "null"], description: "a group name, or null, for op group" }, before: { type: "string", description: "another entry's key, for op move (or give index)" }, index: { type: "number" } };

export default {
  async start(ctx) {
    ctx.store.migrate(MIGRATIONS);
    const db = ctx.store.db;
    const read = (/** @type {string} */ k) => { const r = /** @type {any} */ (db.prepare("SELECT v FROM sidebar_lists WHERE k = ?").get(k)); try { return r ? JSON.parse(String(r.v)) : null; } catch { return null; } };
    const write = (/** @type {string} */ k, /** @type {any} */ v) => {
      if (v === null || v === undefined) db.prepare("DELETE FROM sidebar_lists WHERE k = ?").run(k);
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
    const mineOf = (/** @type {string} */ who) => cleanList(read(`mine:${who}`));
    /** The box's own person: the identity that owns this box, or "self" before there is one. */
    const ownerId = async () => { const id = ctx.config && ctx.config.owner && ctx.config.owner.id; return typeof id === "string" && PERSON.test(id) ? id : "self"; };
    /** The module screens installed here, from their manifests, each with the origin it is served on (appmods.origin) when that is known. */
    const modules = async () => {
      /** @type {any[]} */ const out = [];
      for (const m of ctx.modules.status()) {
        if (m.state !== "running") continue;
        const own = (Array.isArray(m.screens) ? m.screens : []).filter((/** @type {any} */ s) => s && typeof s.id === "string" && typeof s.label === "string").slice(0, 40).map((/** @type {any} */ s) => ({ id: s.id, label: String(s.label).slice(0, 40), ...(s.icon ? { icon: String(s.icon) } : {}), ...(s.path ? { path: String(s.path) } : {}) }));
        // The module's `views` are screens too, drawn by Vyre itself (core/views): `view: true` says so, and they need no origin.
        const drawn = Object.entries(m.views && typeof m.views === "object" ? m.views : {}).filter(([id, v]) => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) && v && typeof v === "object" && /** @type {any} */ (v).title).slice(0, 60)
          .map(([id, v]) => ({ id, label: String(/** @type {any} */ (v).title).slice(0, 40), view: true, ...(/** @type {any} */ (v).icon ? { icon: String(/** @type {any} */ (v).icon).slice(0, 40) } : {}) }));
        const screens = [...own.filter((/** @type {any} */ s) => !drawn.some(d => d.id === s.id)), ...drawn];
        if (!screens.length) continue;
        let origin = null;
        if (own.length) try { const o = /** @type {any} */ (await ctx.call("appmods.origin", { module: m.name })); if (o && !o.error && o.data && typeof o.data.origin === "string" && /^https:\/\//.test(o.data.origin)) origin = o.data.origin; } catch { /* no app-module host on this box */ }
        out.push({ module: m.name, label: m.name, screens, ...(origin ? { origin } : {}) });
      }
      return out;
    };
    const spaceArg = (/** @type {any} */ i) => { const s = i && i.space === undefined ? "*" : String(i.space); if (!SPACE.test(s)) throw refuse("That is not a Space.", "bad_input"); return s; };

    // ---- what each call does, for a given person and whether they may set the default -----------------------------------------------------------------------------------

    const doGet = async (/** @type {string} */ person, /** @type {boolean} */ can, /** @type {any} */ i) => {
      const sp = spaceArg(i), def = defaultFor(sp), own = mineOf(person);
      return { space: sp, default: def, mine: own, entries: merge(def || builtinEntries(), own), modules: await modules(), can_set_default: can };
    };

    /** One change to a list: `cur` is the list as it stands. */
    const apply = async (/** @type {any} */ i, /** @type {any[]} */ cur, /** @type {string} */ sp, /** @type {string} */ person) => {
      const cat = { modules: await modules() };
      if (i.op === "set") {
        const next = cleanList(i.entries);
        if (!next.length) throw refuse("A sidebar needs at least one entry.", "bad_input");
        return { next, key: null };
      }
      const views = [...(defaultFor(sp) || []), ...mineOf(person)].filter(e => e.kind === "view");
      // Which entry the person means: a key, an entry, or a name (the assistant's "Documents").
      let target = null;
      if (typeof i.key === "string") target = cur.find(e => keyOf(e) === i.key) || null;
      if (!target && i.entry) target = cleanList([i.entry])[0] || null;
      if (!target && typeof i.what === "string") {
        const f = find(i.what, cat, /** @type {any} */ (views));
        if (!f) throw refuse(`I could not tell which one "${i.what}" is: nothing has that name, or more than one does. Give the exact name, or its key.`, "not_found");
        target = f.entry;
      }
      if (!target) throw refuse("Say which entry: its name, or its key.", "bad_input");
      const key = keyOf(target);
      if (i.op === "add" && target.kind === "module" && !cat.modules.some(m => m.module === target.module && m.screens.some((/** @type {any} */ s) => s.id === target.screen))) throw refuse("That screen is not installed here. Pick another place or screen.", "not_found");
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

    const doEdit = async (/** @type {string} */ person, /** @type {any} */ i) => {
      const sp = spaceArg(i);
      // reset: back to the team's order (or the built-in places) — the person's own list is dropped
      if (i && i.op === "reset") {
        write(`mine:${person}`, null);
        ctx.events.emit("sidebar.changed", { scope: "mine", op: "reset" });
        return { ok: true, key: null, scope: "me", entries: defaultFor(sp) || builtinEntries() };
      }
      const { next, key } = await apply(i, merge(defaultFor(sp) || builtinEntries(), mineOf(person)), sp, person);
      write(`mine:${person}`, next);
      ctx.events.emit("sidebar.changed", { scope: "mine", op: i.op, ...(key ? { key } : {}) });
      return { ok: true, key, scope: "me", entries: next };
    };

    const doTeam = async (/** @type {string} */ person, /** @type {boolean} */ can, /** @type {any} */ i) => {
      const sp = spaceArg(i);
      if (!can) throw refuse(NO_DEFAULT, "denied");
      const { next, key } = await apply(i, defaultFor(sp) || builtinEntries(), sp, person);
      const d = defaults(); d[sp] = next; write("default", d);
      ctx.events.emit("sidebar.changed", { scope: "default", op: i.op, ...(key ? { key } : {}) });
      return { ok: true, key, scope: "team", entries: next };
    };

    // ---- the settings hub's store for the box person's two settings: no `value` reads, a `value` writes ----------------------------------------------------------------------

    ctx.tool("sidebar.stored", {
      effect: "write",
      description: "The stored lists behind the settings sidebar.default and sidebar.mine. Called by the settings hub as its store: with no value it reads { value }, with a value it keeps it (cleaned) and answers { value }.",
      input: { type: "object", properties: { key: { type: "string", enum: ["default", "mine"] }, value: {} }, required: ["key"] },
      run: async (/** @type {any} */ i) => {
        if (i.key !== "default" && i.key !== "mine") throw refuse("key is default or mine", "bad_input");
        const owner = await ownerId();
        const shown = () => (i.key === "default" ? defaults() : { entries: mineOf(owner) });
        if (!("value" in i)) return { value: shown() };
        if (i.key === "mine") write(`mine:${owner}`, cleanList(i.value));
        else {
          if (i.value !== null && (typeof i.value !== "object" || Array.isArray(i.value))) throw refuse("sidebar.default is an object by Space", "bad_input");
          const d = {}; for (const [sp, l] of Object.entries(i.value || {})) { if (!SPACE.test(sp)) throw refuse(`${sp} is not a Space`, "bad_input"); const c = cleanList(l); if (c.length) /** @type {any} */ (d)[sp] = c; }
          write("default", Object.keys(d).length ? d : null);
        }
        ctx.events.emit("sidebar.changed", { scope: i.key });
        return { value: shown() };
      },
    });

    // ---- the box person's tools ---------------------------------------------------------------------------------------------------------------------------------------

    ctx.tool("sidebar.get", {
      effect: "read", callers: WHO,
      description: "The Space's default sidebar, the caller's own list, the merged result, whether the caller may set the default, and addable module screens.",
      input: { type: "object", properties: { space: str } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => doGet(await ownerId(), isPerson(meta), i),
    });

    ctx.tool("sidebar.edit", {
      effect: "write", callers: WHO,
      description: "Change the caller's own sidebar by one step, for example { op: \"add\", what: \"Documents\" }. The Space's default is sidebar.team.",
      input: { type: "object", required: ["op"], properties: EDIT_PROPS },
      run: async (/** @type {any} */ i) => doEdit(await ownerId(), i),
    });

    // Pin anything (R031-48): a project, a Flow, a Connection's place, a records list or a saved view, by id, to the caller's OWN sidebar. An assistant may ("pin the Acme intake Flow").
    ctx.tool("sidebar.pin", {
      effect: "write", callers: WHO,
      description: "Pin a project, Flow, Connection, records list or saved view to the caller's own sidebar by id. Pinning twice pins once; unpin with sidebar.unpin.",
      input: { type: "object", required: ["what", "id"], properties: { what: { type: "string", enum: PIN_KINDS }, id: str, label: str, href: { type: "string", description: "a view's address under /u/" }, group: str, space: str } },
      run: async (/** @type {any} */ i) => {
        const entry = pinEntry(String(i.what), String(i.id), i.label, i.href);
        if (!entry) throw refuse(`I cannot pin that: what is ${PIN_KINDS.join(", ")}, id is a short name, and a view needs an address under /u/.`, "bad_input");
        return doEdit(await ownerId(), { op: "add", entry, ...(i.group ? { group: String(i.group) } : {}), ...(i.space ? { space: i.space } : {}) });
      },
    });
    ctx.tool("sidebar.unpin", {
      effect: "write", callers: WHO,
      description: "Take a pinned project, Flow, Connection, records list or view off the caller's OWN sidebar: { what, id }.",
      input: { type: "object", required: ["what", "id"], properties: { what: { type: "string", enum: PIN_KINDS }, id: str, space: str } },
      run: async (/** @type {any} */ i) => {
        const entry = pinEntry(String(i.what), String(i.id), undefined, i.what === "view" ? "/u/x" : undefined);
        if (!entry) throw refuse("I cannot find that to unpin.", "bad_input");
        return doEdit(await ownerId(), { op: "remove", key: keyOf(entry), ...(i.space ? { space: i.space } : {}) });
      },
    });

    ctx.tool("sidebar.team", {
      effect: "write", callers: WHO,
      description: "Change the Space's default sidebar by one step (same ops as sidebar.edit). Owner or admin only; an assistant's request is held for their yes.",
      input: { type: "object", required: ["op"], properties: EDIT_PROPS },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => doTeam(await ownerId(), isPerson(meta), i),
    });

    // ---- a team member's calls, from the Space's kernel (core/sidebar/service.js) --------------------------------------------------------------------------------------

    ctx.tool("sidebar.serve", {
      internal: true, effect: "write",
      description: "A team member's sidebar call, run on behalf of the person and the role the Space's kernel stated. Called only by the home's own sidebar service.",
      input: { type: "object", required: ["call", "person", "role", "space", "input"], properties: { call: { type: "string", enum: ["get", "edit", "team"] }, person: str, role: str, space: str, input: { type: "object" } } },
      run: async (/** @type {any} */ i, /** @type {any} */ meta = {}) => {
        // Not for any module: the person and the role are taken on trust here, so only the daemon's own door, running the Space kernel's sidebar service, may say them.
        if (String(meta.caller || "") !== DOOR) throw refuse("Only the home's own sidebar service calls this.", "denied");
        const person = String(i.person);
        if (!PERSON.test(person)) throw refuse("That is not a person.", "bad_input");
        const input = { ...(i.input || {}), space: i.space };
        const can = roleSetsDefault(i.role);
        if (i.call === "get") return doGet(person, can, input);
        if (i.call === "edit") return doEdit(person, input);
        if (i.call === "team") return doTeam(person, can, input);
        throw refuse("call is get, edit or team", "bad_input");
      },
    });
    // The peer door (a team member's sidebar over the remote Space) asks for this module's service by name from its handle: the daemon imports nothing of the sidebar.
    return { peerService: (/** @type {{ space: string, kernel: any, registry: any }} */ o) => createSidebarService(o) };
  },
};
