// Find, as pure functions: what a person typed, which box it narrows to, and the rows the box's answers become.
// The Deck's find.js and cmdbar.js, ported. Chats, projects, people, files and memory are searched together; a missing module says so once, faintly.
import type { FactHit, FileHit, RecallHit } from "../chat-tools/more-model.ts";

export const MIN = 2;
export const DEBOUNCE_MS = 150;
export type Scope = "all" | "chats" | "projects" | "people" | "files" | "memory";
export const SCOPES: [Scope, string][] = [["all", "All"], ["chats", "Chats"], ["projects", "Projects"], ["people", "People"], ["files", "Files"], ["memory", "Memory"]];
const PREFIX: Record<string, Scope> = { p: "projects", t: "chats", u: "people" };
export const PREFIX_HINT = "p projects, t chats, u people";
/** "p intake" narrows to projects and searches "intake". A word alone is not a prefix. */
export function parsePrefix(raw: string): { prefix: "p" | "t" | "u"; scope: Scope; rest: string } | null {
  const m = /^([ptu])\s+(.*)$/is.exec(String(raw || "").replace(/^\s+/, ""));
  if (!m) return null;
  const prefix = m[1].toLowerCase() as "p" | "t" | "u";
  return { prefix, scope: PREFIX[prefix], rest: m[2].trim() };
}
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hasAll = (text: unknown, ws: string[]) => { const t = String(text || "").toLowerCase(); return ws.every((w) => t.includes(w)); };
const baseName = (p: string) => String(p || "").split("/").filter(Boolean).pop() || "";
/** "~/work/site": the folder a file is in, kept short. */
export function parentOf(p: string): string {
  const parts = String(p || "").replace(/^\/(Users|home)\/[^/]+/, "~").split("/");
  parts.pop();
  return parts.join("/") || "/";
}

export type Session = { id: string; name: string; project: string | null; cwd: string; last: number | null };
/** projects.catalog's sessions and threads.list's threads as one list by id; a thread's own name wins. */
export function sessionsOf(catalog: any, threads: any): Session[] {
  const by = new Map<string, Session>();
  const put = (x: any) => {
    const id = String(x?.id ?? x?.session ?? "");
    if (!id) return;
    const old = by.get(id);
    by.set(id, { id, name: String(x.name || x.title || old?.name || ""), project: x.project ?? old?.project ?? null, cwd: String(x.cwd || old?.cwd || ""), last: typeof x.last === "number" ? x.last : typeof x.ts === "number" ? x.ts : old?.last ?? null });
  };
  for (const s of Array.isArray(catalog?.sessions) ? catalog.sessions : []) put(s);
  for (const t of Array.isArray(threads) ? threads : Array.isArray(threads?.threads) ? threads.threads : []) put(t);
  return [...by.values()];
}
export type Project = { slug: string; name: string };
export const projectsOf = (d: any): Project[] => (Array.isArray(d?.projects) ? d.projects : Array.isArray(d) ? d : []).filter((p: any) => p && p.slug).map((p: any) => ({ slug: String(p.slug), name: String(p.name || p.slug) }));
export type Agent = { name: string; kind: string; line: string };
export const agentsOf = (d: any): Agent[] => (Array.isArray(d) ? d : Array.isArray(d?.agents) ? d.agents : []).filter((a: any) => a && a.name).map((a: any) => ({ name: String(a.name), kind: String(a.kind || "agent"), line: String(a.instructions || "").split("\n")[0] }));

export type Row =
  | { key: string; kind: "chat"; title: string; sub: string; href: string }
  | { key: string; kind: "project"; title: string; sub: string; href: string }
  | { key: string; kind: "person"; title: string; sub: string; href: string }
  | { key: string; kind: "file"; title: string; sub: string; file: FileHit }
  | { key: string; kind: "memory"; title: string; sub: string; href: string };
export type Section = { id: Scope; label: string; rows: Row[] };

export const threadHref = (id: string) => `/session/${encodeURIComponent(id)}`;
export const projectHref = (slug: string) => `/u/project/${encodeURIComponent(slug)}`;

export type Base = { sessions: Session[]; projects: Project[]; agents: Agent[] };
export type Found = { chats?: RecallHit[]; files?: { results: FileHit[]; notes: string[] }; memory?: FactHit[]; missing: string[] };

