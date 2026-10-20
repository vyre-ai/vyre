// @ts-check
// Home's last good world, kept on this device per Space so Now opens from it at once and refreshes behind it (stale while revalidate). Pure: the hook is screens/now/home-world.ts.
// Only what Now already draws is kept: the person, the actors, the spaces, the types, the tasks, the newest events, today's calendar and the records the tasks point at. A sealed field's
// value never rides (only its definition), so a cached copy holds nothing a reveal guards.

/** The newest events Now shows; the rest stay on the box. */
export const EVENTS_KEPT = 60;
/** A copy older than this is not shown: the box is asked fresh and the first-run placeholder shows. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The view cache key for one Space's Home. @param {string | null | undefined} space */
export const homeKey = (space) => `home.world.${space || "home"}`;

/** True for a field whose value is sealed (a reference to the vault, never plaintext, and never kept here). @param {any} f */
const sealed = (f) => Boolean(f && (f.kind === "sealed" || f.seal));

/**
 * The world as plain JSON, ready for the view cache.
 * @param {any} w the world (ui/tasks/world.js loadWorld, with Now's calendar) @param {() => number} [clock]
 * @returns {any}
 */
export function packWorld(w, clock = Date.now) {
  const types = w && w.types instanceof Map ? [...w.types.values()] : [];
  /** @type {Map<string, Set<string>>} */ const hidden = new Map();
  for (const t of types) if (t && typeof t.name === "string") hidden.set(t.name, new Set((Array.isArray(t.fields) ? t.fields : []).filter(sealed).map((/** @type {any} */ f) => String(f.name))));
  const records = w && w.records instanceof Map ? [...w.records.values()].map((r) => {
    const drop = hidden.get(r && r.type);
    if (!r || !r.data || !drop || !drop.size) return r;
    return { ...r, data: Object.fromEntries(Object.entries(r.data).filter(([k]) => !drop.has(k))) };
  }) : [];
  return {
    v: 1, at: clock(),
    me: w?.me ?? "", actors: w?.actors ?? [], spaces: w?.spaces ?? [], types,
    tasks: w?.tasks ?? [], events: (w?.events ?? []).slice(0, EVENTS_KEPT), calendar: w?.calendar ?? [],
    records,
  };
}

/**
 * The world back from the cache, with `now` the current time, or null when there is none, it is from another version, or it is too old to show.
 * @param {any} raw @param {() => number} [clock]
 */
export function unpackWorld(raw, clock = Date.now) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || !Array.isArray(raw.tasks) || !Array.isArray(raw.types)) return null;
  const now = clock();
  if (!Number.isFinite(raw.at) || now - raw.at > MAX_AGE_MS) return null;
  /** @type {Map<string, any>} */ const records = new Map();
  for (const r of Array.isArray(raw.records) ? raw.records : []) if (r && typeof r.urn === "string") records.set(r.urn, r);
  /** @type {Map<string, any>} */ const types = new Map();
  for (const t of raw.types) if (t && typeof t.name === "string") types.set(t.name, t);
  return {
    me: raw.me, actors: Array.isArray(raw.actors) ? raw.actors : [], spaces: Array.isArray(raw.spaces) ? raw.spaces : [],
    types,
    tasks: raw.tasks, events: Array.isArray(raw.events) ? raw.events : [], calendar: Array.isArray(raw.calendar) ? raw.calendar : [],
    records, now,
  };
}

/**
 * What Now draws: the fresh world when the box has answered, else the cached one (marked stale), else nothing (the first run, the only time the placeholder rows show).
 * @template W
 * @param {W | undefined} fresh @param {W | null | undefined} cached
 * @returns {{ world: W | undefined, stale: boolean }}
 */
export function pickWorld(fresh, cached) {
  if (fresh !== undefined) return { world: fresh, stale: false };
  if (cached) return { world: cached, stale: true };
  return { world: undefined, stale: false };
}
