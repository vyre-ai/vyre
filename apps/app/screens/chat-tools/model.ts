// The chat tools sheet's pure side (the Deck's chat/core/composer-state, answer-with, undo-sheet, tag-picker and cards, ported): words, shapes and inputs.

/** The levels threads.effort takes; null is the model's own default. */
export const EFFORTS: { id: string | null; label: string }[] = [
  { id: null, label: "Default" }, { id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "Extra high" }, { id: "max", label: "Max" },
];
/** What threads.mode takes, in the order a person walks them. Bypass is only ever read, never offered. */
export const MODES = ["default", "acceptEdits", "plan"] as const;
const MODE_LABELS: Record<string, string> = { default: "Asks first", acceptEdits: "Accepts edits", plan: "Plan mode", bypassPermissions: "Doesn't ask" };
export const modeLabel = (mode?: string | null) => MODE_LABELS[mode || "default"] || String(mode);
/** The modes to offer: the session's own list narrowed to what threads.mode takes, else all three. */
export function modesOf(offered?: readonly string[] | null): string[] {
  const n = offered && offered.length ? MODES.filter((m) => offered.includes(m)) : [];
  return n.length ? [...n] : [...MODES];
}
export const effortLabel = (id?: string | null) => EFFORTS.find((e) => e.id === (id ?? null))?.label || String(id);

export type Result = { ok: true; note?: string } | { ok: false; reason: string };
const asReason = (e: any, f = "That did not go through.") => String(e?.message || e?.code || f);
export const failure = (e: unknown, f?: string): Result => ({ ok: false, reason: asReason(e, f) });

/** A change that applies only to a running session answers `{ <key>: null, note }`; say why it did not take. */
export function appliedOr(d: any, key: string, fallback: string): Result {
  if (d && Object.prototype.hasOwnProperty.call(d, key) && d[key] === null) return { ok: false, reason: String(d.note || fallback) };
  return { ok: true };
}

export type Task = { id: string; title: string; status: string };
/** threads.tasks' answer: the thread's background tasks, only the ones still running first. */
export function tasksOf(d: any): Task[] {
  const list = Array.isArray(d) ? d : Array.isArray(d?.tasks) ? d.tasks : [];
  const rows = list.filter((t: any) => t && (t.id != null)).map((t: any) => ({ id: String(t.id), title: String(t.title ?? t.description ?? t.command ?? t.id), status: String(t.status ?? "running") }));
  const live = (s: string) => /^(running|working|started|pending)$/i.test(s);
  return [...rows.filter((t: Task) => live(t.status)), ...rows.filter((t: Task) => !live(t.status))];
}
export const taskLive = (t: Task) => /^(running|working|started|pending)$/i.test(t.status);

export type Commit = { sha: string; subject: string };
/** github.session.history's answer, cleaned, newest first. */
export function historyOf(d: any): { commits: Commit[]; dirty: number } {
  const commits = (Array.isArray(d?.commits) ? d.commits : []).filter((c: any) => c && typeof c.sha === "string" && c.sha).map((c: any) => ({ sha: String(c.sha), subject: String(c.subject || "(no message)") }));
  return { commits, dirty: Number(d?.dirty) > 0 ? Number(d.dirty) : 0 };
}
/** How many commits come off if the person goes back to this one: it and all the newer ones. */
export function takesOff(commits: Commit[], sha: string | null): number {
  if (sha === null) return commits.length;
  const i = commits.findIndex((c) => c.sha === sha);
  return i < 0 ? 0 : i + 1;
}
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
export function undoneLine(out: any): string {
  const n = Number(out?.undone) || 0;
  return `${n === 0 ? "Nothing to take off" : "Took off " + plural(n, "change")}${out?.kept_unsaved ? ", and kept your unsaved work with it" : ""}.`;
}
export function redoneLine(out: any): string {
  const n = Number(out?.redone) || 0;
  return n === 0 ? "Nothing to put back." : `Put back ${plural(n, "change")}.`;
}

