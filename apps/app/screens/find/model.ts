// The pure half of Find on every device: what the box has (sessions, projects, assistants, records, places), how a typed line narrows it (the p, t and u prefixes), what each search tool answers
// (recall.search, files.search, memory.relevant), and the one command the Enter key runs (@agent, tell, watch, or ask the assistant). The grammar and the session merge are the Deck's own
// (deck/js/commands.js, find-prefix.js, chat/lib/sessions.js), so a line means the same thing on every surface.
import { parseCommand, plan, type Command } from "../../src/vendor/deck/js/commands.js";
import { parsePrefix } from "../../src/vendor/deck/js/find-prefix.js";
import { mergeSessions, title as sessionTitle } from "../../src/vendor/deck/chat/lib/sessions.js";

export { parseCommand, plan, parsePrefix, mergeSessions, sessionTitle };
export type { Command };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

export const MIN = 2;
export const SHOW = 5;
export const RECENT_MAX = 8;
export const SCOPES: [Scope, string][] = [["all", "All"], ["chats", "Chats"], ["projects", "Projects"], ["people", "People"], ["files", "Files"], ["memory", "Memory"]];
export type Scope = "all" | "chats" | "projects" | "people" | "files" | "memory";

export const words = (q: string): string[] => q.toLowerCase().split(/\s+/).filter(Boolean);
export const hasAll = (text: unknown, ws: string[]): boolean => { const t = String(text || "").toLowerCase(); return ws.every((w) => t.includes(w)); };

/** What the box holds, loaded once when Find opens. */
export type Base = {
  assistant: string | null;
  agents: { name: string; kind: string; instructions: string }[];
  sessions: any[];
  projects: { slug: string; name: string }[];
  records: { id: string; type: string; typeLabel: string; title: string; sub: string; person: boolean }[];
  places: { id: string; label: string; href: string }[];
};
export const emptyBase = (): Base => ({ assistant: null, agents: [], sessions: [], projects: [], records: [], places: [] });

export function pickAgents(d: unknown): Base["agents"] {
  const list = Array.isArray(d) ? d : (d as { agents?: unknown } | null)?.agents;
  return arr(list).filter((a) => typeof a.name === "string").map((a) => ({ name: a.name as string, kind: str(a.kind), instructions: str(a.instructions) }))
    .sort((a, b) => (a.kind === "assistant" ? 0 : 1) - (b.kind === "assistant" ? 0 : 1));
}
export function pickProjects(d: unknown): Base["projects"] {
  const list = Array.isArray(d) ? d : (d as { projects?: unknown } | null)?.projects;
  return arr(list).filter((p) => typeof p.slug === "string").map((p) => ({ slug: p.slug as string, name: str(p.name) || (p.slug as string) }));
}
/** The sessions Find knows: projects.catalog's and threads.list's merged, newest first. */
export const pickSessions = (catalog: unknown, threads: unknown): any[] =>
  mergeSessions((catalog as { sessions?: any[] } | null)?.sessions ?? [], Array.isArray(threads) ? threads : (threads as { threads?: any[] } | null)?.threads ?? []);

/** Records as rows to search: a type's title field and its text values. A sealed field is never read. */
export function recordRows(types: any[], byType: Record<string, any[]>): Base["records"] {
  const out: Base["records"] = [];
  for (const t of types) {
    const fields: any[] = Array.isArray(t.fields) ? t.fields : [];
    const titleField = (t.view?.titleField as string | undefined) || fields[0]?.name;
    const label = str(t.label) || str(t.name);
    const textual = fields.filter((f) => ["text", "string", "email", "phone", "url", "choice", "longtext"].includes(f.kind) && f.kind !== "sealed" && !f.seal && f.name !== titleField).map((f) => f.name as string);
    for (const r of byType[t.name] ?? []) {
      const data = (r?.data ?? {}) as Record<string, unknown>;
      const title = str(data[titleField]) || String(r.id);
      out.push({ id: String(r.id), type: t.name, typeLabel: label, title, sub: textual.map((n) => str(data[n])).filter(Boolean).join(" "), person: t.name === "contact" });
    }
  }
  return out;
}

// ---- hits ----

