// The pure half of the Files screen: the roots of the tree, one row shape for every source (the Space, a linked folder, a box share), sorting, filtering, breadcrumbs, selection, the keyboard,
// and what each source lets you do. Nothing here talks to the box or draws; the screens and the tests use it alike. The Space, Linked and Box folders are the existing files.* tools.
import { pathIn } from "./linked-model.ts";
import type { LinkedEntry } from "./linked-model.ts";
import type { Item } from "./space-model.ts";
import type { Entry } from "./real-model.ts";

export type Root = "space" | "shared" | "linked" | "box" | "computer";
export type Place = { root: Root; path: string; link?: string; share?: string };
export type Kind = "folder" | "pdf" | "doc" | "sheet" | "image" | "video" | "audio" | "archive" | "text" | "file";
export type FileRow = { key: string; place: string; root: Root; name: string; dir: boolean; kind: Kind; size: number; modified: number; by?: string; ver?: number; rev?: string | null; link?: string; share?: string; path: string };
export type TreeNode = { id: string; label: string; root: Root; kids?: TreeNode[] };

const ROOTS: [Root, string][] = [["space", "Space"], ["shared", "Shared"], ["linked", "Linked"], ["box", "On your server"], ["computer", "On your computer"]];
export const rootLabel = (r: Root): string => ROOTS.find((x) => x[0] === r)![1];

/** The roots, with a child per linked folder and per box share. A root with nothing in it is still there (it says so when opened); the Space's own folders load when it is opened. */
export function rootsOf(o: { linked: readonly { id: string; name: string }[]; shares: readonly { name: string }[] }): TreeNode[] {
  return ROOTS.map(([root, label]) => {
    if (root === "linked") return { id: root, label, root, kids: o.linked.map((l) => ({ id: `linked:${l.id}`, label: l.name, root })) };
    if (root === "box") return { id: root, label, root, kids: o.shares.map((s) => ({ id: `box:${s.name}`, label: s.name, root })) };
    return { id: root, label, root };
  });
}

const tail = (path: string) => (path ? `:${path}` : "");
export function placeId(p: Place): string {
  if (p.root === "linked") return p.link ? `linked:${p.link}${tail(p.path)}` : "linked";
  if (p.root === "box") return p.share ? `box:${p.share}${tail(p.path)}` : "box";
  return `${p.root}${tail(p.path)}`;
}
export function parsePlace(id: string): Place | null {
  const i = id.indexOf(":"), head = (i < 0 ? id : id.slice(0, i)) as Root, rest = i < 0 ? "" : id.slice(i + 1);
  if (!ROOTS.some((r) => r[0] === head)) return null;
  if (head === "linked" || head === "box") {
    if (!rest) return { root: head, path: "" };
    const j = rest.indexOf(":"), first = j < 0 ? rest : rest.slice(0, j), path = j < 0 ? "" : rest.slice(j + 1);
    return head === "linked" ? { root: head, link: first, path } : { root: head, share: first, path };
  }
  return { root: head, path: rest };
}

const EXT: Record<string, Kind> = {
  pdf: "pdf", doc: "doc", docx: "doc", rtf: "doc", odt: "doc", pages: "doc", xls: "sheet", xlsx: "sheet", csv: "sheet", ods: "sheet", numbers: "sheet",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image", svg: "image", mp4: "video", mov: "video", webm: "video", mkv: "video",
  mp3: "audio", wav: "audio", m4a: "audio", flac: "audio", zip: "archive", gz: "archive", tar: "archive", "7z": "archive",
  txt: "text", md: "text", json: "text", xml: "text", yml: "text", yaml: "text", log: "text", html: "text", htm: "text",
};
export const kindOf = (name: string, dir: boolean): Kind => (dir ? "folder" : EXT[name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""] ?? "file");

const ms = (v: unknown): number => { if (typeof v === "number") return v; const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isNaN(t) ? 0 : t; };

export function rowsFromSpace(items: readonly Item[], _prefix: string): FileRow[] {
  return items.map((i) => ({ key: `space:${i.path}`, place: `space:${i.path}`, root: "space", name: i.name, dir: i.dir, kind: kindOf(i.name, i.dir), size: i.size, modified: i.at, ver: i.ver || undefined, path: i.path }));
}
export function rowsFromLinked(link: string, linkName: string, entries: readonly LinkedEntry[]): FileRow[] {
  return entries.map((e) => {
    const rel = pathIn(linkName, e.path), id = `linked:${link}:${rel}`;
    return { key: id, place: id, root: "linked", name: e.name, dir: e.dir, kind: kindOf(e.name, e.dir), size: e.size, modified: ms(e.modified), rev: e.rev, link, path: rel };
  });
}
export function rowsFromBox(share: string, path: string, entries: readonly Entry[]): FileRow[] {
  const base = path.replace(/\/+$/, "");
  return entries.map((e) => {
    const p = `${base}/${e.name}`, id = `box:${share}:${p}`;
    return { key: id, place: id, root: "box", name: e.name, dir: e.dir, kind: kindOf(e.name, e.dir), size: e.size, modified: ms(e.mtime), share, path: p };
  });
}

