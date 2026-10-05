// The pure half of the project page's Brief, Files and Memory tabs (the Deck's deck/views/projects.js): the brief's lines without the preamble written for the model, the threads that
// belong to the project, the files its threads touched, the facts Memory learned from them, and each repo folder's GitHub status. Names and counts only; nothing here holds file contents.

export type Tab = "project" | "brief" | "files" | "memory" | "team";
export const TAB_LABELS: [Tab, string][] = [["project", "Project"], ["brief", "Brief"], ["files", "Files"], ["memory", "Memory"], ["team", "Team"]];

/** A Project record's id (the kernel's v4 uuid): what the box's team tools take. A short name is anything else. */
export const isRecordId = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const noSlugLine = "This project has no short name on the box yet, so there is nothing to read here.";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

/** The project row (projects.list) for a short name: its name, its home folder and its other workspace folders. */
export type ProjectInfo = { slug: string; name: string; home: string; workspaces: string[] };
export function projectOf(d: unknown, slug: string): ProjectInfo | null {
  const list = arr((d as { projects?: unknown } | null)?.projects);
  const p = list.find((x) => x.slug === slug && !x.machine && x.source !== "mac");
  return p ? { slug, name: str(p.name) || slug, home: str(p.home), workspaces: (Array.isArray(p.workspaces) ? p.workspaces : []).filter((w): w is string => typeof w === "string") } : null;
}

export type BriefLine = { text: string; mono: boolean; heading: boolean };
/** The brief's lines without the preamble addressed to the model; Repo/Drive/Home/Folder lines are mono, and a section's first line is a heading. */
export function briefLines(text: unknown): BriefLine[] {
  return String(text ?? "").split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((s) => !/^You are working in the Vyre project/.test(s) && !/^This brief is background from Vyre/.test(s))
    .map((s) => ({ text: s.replace(/^- /, ""), mono: /^(Repo|Drive|Home|Folder)s?:/i.test(s), heading: /^(- )?(People|Other threads|From this project)/.test(s) }));
}

export type Item = { id: string; name: string; at: number };
/** The project's threads, live ones (running or waiting) first by recency, then the recorded ones. A thread on another machine is not here. */
export function itemsOf(threads: unknown, recorded: unknown, slug: string): Item[] {
  const live = arr(threads).filter((t) => (t.project || null) === slug && (t.state === "running" || t.state === "waiting"));
  const ids = new Set(live.map((t) => String(t.id)));
  return [
    ...live.sort((a, b) => num(b.last) - num(a.last)).map((t) => ({ id: String(t.id), name: str(t.name) || String(t.id), at: num(t.last) || num(t.started) })),
    ...arr(recorded).filter((t) => t.id && !ids.has(String(t.id))).map((t) => ({ id: String(t.id), name: str(t.label) || str(t.name) || str(t.title) || String(t.id), at: num(t.last) })),
  ];
}

export type Touched = { path: string; tool: string; at: number; thread: string; threadName: string };
/** The files the project's threads touched (harness.touched per thread), newest first. `results` is one answer per item, in order. */
export function touchedRows(items: Item[], results: unknown[]): Touched[] {
  return results.flatMap((r, i) => arr(r).filter((f) => typeof f.path === "string").map((f) => ({ path: String(f.path), tool: str(f.tool), at: num(f.at), thread: items[i]?.id ?? "", threadName: items[i]?.name ?? "" })))
    .sort((a, b) => b.at - a.at);
}
/** A path split into its folder (the last two folders, shortened) and its file name. */
export function splitPath(p: string): { dir: string; base: string } {
  const i = p.lastIndexOf("/");
  if (i < 0) return { dir: "", base: p };
  const parts = p.slice(0, i + 1).split("/").filter(Boolean);
  return { dir: (parts.length > 2 ? "…/" : p.startsWith("/") ? "/" : "") + parts.slice(-2).join("/") + (parts.length ? "/" : ""), base: p.slice(i + 1) };
}

export type Fact = { id: string; text: string; from: string };
/** memory.facts for the project's folders. */
export const factsOf = (d: unknown): Fact[] => arr((d as { facts?: unknown } | null)?.facts).filter((f) => f.text).map((f, i) => ({ id: str(f.id) || `f${i}`, text: String(f.text), from: str(f.ref?.name) || str(f.source) || "a thread" }));
/** The folders memory.facts is asked about: the home and every other workspace, once each. */
export const foldersOf = (p: ProjectInfo): string[] => [...new Set([p.home, ...p.workspaces].filter(Boolean))];

export type Repo = { folder: string; status: string; link: string | null };
/** github.project.detect: one row per workspace folder, saying whether it is connected to a GitHub repo. A link is only ever https://github.com/<owner>/<name>. */
export function reposOf(d: unknown): Repo[] {
  return arr((d as { workspaces?: unknown } | null)?.workspaces).map((w) => {
    const remotes = arr(w.remotes);
    const matched = remotes.find((r) => r.match), named = remotes.find((r) => r.full_name);
    const full = str(matched?.full_name);
    return {
      folder: String(w.folder ?? "").split("/").filter(Boolean).pop() || String(w.folder ?? ""),
      status: matched ? `Connected to ${full}` : named ? `${named.full_name}, but the connected account can't reach it right now` : w.isRepo ? "Git repo, not GitHub" : "Not a git repo",
      link: matched && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(full) ? `https://github.com/${full}` : null,
    };
  });
}