export type Row = { key: string; title: string; sub?: string; snippet?: string; right?: string; kind: string; href?: string; session?: string; file?: FileHit; fact?: boolean };
export type FileHit = { name: string; path: string; kind: string; source: string };
export type Section = { key: string; label: string; rows: Row[]; notes?: string[] };
export type Fetched = { recall?: unknown; files?: unknown; memory?: unknown; mentions?: unknown };

const where = (base: Base, slug: string | null, cwd?: string | null): string => (slug ? base.projects.find((p) => p.slug === slug)?.name ?? slug : String(cwd || "").split("/").filter(Boolean).pop() || "");

/** Sessions that match: by name first, then what recall found in their words. */
export function sessionHits(base: Base, q: string, recall: unknown): Row[] {
  const ws = words(q);
  const byId = new Map(base.sessions.map((r: any) => [r.id, r]));
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of base.sessions) if (r.name && hasAll(r.name, ws)) { seen.add(r.id); out.push({ key: `s:${r.id}`, kind: "chat", title: sessionTitle(r), sub: [where(base, r.project, r.cwd), r.last ? ago(r.last) : ""].filter(Boolean).join(", "), session: r.id }); }
  for (const x of arr(recall)) {
    if (!x.session || seen.has(x.session)) continue;
    seen.add(x.session);
    const r = byId.get(x.session);
    out.push({ key: `s:${x.session}`, kind: "chat", title: r ? sessionTitle(r) : str(x.name) || str(x.title) || String(x.session).slice(0, 8), snippet: str(x.snippet), sub: [where(base, r?.project ?? null, r?.cwd ?? x.cwd), num(x.ts || r?.last) ? ago(num(x.ts || r?.last)) : ""].filter(Boolean).join(", "), session: String(x.session) });
  }
  return out;
}
export const projectHits = (base: Base, q: string): Row[] => { const ws = words(q); return base.projects.filter((p) => hasAll(`${p.name} ${p.slug}`, ws)).map((p) => ({ key: `p:${p.slug}`, kind: "project", title: p.name, href: `/u/project/${encodeURIComponent(p.slug)}` })); };
export function peopleHits(base: Base, q: string): Row[] {
  const ws = words(q);
  const agents = base.agents.filter((a) => hasAll(`${a.name} ${a.instructions}`, ws)).map((a): Row => ({ key: `a:${a.name}`, kind: "agent", title: a.name, sub: a.kind === "assistant" ? "your assistant" : a.instructions.split("\n")[0] || "agent", href: "/u/assistants" }));
  const people = base.records.filter((r) => r.person && hasAll(`${r.title} ${r.sub}`, ws)).map((r): Row => ({ key: `r:${r.id}`, kind: "person", title: r.title, sub: r.sub.slice(0, 60), href: `/u/record/${r.id}` }));
  return [...agents, ...people];
}
export const recordHits = (base: Base, q: string): Row[] => { const ws = words(q); return base.records.filter((r) => !r.person && hasAll(`${r.title} ${r.sub}`, ws)).map((r) => ({ key: `r:${r.id}`, kind: "record", title: r.title, sub: r.typeLabel, href: `/u/record/${r.id}` })); };
export const placeHits = (base: Base, q: string): Row[] => { const lc = q.toLowerCase(); return base.places.filter((p) => p.label.toLowerCase().includes(lc)).map((p) => ({ key: `g:${p.id}`, kind: "place", title: p.label, sub: "Go to", href: p.href })); };

/** files.search: the results, and a note for each machine that did not answer. The box never searches the Mac's files itself, so that is said unless the Mac answered. */
export function fileHits(d: unknown): { rows: Row[]; notes: string[] } {
  const o = (d && typeof d === "object" ? d : {}) as { results?: unknown; sources?: unknown };
  const results = arr(o.results);
  const sources = arr(o.sources);
  const notes = sources.filter((s) => s.ok === false).map((s) => `The ${s.source === "mac" ? "Mac" : s.source || "other machine"} did not answer${s.error ? `: ${s.error}` : "."}`);
  if (!sources.some((s) => s.source === "mac" && s.ok !== false) && !results.some((f) => f.source === "mac")) notes.push("Files on your Mac are not searched from here.");
  return { rows: results.filter((f) => typeof f.path === "string").map((f) => ({ key: `f:${f.path}`, kind: "file", title: str(f.name) || String(f.path).split("/").pop() || "", sub: shortDir(f.path), right: f.source === "mac" ? "mac" : "box", file: { name: str(f.name), path: f.path as string, kind: str(f.kind), source: str(f.source) } })), notes };
}
export const factHits = (d: unknown): Row[] => arr(d).filter((f) => f.text).map((f, i) => ({ key: `m:${i}:${String(f.text).slice(0, 20)}`, kind: "memory", title: String(f.text), sub: str(f.ref?.name) || str(f.source), href: "/u/memory", fact: true }));

