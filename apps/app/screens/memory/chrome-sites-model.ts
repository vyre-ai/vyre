// The pure half of Memory's Sites tab on a real vyred: what memory.site.list and memory.site.detail answer, as the lines the screen shows.
// What Vyre for Chrome learned about each website. Never a selector, a value or a page's text: names, counts, how sure it is and when it last checked.

export const PARTS: [string, string][] = [["flows", "Flows"], ["controls", "Controls"], ["api", "API calls"], ["notes", "Notes"], ["frames", "Frames"]];

export type SiteRow = { key: string; name: string; kind: "family" | "origin"; family: string | null; updated: number; verified: string | null; counts: Record<string, number>; usedToWork: number };
export type Forgotten = { kind: "site" | "row"; key: string; name: string; part: string | null; id: string | null; label: string | null; at: number; expires_at: number };
export type Item = { id: string | number; label?: string; quarantined?: boolean; verified?: string; runs?: number; fails?: number; conf?: number };
export type Detail = { found?: boolean; parts?: Record<string, Item[]> };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export { plural };

/** "today", "yesterday", "12 days ago" from a date (ISO text or ms); "" when there is none. */
export function ago(at: unknown, now = Date.now()): string {
  const t = typeof at === "number" ? at : Date.parse(String(at || ""));
  if (!Number.isFinite(t)) return "";
  const d = Math.max(0, Math.floor((now - t) / 86400_000));
  return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
}

/** A site's host for the line under its name: an origin's host, else the key as it is. */
export function hostOf(key: string): string {
  if (key.startsWith("family:")) return key.slice(7);
  try { return new URL(key).host || key; } catch { return key; }
}

type Raw = { key?: unknown; names?: unknown[]; kind?: string; family?: unknown; updated?: unknown; verified?: unknown; counts?: unknown; used_to_work?: unknown };
export function sitesOf(d: unknown): SiteRow[] {
  const list = (d as { sites?: Raw[] } | null)?.sites;
  return (Array.isArray(list) ? list : []).filter((s) => s && typeof s.key === "string").map((s) => ({
    key: String(s.key), name: String((Array.isArray(s.names) && s.names[0]) || s.key), kind: s.kind === "family" ? "family" as const : "origin" as const,
    family: s.family ? String(s.family) : null, updated: Number(s.updated) || 0, verified: s.verified ? String(s.verified) : null,
    counts: s.counts && typeof s.counts === "object" ? (s.counts as Record<string, number>) : {}, usedToWork: Number(s.used_to_work) || 0,
  }));
}

/** What the box can still bring back, newest first (the last 24 hours). A row needs both its part and its id. */
export function forgottenOf(d: unknown): Forgotten[] {
  type F = { kind?: string; key?: unknown; name?: unknown; part?: unknown; id?: unknown; label?: unknown; at?: unknown; expires_at?: unknown };
  const list = (d as { forgotten?: F[] } | null)?.forgotten;
  return (Array.isArray(list) ? list : []).filter((f) => f && typeof f.key === "string").map((f) => {
    const row = f.kind === "row" && f.part != null && f.id != null;
    return { kind: row ? "row" as const : "site" as const, key: String(f.key), name: String(f.name || f.key), part: row ? String(f.part) : null, id: row ? String(f.id) : null,
      label: f.label ? String(f.label) : null, at: Number(f.at) || 0, expires_at: Number(f.expires_at) || 0 };
  });
}

/** "12 controls, 3 flows, 2 notes" from a site's counts; "Nothing kept yet" when it has none. */
export function countsLine(c: Record<string, number>): string {
  const bits: [number, string, string][] = [[c.controls, "control", "controls"], [c.flows, "flow", "flows"], [c.api, "API call", "API calls"], [c.notes, "note", "notes"]];
  const out = bits.filter(([n]) => Number(n) > 0).map(([n, one, many]) => plural(Number(n), one, many));
  return out.length ? out.join(", ") : "Nothing kept yet";
}

/** The line under one row of a site's detail: stopped working, runs, when it was checked, or how sure Vyre is. */
export function itemMeta(part: string, it: Item): string {
  if (it.quarantined) return `stopped working${it.verified ? `, ${ago(it.verified)}` : ""}`;
  if (part === "flows" && Number(it.runs) > 0) return `${plural(Number(it.runs), "run")}, ${Number(it.fails) || 0} failed`;
  if (it.verified) return `checked ${ago(it.verified)}`;
  return typeof it.conf === "number" ? `${Math.round(it.conf * 100)}% sure` : "";
}

/** The parts of a detail with something in them, in the order a person thinks of them. */
export const partsOf = (d: Detail): { part: string; label: string; items: Item[] }[] =>
  PARTS.filter(([p]) => Array.isArray(d.parts?.[p]) && d.parts![p].length).map(([part, label]) => ({ part, label, items: d.parts![part] }));

/** The box's undo list as the screen's lines: one for a site, "label from site" for a row. */
export const forgottenLine = (f: Forgotten): string => (f.part ? `${f.label || f.id} from ${f.name}` : f.name);
export const tokenOf = (k: { key: string; part?: string | null; id?: string | null }): string => (k.part ? `${k.key}|${k.part}|${k.id}` : k.key);

export const errWords = (e: { code?: string; message?: string } | null | undefined): string =>
  e?.code === "no_such_tool" ? "Vyre Memory is not running on your server." : e?.message || "That did not go through.";