export type Mention = { kind: string; id: string; name: string; hint: string };
const MENTION_ORDER = ["teammate", "project", "session", "vault", "artifact", "drive", "github"];
/** mentions.search's answer as one flat list: results, or groups of results. Names and hints only. */
export function mentionsOf(d: any): Mention[] {
  const list = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : Array.isArray(d?.groups) ? d.groups.flatMap((g: any) => (g?.results || g?.items || []).map((x: any) => ({ kind: g.kind, ...x }))) : [];
  const rank = (k: string) => { const n = MENTION_ORDER.indexOf(k); return n < 0 ? MENTION_ORDER.length : n; };
  return list.map((x: any) => ({ kind: String(x?.kind ?? ""), id: String(x?.id ?? x?.name ?? ""), name: String(x?.name ?? ""), hint: String(x?.hint ?? "") }))
    .filter((x: Mention) => x.kind && x.id && x.name)
    .sort((a: Mention, b: Mention) => rank(a.kind) - rank(b.kind) || a.name.localeCompare(b.name));
}
/** The text a pick writes into the draft: "@name" for people and agents, "#name" for everything else. */
export const mentionText = (m: Mention) => `${m.kind === "teammate" ? "@" : "#"}${m.name.replace(/\s+/g, "-")} `;

/** context.now's answer as the lines "Context used" shows: what Vyre can see from here, only what is known. */
export function contextLines(d: any): { label: string; value: string }[] {
  const rows: [string, unknown][] = [["Project", d?.project], ["Folder", d?.cwd], ["Screen", d?.view], ["App", d?.app], ["Window", d?.window], ["Page", d?.url]];
  return rows.filter(([, v]) => typeof v === "string" && v).map(([label, v]) => ({ label, value: String(v) }));
}

export type Line = { who: "you" | "assistant" | "tool" | "thinking"; text: string };
/** recall.transcript's blocks as short lines for a read-only history. Long text is cut; tool output is not shown. */
export function transcriptLines(d: any): Line[] {
  const blocks = Array.isArray(d) ? d : Array.isArray(d?.blocks) ? d.blocks : Array.isArray(d?.turns) ? d.turns.flatMap((t: any) => t?.blocks || []) : [];
  const cut = (s: string) => { const one = s.replace(/\s+/g, " ").trim(); return one.length > 280 ? one.slice(0, 279) + "…" : one; };
  const out: Line[] = [];
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    const text = typeof b.text === "string" ? b.text : typeof b.content === "string" ? b.content : "";
    if (b.type === "user" && text) out.push({ who: "you", text: cut(text) });
    else if (b.type === "text" && text) out.push({ who: "assistant", text: cut(text) });
    else if (b.type === "thinking" && text) out.push({ who: "thinking", text: cut(text) });
    else if (b.type === "tool") out.push({ who: "tool", text: String(b.name || b.tool || "A tool ran") });
  }
  return out;
}

export type PrAct = "merge" | "changes" | "comment";
/** A PR action's tool and input. A review needs words; a merge does not. Returns the line to show when it is not complete. */
export function prCall(act: PrAct, base: { project: string; pr: number }, note: string, replyTo?: number | null): { tool: string; input: Record<string, unknown> } | { problem: string } {
  if (act === "merge") return { tool: "github.project.pr.merge", input: { ...base } };
  const body = note.trim();
  if (!body) return { problem: act === "changes" ? "Say what to change." : "Write the comment first." };
  return { tool: "github.project.pr.review", input: { ...base, event: act === "changes" ? "REQUEST_CHANGES" : "COMMENT", body, ...(replyTo != null ? { in_reply_to: replyTo } : {}) } };
}

export type Shared = { id: string; title: string; kind: string; shared: boolean; project: string };
/** artifacts.list's answer as rows, newest first as the box sends them. */
export function sharedRows(d: any): Shared[] {
  const list = Array.isArray(d) ? d : Array.isArray(d?.artifacts) ? d.artifacts : [];
  return list.filter((a: any) => a && a.id).map((a: any) => ({ id: String(a.id), title: String(a.title || a.name || a.id), kind: String(a.kind || "file"), shared: !!(a.shared || a.public || a.share), project: String(a.project || "") }));
}
/** artifacts.share's answer: the link, a bare string or `url` or `link`. */
export function linkOf(d: any): string {
  const u = typeof d === "string" ? d : d?.url ?? d?.link ?? "";
  return typeof u === "string" ? u : "";
}
export type Version = { v: number; at: number | null; by: string };
export function versionsOf(d: any): Version[] {
  const list = Array.isArray(d) ? d : Array.isArray(d?.versions) ? d.versions : [];
  return list.map((x: any) => ({ v: Number(x?.v ?? x?.version), at: typeof x?.at === "number" ? x.at : typeof x?.created_at === "number" ? x.created_at : null, by: String(x?.by ?? x?.author ?? "") })).filter((x: Version) => Number.isFinite(x.v));
}