/** Where a mentions.search result opens; null reads only. */
export const mentionRoute = (kind: string): string | null => (kind === "vault" ? "/u/vault" : kind === "drive" ? "/u/drive" : null);
/** mentions.search: names the box can find beyond what Find already searches (vault names, Drive, artifacts, GitHub), one section per kind. Records and sessions are Find's own, so they are left out;
 * a provider that was late or locked is named in a note. Names only, never a value. */
export function mentionSections(d: unknown): { sections: Section[]; note: string } {
  const o = (d && typeof d === "object" ? d : {}) as { groups?: unknown; unavailable?: unknown };
  const sections = arr(o.groups).filter((g) => Array.isArray(g.items) && g.items.length && g.kind !== "record" && g.kind !== "session").map((g): Section => {
    const kind = String(g.kind);
    return { key: `m:${kind}`, label: str(g.label) || kind, rows: arr(g.items).filter((i) => i.id !== undefined && i.name !== undefined).map((i): Row => ({ key: `m:${kind}:${i.id}`, kind: "mention", title: String(i.name), sub: str(i.hint), ...(mentionRoute(kind) ? { href: mentionRoute(kind)! } : {}) })) };
  }).filter((s) => s.rows.length);
  const down = (Array.isArray(o.unavailable) ? o.unavailable : []).filter((x): x is string => typeof x === "string");
  return { sections, note: down.length ? `${down.join(", ")} did not answer in time.` : "" };
}

