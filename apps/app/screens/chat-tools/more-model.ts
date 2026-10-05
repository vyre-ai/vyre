import { actedVia } from "../../src/store-core/kernel-view.js";
// The rest of the chat tools as pure models: the watcher card, the spend cap, the assistant's welcome, artifact activity,
// files and recall answers. Shapes are the ones the Deck read; every field is checked, nothing is trusted to exist.

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (d: any, key: string): any[] => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);

export type WatcherCard = {
  name: string; hash: string; state: "draft" | "on" | "paused" | string; owner: string; described: "by its author" | "by Vyre";
  lines: { when: string; check: string; do: string };
  facts: { reads: string[]; readsText: string; credentials: { host: string; item: string }[]; acts: string; cost: string; schedule: string };
};
/** watchers.card's answer. Returns null when it has no name. The facts are drawn as given, never reworded. */
export function watcherCardOf(d: any): WatcherCard | null {
  if (!d || typeof d.name !== "string") return null;
  const f = d.facts && typeof d.facts === "object" ? d.facts : {};
  const l = d.lines && typeof d.lines === "object" ? d.lines : {};
  const creds = (Array.isArray(f.credentials) ? f.credentials : []).filter((c: any) => c && (c.item || c.host)).map((c: any) => ({ host: str(c.host), item: str(c.item) }));
  return {
    name: d.name, hash: str(d.hash), state: str(d.state) || "draft", owner: ownerWords(d.owner),
    described: d.described === "by its author" ? "by its author" : "by Vyre",
    lines: { when: str(l.when), check: str(l.check), do: str(l.do) },
    facts: { reads: Array.isArray(f.reads) ? f.reads.map(String) : [], readsText: str(f.readsText), credentials: creds, acts: str(f.acts), cost: str(f.cost), schedule: str(f.schedule) },
  };
}
/** "Owned by kit" / "Owned by the intake project". */
export const ownerWords = (o: any) => (!o || typeof o !== "object" ? "" : o.kind === "teammate" ? `Owned by ${o.teammate}` : `Owned by the ${o.project} project`);
/** The box refuses a turn on when the code moved after the card was shown; the card offers the new one and never turns on unseen code. */
export const changedAfterCard = (message: string) => /changed after its card was shown/i.test(message);
/** The watchers call for a state change, with the card's own hash on a turn on or back on. */
export function watcherCall(act: "on" | "pause" | "resume", card: Pick<WatcherCard, "name" | "hash">): { tool: string; input: Record<string, unknown> } {
  if (act === "pause") return { tool: "watchers.pause", input: { name: card.name } };
  return { tool: act === "resume" ? "watchers.resume" : "watchers.create", input: { name: card.name, hash: card.hash } };
}

/** A provider name checked as a name; never read out of a line's words. */
export const providerOf = (v: unknown) => (/^[a-z][a-z0-9-]{1,30}$/.test(String(v)) ? String(v) : "");
/** The dollar amount a person typed, or null. Two places, more than zero. */
export function capDollars(raw: string): number | null {
  const n = Number(String(raw).replace(/^\$/, "").trim());
  return n > 0 && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
export const usd = (n: number) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);
/** What to start the field with: the event's own suggestion, else double the cap, else ten. */
export const suggestedCap = (data: any) => (Number(data?.action?.input?.to) > 0 ? Number(data.action.input.to) : Math.ceil(Number(data?.cap || 0) * 2) || 10);
/** spend.raise's input: a new cap, or none. */
export const raiseInput = (provider: string, dollars: number | null) => (dollars == null ? { provider, off: true } : { provider, to: dollars });
/** The line after a raise (cap null means none now). */
export function capLine(provider: string, cap: number | null): string {
  const name = provider === "all" || !provider ? "" : provider[0].toUpperCase() + provider.slice(1);
  if (cap === null) return name ? `${name} has no daily cap now.` : "There is no daily cap over every provider now.";
  return name ? `${name} daily cap is ${usd(cap)}. Resume the thread to go on.` : `The daily cap over every provider is ${usd(cap)}. Resume to go on.`;
}

