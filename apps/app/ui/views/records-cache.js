// @ts-check
// Records opens from this device's last copy (stale while revalidate, the same rule as Home's ui/tasks/world-cache.js): per Space and type, the types, the first page of that type, the counts
// for the tabs, the people and the titles the kept rows link to. The page draws it at once, the box is read behind it, and the fresh answer replaces it in place. Pure; the hook is
// screens/records/records-open.ts. A sealed field's value never rides (only its definition), so a kept copy holds nothing a reveal guards.
import { linkIndex } from "./logic.js";

export const V = 1;
/** The rows of the open type kept for the next open: more than a screen shows, far fewer than a type holds. */
export const ROWS_KEPT = 100;
/** The first page asked for when nothing is kept yet: the rows a screen shows, read with the count beside them. */
export const FIRST_PAGE = 50;
/** A copy older than this is not shown: the box is asked fresh and the loading rows show. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** The view cache key for one Space's records of one type. @param {string | null | undefined} space @param {string} type */
export const recordsKey = (space, type) => `records.open.${space || "home"}.${type}`;

/** True for a field whose value is sealed. @param {any} f */
const sealed = (f) => Boolean(f && (f.kind === "sealed" || f.seal));
/** A value that is a sealed reference, whatever its field says. @param {any} v */
const sealedValue = (v) => Boolean(v && typeof v === "object" && (v.sealed === true || v.kind === "sealed"));

/** A row without any sealed value. @param {any} r @param {Set<string>} drop */
function clean(r, drop) {
  if (!r || !r.data) return r;
  return { ...r, data: Object.fromEntries(Object.entries(r.data).filter(([k, v]) => !drop.has(k) && !sealedValue(v))) };
}

/** Every record address a row's values point at (a link is { urn }). @param {any} r @returns {string[]} */
function pointsAt(r) {
  /** @type {string[]} */ const out = [];
  for (const v of Object.values((r && r.data) || {})) {
    for (const x of Array.isArray(v) ? v : [v]) if (x && typeof x === "object" && typeof x.urn === "string") out.push(x.urn);
  }
  return out;
}

/**
 * The counts for the tabs: what a world knows of each type. A world read whole counts its rows; a page counts what the box said (`counts`); a type neither knows is left out.
 * @param {any} w
 * @returns {Record<string, number>}
 */
export function countsOf(w) {
  /** @type {Record<string, number>} */ const out = {};
  if (!w) return out;
  if (!w.partial) for (const [t, rows] of Object.entries(w.byType || {})) if (Array.isArray(rows)) out[t] = rows.length;
  for (const [t, n] of Object.entries(w.counts || {})) if (typeof n === "number" && Number.isFinite(n)) out[t] = n;
  return out;
}

/**
 * One type's open state as plain JSON, ready for the view cache.
 * @param {any} w a records world (ui/views/data.ts useRecordsWorld) or a page of one (worldFromPage) @param {string} type @param {() => number} [clock]
 */
export function packOpen(w, type, clock = Date.now) {
  const types = Array.isArray(w && w.types) ? w.types : [];
  const def = types.find((/** @type {any} */ t) => t && t.name === type);
  const drop = new Set(((def && def.fields) || []).filter(sealed).map((/** @type {any} */ f) => String(f.name)));
  const rows = ((w && w.byType && w.byType[type]) || []).slice(0, ROWS_KEPT).map((/** @type {any} */ r) => clean(r, drop));
  // the titles the kept rows point at, so a link cell reads as it did; from the world's own records, or the ones a page kept before
  const all = { ...((w && w.links) || {}), ...(w && !w.partial ? linkIndex(types, w.byType || {}) : {}) };
  /** @type {Record<string, any>} */ const links = {};
  for (const r of rows) for (const u of pointsAt(r)) if (all[u]) links[u] = all[u];
  return { v: V, at: clock(), type, types, rows, counts: countsOf(w), actors: (w && w.actors) || [], me: (w && w.me) || "", links };
}

/**
 * The kept copy as a records world (partial: one type's first rows), or null when there is none, it is from another version or another type, or it is too old to show.
 * @param {any} raw @param {string} type @param {() => number} [clock]
 */
export function unpackOpen(raw, type, clock = Date.now) {
  if (!raw || typeof raw !== "object" || raw.v !== V || raw.type !== type || !Array.isArray(raw.types) || !Array.isArray(raw.rows)) return null;
  if (!Number.isFinite(raw.at) || clock() - raw.at > MAX_AGE_MS) return null;
  return { types: raw.types, byType: { [type]: raw.rows }, actors: Array.isArray(raw.actors) ? raw.actors : [], me: typeof raw.me === "string" ? raw.me : "", counts: raw.counts && typeof raw.counts === "object" ? raw.counts : {}, links: raw.links && typeof raw.links === "object" ? raw.links : {}, partial: true };
}

/**
 * A first page from the box as a records world: the types, the page's rows, the count the box gave, the people. Counts and titles already known (a kept copy) stay for the other tabs.
 * @param {{ type: string, types: any[], rows: any[], total?: number | null, actors?: any[], me?: string }} p @param {any} [known]
 */
export function worldFromPage(p, known) {
  const counts = { ...((known && known.counts) || {}) };
  if (typeof p.total === "number") counts[p.type] = p.total;
  return { types: p.types, byType: { [p.type]: p.rows }, actors: p.actors ?? (known && known.actors) ?? [], me: p.me ?? (known && known.me) ?? "", counts, links: (known && known.links) || {}, partial: true };
}

/**
 * What Records draws: the whole world when the box has answered, else the first page, else the kept copy, else nothing (the first open of a type on this device, the only time the
 * loading rows show). Anything but the whole world is marked stale: a quiet "Updating" shows, and filters and search work on the rows shown until the rest arrives.
 * @template W
 * @param {W | undefined} full @param {W | null | undefined} page @param {W | null | undefined} kept
 * @returns {{ world: W | undefined, stale: boolean, from: "box" | "page" | "kept" | "none" }}
 */
export function pickRecords(full, page, kept) {
  if (full !== undefined) return { world: full, stale: false, from: "box" };
  if (page) return { world: page, stale: true, from: "page" };
  if (kept) return { world: kept, stale: true, from: "kept" };
  return { world: undefined, stale: false, from: "none" };
}

/** The tab after this one (the first after the last), the one worth reading ahead when the screen is idle; null when there is no other. @param {{ name: string }[]} tabs @param {string} type */
export function nextTab(tabs, type) {
  if (!Array.isArray(tabs) || tabs.length < 2) return null;
  const i = tabs.findIndex((t) => t && t.name === type);
  const n = tabs[(i + 1) % tabs.length];
  return n && n.name !== type ? n.name : null;
}
