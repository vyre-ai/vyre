// @ts-check
// The sidebar as data (SPEC-0.3.0 part 9). It is a list each person arranges, not a fixed list in code: the built-in places, an installed module's screens, and saved views, each
// with an optional group and a hidden flag. An admin sets the Space's default; each person's own arrangement sits on top of it. When nothing is stored the built-in places
// (PLACES, the app's old NAV) are the default.
//
// Pure: no React, no storage. The app draws from `layout`, the settings tools keep the two lists (core/sidebar), and the assistant's tool edits them through the same functions.
//
//   Entry   { kind: "place", id }                          a built-in place
//           { kind: "module", module, screen }             one of an installed module's screens (its manifest's `screens`; interface 3)
//           { kind: "view", id, label, href, icon? }       a saved view: a records list with a filter, a project, a Flow, a Connection's data
//           each also: group?: string  (the built-in regions "main", "more" and "bottom", or a name the person gave), hidden?: true
//
// Stored (interface 4): one list for the Space default (an admin writes it) and one for the person on top. The person's list holds the whole arrangement they made; what an
// admin later adds to the default still reaches them, and what the person hid stays hidden.

/** The built-in places, in the order of the app's first NAV. `group` is where each sits by default; `sites` appears only where the build has it. */
export const PLACES = Object.freeze([
  { id: "now", label: "Now", icon: "now", href: "/u/now", group: "main" },
  { id: "chat", label: "Chat", icon: "chat", href: "/u/chats", group: "main" },
  { id: "projects", label: "Projects", icon: "projects", href: "/u/projects", match: ["/u/project"], group: "main" },
  { id: "contacts", label: "Contacts", icon: "contacts", href: "/u/records/contact", group: "main" },
  { id: "drive", label: "Drive", icon: "drive", href: "/u/drive", group: "main" },
  { id: "sites", label: "Sites", icon: "globe", href: "/u/sites", group: "main", optional: "sites" },
  { id: "calendar", label: "Calendar", icon: "cal", href: "/u/calendar", group: "more" },
  { id: "memory", label: "Memory", icon: "memory", href: "/u/memory", group: "more" },
  { id: "vault", label: "Vault", icon: "vault", href: "/u/vault", group: "more" },
  { id: "flows", label: "Flows", icon: "flows", href: "/u/flows", group: "more" },
  { id: "assistants", label: "Assistants", icon: "assistants", href: "/u/assistants", group: "more" },
  { id: "kits", label: "Kits", icon: "box", href: "/u/kits", group: "more" },
  { id: "search", label: "Search", icon: "search", href: "/u/search", group: "bottom" },
  { id: "settings", label: "Settings", icon: "settings", href: "/u/settings", group: "bottom", match: ["/u/appearance", "/u/spaces", "/u/wink", "/u/access", "/u/about", "/u/install"] },
]);

/** The regions the shell draws on its own. Any other group name is drawn as a labelled section. */
export const REGIONS = Object.freeze(["main", "more", "bottom"]);
/** Places that can never be hidden or removed: without Settings a person could not undo what they arranged. */
export const LOCKED = Object.freeze(["settings"]);
/** The most entries one list holds, so a stored value cannot grow without bound. */
export const MAX_ENTRIES = 120;
const GROUP = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,31}$/u;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HREF = /^\/u\/[A-Za-z0-9/_.\-?=&%:]{0,200}$/;

/** @typedef {{ kind: "place", id: string, group?: string, hidden?: boolean }
 *   | { kind: "module", module: string, screen: string, group?: string, hidden?: boolean }
 *   | { kind: "view", id: string, label: string, href: string, icon?: string, group?: string, hidden?: boolean }} Entry */
/** @typedef {{ id: string, label: string, icon: string, href: string, match?: string[], group: string, optional?: string }} Place */
/** @typedef {{ module: string, label?: string, screens: { id: string, label: string, path?: string, icon?: string, view?: boolean }[] }} ModuleScreens */
/** @typedef {{ places?: readonly Place[], flags?: Record<string, boolean>, modules?: ModuleScreens[] }} Catalog */

/** The app route a module's screen opens at. The screen itself lives on the module's own origin (https://<module>.<space host>/<path>, opened with a one-time ticket): this route is the stable place in the sidebar, and the app looks the origin up when it is opened. One function, so the route changes in one place. @param {string} module @param {string} screen */
export const moduleHref = (module, screen) => `/u/module/${module}/${screen}`;