export type WelcomeCard = { id: string; title: string; body: string; href: string };
/** assistant.welcome: its words and the cards that still have something to do. A card carries words and an https link, never a tool. */
export function welcomeOf(d: any): { text: string; cards: WelcomeCard[] } {
  const cards = list(d, "cards").filter((c: any) => c && typeof c.id === "string" && c.title).map((c: any) => ({ id: c.id, title: str(c.title), body: str(c.body), href: /^https:\/\//.test(str(c.href)) ? str(c.href) : "" }));
  return { text: str(d?.text), cards };
}

export type Activity = { at: number | null; kind: string; by: string; line: string; via?: "assistant" };
const KINDS: Record<string, string> = { "navigated-away": "It tried to leave its page", opened: "Opened", shared: "Link made", unshared: "Link turned off", edited: "A new version", "version-added": "A new version" };
/** artifacts.activity.log's rows, newest first. */
export function activityOf(d: any): Activity[] {
  return list(d, "events").concat(Array.isArray(d?.log) ? d.log : []).filter((e: any) => e && (e.kind || e.type)).map((e: any) => {
    const kind = str(e.kind || e.type);
    return { ...(actedVia(e) ? { via: "assistant" as const } : {}), at: typeof e.at === "number" ? e.at : typeof e.ts === "number" ? e.ts : null, kind, by: str(e.by || e.actor), line: KINDS[kind] || kind.replace(/[-_.]/g, " ") };
  }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
/** The box's own bytes for a version, rendered in a frame with its own CSP, or media as itself. Same-origin path; never an absolute URL from data. */
export const renderPath = (id: string, v: number) => `/v1/artifacts/content?id=${encodeURIComponent(id)}&v=${encodeURIComponent(String(v))}`;
export const mediaPath = (id: string, download = false) => `/v1/artifacts/content?id=${encodeURIComponent(id)}${download ? "&download=1" : ""}`;
export const MEDIA_KINDS = new Set(["image", "video", "audio"]);

export type FileHit = { name: string; path: string; kind: string; source: "mac" | "box"; size: number | null; mtime: number | null; repo: string };
const fileOf = (f: any): FileHit | null => (f && typeof f.path === "string" && f.path ? { name: str(f.name) || f.path.split("/").pop() || f.path, path: f.path, kind: str(f.kind) || "file", source: f.source === "mac" ? "mac" : "box", size: typeof f.size === "number" ? f.size : null, mtime: typeof f.mtime === "number" ? f.mtime : null, repo: str(f.repo) } : null);
/** files.search's answer: hits, and a plain note for each machine that did not answer. */
export function fileHitsOf(d: any): { results: FileHit[]; notes: string[] } {
  const results = list(d, "results").map(fileOf).filter((x): x is FileHit => !!x);
  const sources = Array.isArray(d?.sources) ? d.sources : [];
  const notes = sources.filter((s: any) => s && s.ok === false).map((s: any) => `The ${s.source === "mac" ? "Mac" : s.source || "other machine"} did not answer${s.error ? ": " + s.error : "."}`);
  if (!sources.some((s: any) => s && s.source === "mac" && s.ok !== false) && !results.some((f) => f.source === "mac")) notes.push("Files on your Mac are not searched from here.");
  return { results, notes };
}
/** files.recent's answer: the newest first. */
export function recentFilesOf(d: any): FileHit[] {
  return list(d, "files").concat(Array.isArray(d?.results) ? d.results : []).map(fileOf).filter((x): x is FileHit => !!x);
}

export type RecallHit = { session: string; name: string; snippet: string; ts: number | null; cwd: string };
/** recall.search / recall.related rows. «» markers around a match are dropped. */
export function recallOf(d: any): RecallHit[] {
  return list(d, "results").filter((x: any) => x && x.session).map((x: any) => ({ session: String(x.session), name: str(x.name || x.title), snippet: str(x.snippet || x.text).replace(/[«»]/g, ""), ts: typeof x.ts === "number" ? x.ts : null, cwd: str(x.cwd) }));
}
export type FactHit = { text: string; source: string };
/** memory.relevant's rows. */
export function factsOf(d: any): FactHit[] {
  return list(d, "facts").filter((f: any) => f && f.text).map((f: any) => ({ text: str(f.text), source: str(f.ref?.name || f.source) }));
}
/** recall.index's answer as "null, or the problem in plain words". */
export function indexProblem(e: { code?: string; message?: string; module?: string } | null): string | null {
  if (!e) return null;
  return e.code === "missing" || e.code === "not_available" ? "The history module is not running, so history cannot be read here." : String(e.message || "History could not be read.");
}
