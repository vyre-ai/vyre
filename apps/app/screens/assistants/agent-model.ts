import { timeOf } from "../../src/time/show.js";
// The pure half of an assistant's page and the New assistant form (the Deck's views/agents.js and js/agent-create.js, ported): the lines the screens show and the input the box takes.

import { modelChoices } from "../../src/chat/core/composer-state.js";

export type AgentFull = { name: string; kind?: string; role?: string; projects?: unknown; instructions?: string | null; model?: string | null; effort?: string | null; computer?: boolean; status?: string; thread?: string | null };
export type Watcher = { name: string; source?: string; trigger?: string; cadence?: string; schedule?: string; agent?: string; paused?: boolean; files?: unknown; project?: string };
export type Computer = { agent?: string; state?: string; screen?: number | null; screens?: number; size?: { w?: number; h?: number }; viewers?: number; takeover?: string | null; paused?: boolean; cpus?: number; memory_gb?: number; label?: string | null };
export type UsageFull = { agent: string | null; auth?: string; turns?: number; threads?: number; spent_usd?: number; budget_usd?: number | null; left_usd?: number | null; duration_ms?: number; last_at?: number | null; tokens?: Record<string, number>; limit?: { status?: string; kind?: string; utilization?: number; resets_at?: number } | null };

export const EFFORT: [string, string][] = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
/** The model picker's rows: the box's own list (sessions.models.get aliases), plus the agent's model when it is not on it. No list lives here (test/cohesion-drift.test.js). */
export const modelsFor = (current?: string | null, aliases?: unknown): { id: string; name: string }[] =>
  modelChoices({ current, aliases }).map((m) => ({ id: m.id, name: m.label }));

const SOURCES: Record<string, string> = { gmail: "Gmail", slack: "Slack", schedule: "Schedule", github: "GitHub", fathom: "Fathom", files: "Files", web: "Web" };
export const sourceName = (s?: string) => (s && SOURCES[s]) || String(s || "Watcher").replace(/^./, (c) => c.toUpperCase());