/** A stable key for an entry: the same thing is never in a list twice. @param {Entry} e */
export function keyOf(e) {
  return e.kind === "place" ? `place:${e.id}` : e.kind === "module" ? `module:${e.module}/${e.screen}` : `view:${e.id}`;
}

/** Clean one entry as it was stored, or null when it is not one. Unknown fields are dropped; nothing here trusts the stored text. @param {any} raw @returns {Entry | null} */
export function clean(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tail = {
    ...(typeof raw.group === "string" && (REGIONS.includes(raw.group) || GROUP.test(raw.group)) ? { group: raw.group } : {}),
    ...(raw.hidden === true ? { hidden: /** @type {true} */ (true) } : {}),
  };
  if (raw.kind === "place" && typeof raw.id === "string" && SLUG.test(raw.id)) return { kind: "place", id: raw.id, ...tail };
  if (raw.kind === "module" && typeof raw.module === "string" && SLUG.test(raw.module) && typeof raw.screen === "string" && SLUG.test(raw.screen)) return { kind: "module", module: raw.module, screen: raw.screen, ...tail };
  if (raw.kind === "view" && typeof raw.id === "string" && SLUG.test(raw.id) && typeof raw.label === "string" && raw.label.trim() && raw.label.length <= 60 && typeof raw.href === "string" && HREF.test(raw.href) && !raw.href.includes("..")) {
    return { kind: "view", id: raw.id, label: raw.label.trim(), href: raw.href, ...(typeof raw.icon === "string" && SLUG.test(raw.icon) ? { icon: raw.icon } : {}), ...tail };
  }
  return null;
}

/** What the sidebar can pin beyond its built-in places: the app route each opens at, and the group it sits in by default. */
const PINNABLE = Object.freeze({
  project: { href: (/** @type {string} */ id) => `/u/project/${id}`, icon: "projects", prefix: "project" },
  flow: { href: (/** @type {string} */ id) => `/u/flows/${id}`, icon: "flows", prefix: "flow" },
  connection: { href: () => "/u/connections", icon: "connections", prefix: "connection" },
  records: { href: (/** @type {string} */ id) => `/u/records/${id}`, icon: "records", prefix: "records" },
});
export const PIN_KINDS = Object.freeze(["project", "flow", "connection", "records", "view"]);

/**
 * The sidebar entry that pins a thing (R031-48): a project, a Flow, a Connection's place, a records list (its type) or a saved view (an href the caller gives, under /u/). The entry is an ordinary
 * `view` entry, so it is moved, grouped, hidden and removed like any other, and its key is `view:<kind>-<id>`. Returns null for anything it cannot pin.
 * @param {string} what @param {string} id @param {string} [label] @param {string} [href] @returns {Entry | null}
 */
export function pinEntry(what, id, label, href) {
  const slug = String(id || "");
  if (!SLUG.test(slug)) return null;
  const name = typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : slug;
  if (what === "view") return clean({ kind: "view", id: `view-${slug}`, label: name, href: String(href || ""), icon: "view" });
  const p = /** @type {any} */ (PINNABLE)[what];
  return p ? clean({ kind: "view", id: `${p.prefix}-${slug}`, label: name, href: p.href(slug), icon: p.icon }) : null;
}