/** The sections for a query: sessions by name and by what was said in them, then files, agents, memory and projects. A scope shows only its own. */
export function sectionsFor(raw: string, base: Base, found: Found, scope: Scope = "all"): Section[] {
  const pf = parsePrefix(raw);
  const q = pf ? pf.rest : raw.trim();
  const sc = pf ? pf.scope : scope;
  const ws = words(q);
  if (q.length < MIN) return [];
  const want = (s: Scope) => sc === "all" || sc === s;
  const names = new Map(base.projects.map((p) => [p.slug, p.name]));
  const out: Section[] = [];
  if (want("chats")) {
    const seen = new Set<string>();
    const rows: Row[] = [];
    const add = (id: string, title: string, snip: string, project: string | null, cwd: string, ts: number | null) => {
      if (seen.has(id)) return; seen.add(id);
      rows.push({ key: `c:${id}`, kind: "chat", title: title || id.slice(0, 8), sub: [snip, [project ? names.get(project) || project : baseName(cwd), ts ? new Date(ts).toLocaleDateString() : ""].filter(Boolean).join(" · ")].filter(Boolean).join("\n"), href: threadHref(id) });
    };
    for (const s of base.sessions) if (s.name && hasAll(s.name, ws)) add(s.id, s.name, "", s.project, s.cwd, s.last);
    const byId = new Map(base.sessions.map((s) => [s.id, s]));
    for (const r of found.chats ?? []) { const s = byId.get(r.session); add(r.session, s?.name || r.name, r.snippet, s?.project ?? null, s?.cwd || r.cwd, r.ts ?? s?.last ?? null); }
    if (rows.length) out.push({ id: "chats", label: "Chats", rows });
  }
  if (want("files") && found.files?.results.length) out.push({ id: "files", label: "Files", rows: found.files.results.map((f): Row => ({ key: `f:${f.source}:${f.path}`, kind: "file", title: f.name, sub: `${parentOf(f.path)} · ${f.source === "mac" ? "Mac" : "Box"}`, file: f })) });
  if (want("people")) {
    const rows = base.agents.filter((a) => hasAll(`${a.name} ${a.line}`, ws)).map((a): Row => ({ key: `a:${a.name}`, kind: "person", title: a.name, sub: a.kind === "assistant" ? "Your assistant" : a.line || "Agent", href: "/u/settings/assistants" }));
    if (rows.length) out.push({ id: "people", label: "People", rows });
  }
  if (want("memory") && found.memory?.length) out.push({ id: "memory", label: "From memory", rows: found.memory.map((f, i): Row => ({ key: `m:${i}`, kind: "memory", title: f.text, sub: f.source, href: `/u/memory?q=${encodeURIComponent(q)}` })) });
  if (want("projects")) {
    const rows = base.projects.filter((p) => hasAll(`${p.name} ${p.slug}`, ws)).map((p): Row => ({ key: `p:${p.slug}`, kind: "project", title: p.name, sub: "Project", href: projectHref(p.slug) }));
    if (rows.length) out.push({ id: "projects", label: "Projects", rows });
  }
  return out;
}
/** Say once, faintly, which part could not be searched. */
export function missingNotes(errs: { chats?: string; files?: string; memory?: string }): string[] {
  const out: string[] = [];
  if (errs.chats) out.push("Chats were not searched.");
  if (errs.files) out.push("Files were not searched.");
  if (errs.memory) out.push("Memory was not searched.");
  return out;
}
/** The last searches, newest first, no repeats, at most eight. */
export function remember(recent: string[], q: string): string[] {
  const t = q.trim();
  if (t.length < MIN) return recent;
  return [t, ...recent.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8);
}
/** The size of a file in words. */
export const sizeWords = (n: number | null) => (!n ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** What a files.preview answer shows: text, an image as a data URI, or nothing it can show. */
export function previewOf(d: any): { kind: "text"; text: string } | { kind: "image"; uri: string } | { kind: "none"; note: string } {
  if (d?.kind === "image" && typeof d.base64 === "string") return { kind: "image", uri: `data:${/^image\/[a-z0-9.+-]+$/i.test(String(d.mime)) ? d.mime : "image/png"};base64,${d.base64}` };
  if (typeof d?.text === "string") return { kind: "text", text: d.text.length > 20000 ? d.text.slice(0, 20000) + "…" : d.text };
  return { kind: "none", note: d?.note ? String(d.note) : "There is no preview for this file." };
}