/** A path's folder, kept short: "~/work/site", or the last two folders after an ellipsis. */
export function shortDir(p: unknown): string {
  const s = String(p || "").replace(/^\/(Users|home)\/[^/]+/, "~");
  const parts = s.split("/"); parts.pop();
  const dir = parts.join("/") || "/";
  const segs = dir.split("/").filter(Boolean);
  return segs.length > 3 ? `…/${segs.slice(-2).join("/")}` : dir;
}
/** "5 min ago", "yesterday", "12 days ago". */
export function ago(ms: number, now = Date.now()): string {
  const m = Math.max(0, Math.floor((now - ms) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : m < 2880 ? "yesterday" : `${Math.round(m / 1440)} days ago`;
}

/** The scope a typed line asks for: a p, t or u prefix narrows it; the words after it are what is searched. */
export function queryOf(raw: string, scope: Scope): { scope: Scope; q: string } {
  const p = parsePrefix(raw) as { scope: Scope; rest: string } | null;
  return p ? { scope: p.scope, q: p.rest } : { scope, q: raw.trim() };
}

/** The sections for a query, in the fixed order: Go to, Chats, Projects, People, Records, Files, Memory. A search tool that has not answered yet adds nothing; `missing` says which never will. */
export function sections(base: Base, raw: string, scope: Scope, fetched: Fetched): Section[] {
  const { scope: sc, q } = queryOf(raw, scope);
  if (q.length < 1) return [];
  const want = (s: Scope) => sc === "all" || sc === s;
  const out: Section[] = [];
  const add = (key: string, label: string, rows: Row[], notes: string[] = []) => { if (rows.length || notes.length) out.push({ key, label, rows, ...(notes.length ? { notes } : {}) }); };
  if (sc === "all") add("places", "Go to", placeHits(base, q).slice(0, 4));
  if (want("chats")) add("chats", "Chats", sessionHits(base, q, q.length >= MIN ? fetched.recall : undefined));
  if (want("projects")) add("projects", "Projects", projectHits(base, q));
  if (want("people")) { add("people", "People", peopleHits(base, q)); if (sc === "all") add("records", "Records", recordHits(base, q)); }
  if (want("files") && q.length >= MIN) { const f = fileHits(fetched.files); if (fetched.files !== undefined) add("files", "Files", f.rows, f.rows.length ? f.notes : []); }
  if (want("memory") && q.length >= MIN) add("memory", "From memory", factHits(fetched.memory));
  if (sc === "all" && q.length >= MIN && fetched.mentions !== undefined) for (const m of mentionSections(fetched.mentions).sections) out.push(m);
  return out;
}

/** What shows before anything is typed: the last searches, the most recent chats, and the places. */
export function idle(base: Base, recents: string[]): { recents: string[]; chats: Row[]; places: Row[] } {
  return {
    recents: recents.slice(0, RECENT_MAX),
    chats: base.sessions.filter((r) => r.name).slice(0, 4).map((r): Row => ({ key: `s:${r.id}`, kind: "chat", title: sessionTitle(r), sub: [where(base, r.project, r.cwd), r.last ? ago(r.last) : ""].filter(Boolean).join(", "), session: r.id })),
    places: base.places.map((p): Row => ({ key: `g:${p.id}`, kind: "place", title: p.label, href: p.href })),
  };
}

/** The recent searches, newest first, one of each (case aside), at most RECENT_MAX. */
export const addRecent = (list: string[], q: string): string[] => (q.length < MIN ? list : [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, RECENT_MAX));

// ---- the command Enter runs ----

/** The command for a line, and the session a drive or watch goes to (the first candidate unless one was chosen). */
export function readCommand(line: string, base: Base, chosen: string | null): { cmd: Command; chosen: any | null } {
  const cmd = parseCommand(line, { agents: base.agents as any, sessions: base.sessions, titleOf: sessionTitle as (r: any) => string }) as Command;
  const cands: any[] = "candidates" in cmd ? cmd.candidates : [];
  return { cmd, chosen: cands.find((c) => c.id === chosen) ?? cands[0] ?? null };
}
export const planLine = (cmd: Command, chosenTitle: string, assistant: string): string => plan(cmd, chosenTitle.length > 36 ? `${chosenTitle.slice(0, 35).trimEnd()}…` : chosenTitle, assistant);

/** The words after a command ran. */
export function doneLine(cmd: Command, name: string): string {
  if (cmd.kind === "agent") return `Sent to ${cmd.agent}.`;
  if (cmd.kind === "drive") return `Sent to ${name}. You will hear when it finishes or asks.`;
  if (cmd.kind === "watch") return `Watching ${name}. You will hear when it ${cmd.until === "asks" ? "asks" : cmd.until === "finished" ? "is done" : "finishes or asks"}.`;
  return "";
}
export const missingNote = (e: { code?: string; message?: string } | null | undefined): string => (e?.code === "no_such_tool" ? "That is not available on your server yet." : e?.message || "That did not go through.");

/** A file preview as what to draw: an image (a data address), text, or a line saying why not. */
export function previewOf(f: { kind: string }, d: unknown): { kind: "image"; uri: string } | { kind: "text"; text: string; truncated: boolean } | { kind: "none"; note: string } {
  if (!["text", "code", "image", "other"].includes(f.kind)) return { kind: "none", note: "No preview for this kind of file." };
  const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  if (o.kind === "image" && typeof o.base64 === "string") return { kind: "image", uri: `data:${/^image\/[a-z+.-]+$/i.test(str(o.mime)) ? str(o.mime) : "image/png"};base64,${o.base64}` };
  if (typeof o.text === "string") return { kind: "text", text: o.text, truncated: o.truncated === true };
  return { kind: "none", note: o.note ? `No preview: ${String(o.note)}.` : "No preview for this file." };
}

/** The rows in the order they are drawn, for the arrow keys: each section's shown rows (or all when it is open), or, with an empty box, the recent chats then the places. */
export function flatRows(secs: Section[], open: Record<string, boolean>, idleRows: Row[] = []): Row[] {
  return secs.length ? secs.flatMap((s) => (open[s.key] ? s.rows : s.rows.slice(0, SHOW))) : idleRows;
}
/** The highlighted row after an arrow key: Down from nothing is the first, Up from the first is nothing (back to the box). */
export const stepHi = (hi: number, key: "ArrowDown" | "ArrowUp", n: number): number => (n ? (key === "ArrowDown" ? Math.min(n - 1, hi + 1) : Math.max(-1, hi - 1)) : -1);