/** A stored list, cleaned: invalid entries dropped, repeats dropped (the first wins), at most MAX_ENTRIES. @param {unknown} raw @returns {Entry[]} */
export function cleanList(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).entries) ? /** @type {any} */ (raw).entries : [];
  /** @type {Entry[]} */ const out = [];
  const seen = new Set();
  for (const r of list) {
    const e = clean(r);
    if (!e || seen.has(keyOf(e))) continue;
    seen.add(keyOf(e)); out.push(e);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/** The places this build has: the ones with no flag, and the flagged ones whose flag is on. @param {Catalog} [cat] */
export function placesOf(cat = {}) {
  return (cat.places ?? PLACES).filter((p) => !p.optional || cat.flags?.[p.optional] === true);
}

/** Today's NAV as a list of entries: the default when nothing is stored. Every built-in place is listed, including the ones only some builds have: `layout` leaves out what the build lacks, so one stored list serves every build. @returns {Entry[]} */
export function builtinEntries() {
  return PLACES.map((p) => ({ kind: "place", id: p.id, group: p.group }));
}

/**
 * The person's arrangement laid over the Space's default. With no personal list the default stands. With one, the person's order, groups and hidden marks win; an entry the
 * default has and the person's list never saw (an admin added it later) is placed after the default entry it followed, so it reaches everyone.
 * @param {Entry[]} base @param {Entry[]} mine
 */
export function merge(base, mine) {
  if (!mine.length) return base.map((e) => ({ ...e }));
  const have = new Set(mine.map(keyOf));
  const out = mine.map((e) => ({ ...e }));
  let after = -1;   // the index in `out` of the last base entry seen that the person has
  for (const b of base) {
    const k = keyOf(b);
    if (have.has(k)) { after = out.findIndex((e) => keyOf(e) === k); continue; }
    out.splice(after + 1, 0, { ...b });
    after += 1;
  }
  return out.slice(0, MAX_ENTRIES);
}

/** An entry as a nav item, or null when it cannot be drawn (a place this build lacks, a module that is not installed or lost the screen). @param {Entry} e @param {Catalog} [cat] */
export function resolve(e, cat = {}) {
  if (e.kind === "place") {
    const p = placesOf(cat).find((x) => x.id === e.id);
    return p ? { id: p.id, label: p.label, icon: p.icon, href: p.href, ...(p.match ? { match: [...p.match] } : {}) } : null;
  }
  if (e.kind === "module") {
    const m = (cat.modules ?? []).find((x) => x.module === e.module);
    const s = m && m.screens.find((x) => x.id === e.screen);
    return s ? { id: `m-${e.module}-${e.screen}`, label: s.label, icon: s.icon || "box", href: moduleHref(e.module, e.screen) } : null;
  }
  return { id: `v-${e.id}`, label: e.label, icon: e.icon || "list", href: e.href };
}

/**
 * What the shell draws: the visible entries in order, split by group. `main`, `more` and `bottom` are the shell's own regions; every other group name becomes a labelled
 * section in `groups`, in the order it first appears. Settings is always there: if the lists hid or dropped it, it comes back at the end of the bottom region.
 * @param {Entry[]} entries @param {Catalog} [cat]
 */
export function layout(entries, cat = {}) {
  /** @type {Record<string, any[]>} */ const regions = { main: [], more: [], bottom: [] };
  /** @type {{ name: string, items: any[] }[]} */ const groups = [];
  const placed = new Set();
  for (const e of entries) {
    const item = resolve(e, cat);
    if (!item || (e.hidden && !(e.kind === "place" && LOCKED.includes(e.id)))) continue;
    if (placed.has(item.id)) continue;
    placed.add(item.id);
    const g = e.group || (e.kind === "place" ? (placesOf(cat).find((p) => p.id === e.id)?.group ?? "more") : "more");
    if (REGIONS.includes(g)) regions[g].push(item);
    else {
      let grp = groups.find((x) => x.name === g);
      if (!grp) { grp = { name: g, items: [] }; groups.push(grp); }
      grp.items.push(item);
    }
  }
  for (const id of LOCKED) {
    const p = placesOf(cat).find((x) => x.id === id);
    if (p && !placed.has(p.id)) regions.bottom.push(resolve({ kind: "place", id }, cat));
  }
  return { items: regions.main, more: regions.more, bottom: regions.bottom, groups };
}

/** Hidden entries, for the "Hidden" list in the editor, each with its drawn label. @param {Entry[]} entries @param {Catalog} [cat] */
export function hiddenOf(entries, cat = {}) {
  return entries.filter((e) => e.hidden).map((e) => ({ entry: e, label: resolve(e, cat)?.label ?? keyOf(e) }));
}

// ---- editing: each returns a new list and never touches its argument --------------------------------------------------------------------------------------------------

/** @param {Entry[]} list @param {string} key */
const at = (list, key) => list.findIndex((e) => keyOf(e) === key);

/** Move one entry to an index (clamped). @param {Entry[]} list @param {string} key @param {number} to */
export function move(list, key, to) {
  const i = at(list, key);
  if (i < 0) return list.map((e) => ({ ...e }));
  const out = list.map((e) => ({ ...e }));
  const [e] = out.splice(i, 1);
  out.splice(Math.max(0, Math.min(out.length, Math.trunc(to))), 0, e);
  return out;
}

/** Move one entry before another (drag and drop). A different group means the entry joins that group. @param {Entry[]} list @param {string} key @param {string} beforeKey */
export function moveBefore(list, key, beforeKey) {
  if (key === beforeKey || at(list, key) < 0 || at(list, beforeKey) < 0) return list.map((e) => ({ ...e }));
  const out = list.map((e) => ({ ...e }));
  const [e] = out.splice(at(out, key), 1);
  const target = out[at(out, beforeKey)];
  if (target.group !== undefined) e.group = target.group; else delete e.group;
  out.splice(at(out, beforeKey), 0, e);
  return out;
}

/** Hide or show one entry. Settings cannot be hidden. @param {Entry[]} list @param {string} key @param {boolean} hidden */
export function setHidden(list, key, hidden) {
  return list.map((e) => {
    if (keyOf(e) !== key) return { ...e };
    if (hidden && e.kind === "place" && LOCKED.includes(e.id)) return { ...e };
    const { hidden: _h, ...rest } = e;
    return hidden ? { ...rest, hidden: /** @type {true} */ (true) } : rest;
  });
}

/** Put one entry in a group (a region or a name). Null takes it out of any named group, back to where its kind belongs. @param {Entry[]} list @param {string} key @param {string | null} group */
export function setGroup(list, key, group) {
  if (group !== null && !REGIONS.includes(group) && !GROUP.test(group)) return list.map((e) => ({ ...e }));
  return list.map((e) => {
    if (keyOf(e) !== key) return { ...e };
    const { group: _g, ...rest } = e;
    return group === null ? rest : { ...rest, group };
  });
}

/** Add an entry (shown, at the end of its group). An entry already there is un-hidden instead. @param {Entry[]} list @param {Entry} entry @param {{ group?: string }} [o] */
export function add(list, entry, o = {}) {
  const e = clean(o.group ? { ...entry, group: o.group } : entry);
  if (!e) return list.map((x) => ({ ...x }));
  const out = list.map((x) => ({ ...x }));
  const i = at(out, keyOf(e));
  if (i >= 0) { const { hidden: _h, ...rest } = out[i]; out[i] = o.group ? { ...rest, group: o.group } : rest; return out; }
  const g = e.group;
  let last = -1;
  for (let j = 0; j < out.length; j++) if (out[j].group === g) last = j;
  out.splice(last < 0 ? out.length : last + 1, 0, e);
  return out.slice(0, MAX_ENTRIES);
}

/** Take an entry out. A place is only hidden (it stays known, so it can come back and an admin's later default does not re-add it); a module screen or a view is deleted. @param {Entry[]} list @param {string} key */
export function remove(list, key) {
  const e = list[at(list, key)];
  if (!e) return list.map((x) => ({ ...x }));
  if (e.kind === "place") return setHidden(list, key, true);
  return list.filter((x) => keyOf(x) !== key).map((x) => ({ ...x }));
}

/**
 * Find what a person meant by a name ("Documents"): a place, a module screen or a saved view whose label is it, whole word first, then as a prefix, then contained.
 * Returns the entry and whether the match was exact, or null. @param {string} text @param {Catalog} [cat] @param {Entry[]} [views]
 */
export function find(text, cat = {}, views = []) {
  const q = String(text || "").trim().toLowerCase().replace(/^(the|my)\s+/, "").replace(/\s+(page|screen|place|view)$/, "");
  if (!q) return null;
  /** @type {{ entry: Entry, label: string }[]} */ const all = [
    ...placesOf(cat).map((p) => ({ entry: /** @type {Entry} */ ({ kind: "place", id: p.id }), label: p.label })),
    ...(cat.modules ?? []).flatMap((m) => m.screens.map((s) => ({ entry: /** @type {Entry} */ ({ kind: "module", module: m.module, screen: s.id }), label: s.label }))),
    ...views.map((v) => ({ entry: v, label: v.kind === "view" ? v.label : "" })).filter((x) => x.label),
  ];
  for (const test of [(/** @type {string} */ l) => l === q, (/** @type {string} */ l) => l.startsWith(q), (/** @type {string} */ l) => l.includes(q)]) {
    const hit = all.filter((x) => test(x.label.toLowerCase()));
    if (hit.length === 1) return { entry: hit[0].entry, exact: hit[0].label.toLowerCase() === q };
    if (hit.length > 1) return null;   // ambiguous: the assistant asks which
  }
  return null;
}