export type SortKey = "name" | "kind" | "modified" | "size";
export type Sort = { key: SortKey; dir: "asc" | "desc" };
/** Folders first whatever the column; within each group the column decides, and a tie keeps the order it came in. */
export function sortRows<T extends Pick<FileRow, "name" | "dir" | "size" | "modified"> & { kind?: string }>(rows: readonly T[], key: SortKey, dir: "asc" | "desc"): T[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: T, b: T) => key === "size" ? a.size - b.size : key === "modified" ? a.modified - b.modified : key === "kind" ? String(a.kind).localeCompare(String(b.kind)) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name);
  return [...rows].sort((a, b) => Number(b.dir) - Number(a.dir) || sign * cmp(a, b));
}
export const nextSort = (cur: Sort, key: SortKey): Sort => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });

export function filterRows<T extends { name: string }>(rows: readonly T[], q: string): T[] {
  const ws = q.toLowerCase().split(/\s+/).filter(Boolean);
  return ws.length ? rows.filter((r) => ws.every((w) => r.name.toLowerCase().includes(w))) : [...rows];
}

/** Each step from the root to the place, with the place id tapping it opens. `names.linked` names a linked folder by id. */
export function crumbsFor(p: Place, names: { linked?: Record<string, string> }): { name: string; place: string }[] {
  const out: { name: string; place: string }[] = [{ name: rootLabel(p.root), place: p.root }];
  const slash = p.root === "box" && p.path.startsWith("/");
  if (p.root === "linked" && p.link) out.push({ name: names.linked?.[p.link] ?? p.link, place: `linked:${p.link}` });
  if (p.root === "box" && p.share) out.push({ name: p.share, place: `box:${p.share}` });
  const parts = p.path.split("/").filter(Boolean);
  parts.forEach((seg, i) => {
    const sub = (slash ? "/" : "") + parts.slice(0, i + 1).join("/");
    out.push({ name: seg, place: placeId({ ...p, path: sub }) });
  });
  return out;
}

export function parentPlace(id: string): string | null {
  const p = parsePlace(id);
  if (!p) return null;
  if (p.path) {
    const k = p.path.lastIndexOf("/");
    return placeId({ ...p, path: k <= 0 ? "" : p.path.slice(0, k) });
  }
  if ((p.root === "linked" && p.link) || (p.root === "box" && p.share)) return p.root;
  return null;
}

export type Abilities = { upload: boolean; versions: boolean; move: boolean; remove: boolean; download: boolean; share: boolean; edit: boolean };
/** What each source offers, from the tools that exist: the Space's Drive has upload, versions, restore and links but no move or delete; a linked folder writes, renames and deletes at its source; box folders are read only. */
export function abilities(root: string): Abilities {
  const none: Abilities = { upload: false, versions: false, move: false, remove: false, download: false, share: false, edit: false };
  // native-mount (work/rc4-native-mount) adds files.drive.space.move, .trash, a ranged read and chunked upload. When it lands: move and remove become true here, the Space's Move and Delete
  // call those tools in FilesManager.web.tsx (MoveDelete), and Download reads in ranges. Nothing of those tools is built here.
  if (root === "space") return { ...none, upload: true, versions: true, download: true, share: true };
  if (root === "linked") return { ...none, upload: true, versions: true, move: true, remove: true, download: true, edit: true };
  // A box share is read in chunks (files.drive.read) and there is no whole-file download yet, so none is offered.
  if (root === "box") return { ...none };
  if (root === "shared") return { ...none, remove: true };
  return none;
}
export type BulkAction = { id: "move" | "download" | "share" | "delete"; label: string };
export function bulkActions(root: string, selected: number): BulkAction[] {
  if (selected < 1) return [];
  const a = abilities(root);
  return [a.move ? { id: "move" as const, label: "Move" } : null, a.download ? { id: "download" as const, label: "Download" } : null, a.share ? { id: "share" as const, label: "Share" } : null, a.remove ? { id: "delete" as const, label: "Delete" } : null].filter((x): x is BulkAction => !!x);
}

export type Selection = { set: Set<string>; anchor: string | null };
export const selectOnly = (k: string): Selection => ({ set: new Set([k]), anchor: k });
export function selectToggle(s: Selection, k: string): Selection { const set = new Set(s.set); if (set.has(k)) set.delete(k); else set.add(k); return { set, anchor: k }; }
export function selectRange(s: Selection, keys: readonly string[], to: string): Selection {
  const a = keys.indexOf(s.anchor ?? to), b = keys.indexOf(to);
  if (a < 0 || b < 0) return selectOnly(to);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return { set: new Set(keys.slice(lo, hi + 1)), anchor: s.anchor ?? to };
}
export const selectAll = (keys: readonly string[]): Selection => ({ set: new Set(keys), anchor: keys[0] ?? null });
/** Keep only what is still listed (after a folder changes). */
export function prune(s: Selection, keys: readonly string[]): Selection { const have = new Set(keys); const set = new Set([...s.set].filter((k) => have.has(k))); return { set, anchor: s.anchor && have.has(s.anchor) ? s.anchor : null }; }

/** The row the focus lands on after a key; -1 when there is nothing to focus. */
export function moveFocus(cur: number, n: number, key: string): number {
  if (n < 1) return -1;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  if (cur < 0) return 0;
  return Math.min(n - 1, Math.max(0, cur + (key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0)));
}