/** The watchers that wake one agent: those it owns, and those that name nobody. */
export function watchersFor(data: unknown, agent: string): Watcher[] {
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray((data as any)?.watchers) ? (data as any).watchers : [];
  return list.filter((x): x is Watcher => !!x && typeof x === "object" && typeof (x as Watcher).name === "string" && (!(x as Watcher).agent || (x as Watcher).agent === agent));
}
/** "Gmail: mail labelled Ads arrives" and where it looks. */
export function watcherLine(w: Watcher, names: Map<string, string> = new Map()): { title: string; sub: string } {
  const files = Array.isArray(w.files) ? w.files.map((s) => names.get(String(s)) || String(s)).join(", ") : typeof w.files === "string" ? w.files : w.project ? names.get(w.project) || w.project : "Any project";
  return { title: `${sourceName(w.source)}: ${w.trigger || w.cadence || w.schedule || w.name}`, sub: files };
}
export const NO_WATCHER = (name: string) => `Nothing wakes ${name} yet. It works when you talk to it. Ask your assistant for one in plain words, for example "wake ${name} when mail labelled Ads arrives".`;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;
const since = (at: number, now: number) => {
  const m = Math.max(0, Math.round((now - at) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${plural(m, "minute")} ago` : m < 1440 ? `${plural(Math.round(m / 60), "hour")} ago` : `${plural(Math.round(m / 1440), "day")} ago`;
};
const clock = (ms: number) => timeOf(ms);

/** What this agent has used: money only on an API key, turns otherwise, tokens and a limit warning. */
export function usageView(u: UsageFull | undefined, name: string, now = Date.now()): { empty: string } | { top: string; sub: string; warn: string } {
  if (!u || (!u.turns && !u.last_at)) return { empty: `${name} has not run yet.` };
  const money = u.auth === "api-key";
  const t = u.tokens || {};
  const tokens = (t.input || 0) + (t.output || 0) + (t.cache_read || 0) + (t.cache_write || 0);
  const top = money
    ? `$${(u.spent_usd || 0).toFixed(2)}${u.budget_usd != null ? ` of $${u.budget_usd.toFixed(2)}` : " spent, no budget set"}${u.left_usd != null ? `, $${u.left_usd.toFixed(2)} left` : ""}`
    : `${plural(u.turns || 0, "turn")} over ${plural(u.threads || 0, "thread")}`;
  const sub = [u.duration_ms ? `${Math.max(1, Math.round(u.duration_ms / 60000))} min of work` : "", tokens ? `${tokens.toLocaleString("en-US")} tokens` : "", u.last_at ? `last used ${since(u.last_at, now)}` : ""].filter(Boolean).join(", ");
  const l = u.limit;
  const warn = l && l.status && l.status !== "allowed" && l.resets_at
    ? l.status === "rejected" ? `Stopped by a limit${l.kind ? ` (${l.kind})` : ""}. Resets around ${clock(l.resets_at * 1000)}.`
      : `Near a limit${l.kind ? ` (${l.kind})` : ""}${l.utilization != null ? `, ${Math.round(l.utilization * 100)}% used` : ""}. Resets around ${clock(l.resets_at * 1000)}.` : "";
  return { top, sub, warn };
}

/** The computer card: how it is now and its specs. */
export function computerView(c: Computer, name: string): { live: string; specs: [string, string][]; canWatch: boolean } {
  const live = c.takeover ? `Taken over from ${c.takeover}. ${name}'s hands wait.`
    : c.state === "running" && c.screen ? `Live. Screen ${c.screen} of ${c.screens ?? "?"} from the pool.`
    : c.state === "running" ? "Running, not on a screen right now."
    : c.state === "frozen" ? `Resting. It wakes when ${name} or you need it.`
    : c.state === "stopped" ? `Stopped. It starts when ${name} or you need it.`
    : `Not made yet. It is made the first time ${name} or you need it.`;
  const size = c.size || {};
  return {
    live,
    canWatch: c.state === "running",
    specs: [
      ["Processor", `${c.cpus ?? "?"} ${c.cpus === 1 ? "core" : "cores"}`],
      ["Memory", `${c.memory_gb ?? "?"} GB`],
      ["Screen", size.w ? `${size.w} by ${size.h}` : "?"],
      ["Name", c.label || `${name}'s computer`],
      ["Watching", c.viewers ? plural(c.viewers, "screen") : "Nobody"],
      ...(c.paused ? [["Hands", `${name}'s hands are paused.`] as [string, string]] : []),
    ],
  };
}

/** Cores and memory as typed. Whole numbers inside what a computer can be given, or the line to show. */
export function limitsInput(cores: string, memory: string): { input: { cpus: number; memory_gb: number } } | { problem: string } {
  const cpus = Number(cores), memory_gb = Number(memory);
  if (!Number.isInteger(cpus) || cpus < 1 || cpus > 16) return { problem: "Cores are a whole number from 1 to 16." };
  if (!Number.isInteger(memory_gb) || memory_gb < 1 || memory_gb > 64) return { problem: "Memory is a whole number of GB from 1 to 64." };
  return { input: { cpus, memory_gb } };
}

export const VAULT_SUB = "claude-setup-token";
export const VAULT_KEY = "anthropic-api-key";
export type NewAgentForm = { name: string; instructions: string; projects: string[]; hasProjects: boolean; runsOn: "subscription" | "key"; budget: string; computer: boolean };
export const NEW_FORM: NewAgentForm = { name: "", instructions: "", projects: [], hasProjects: true, runsOn: "subscription", budget: "10", computer: false };

/** What agents.create takes from the form, or the one line to show. Same rules as the Deck: lowercase slug, at least one project, a budget above zero. */
export function createInput(f: NewAgentForm): { input: Record<string, unknown> } | { problem: string } {
  const name = f.name.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) return { problem: "A name is lowercase letters, digits and dashes, starting with a letter." };
  if (f.hasProjects && !f.projects.length) return { problem: "Pick at least one project. An agent never sees projects outside its list." };
  const budget = Number(f.budget);
  if (f.runsOn === "key" && !(budget > 0)) return { problem: "The budget is a number of dollars above zero." };
  const auth = f.runsOn === "key" ? { vault: VAULT_KEY, budget_usd: budget } : { vault: VAULT_SUB };
  return { input: { name, kind: "agent", projects: f.projects, instructions: f.instructions.trim(), auth, computer: f.computer } };
}

/** The project slugs and names from projects.list (an array, or { projects }). */
export function projectsOf(data: unknown): { slug: string; name: string }[] {
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray((data as any)?.projects) ? (data as any).projects : [];
  return list.flatMap((p: any) => (p && typeof p.slug === "string" ? [{ slug: p.slug, name: String(p.name || p.slug) }] : []));
}
