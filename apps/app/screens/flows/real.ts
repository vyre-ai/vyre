// Flows against the real vyred: flows.list, flows.graph, flows.get, flows.runs, flows.run, flows.card, flows.approve, flows.pause and flows.resume
// (core/flows/index.js over kernel/flows). The Flow's own words (trigger, step labels) come from the kernel's canvas data, never composed here.
import { callT as call } from "../../src/real/call-tool";

async function ask<T>(tool: string, input: Record<string, unknown> = {}): Promise<T> {
  const r = await call<T>(tool, input);
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export type RealFlow = { id: string; name: string; status: string; active: boolean; versions: number; paused: unknown; trigger: string; level?: string; line?: string };
export type Graph = { nodes: any[]; edges: { from: string; to: string; kind: "next" | "then" | "else" | "each" | "lane" }[]; trigger: string; warnings?: (string | { path?: string; message: string })[]; ok?: boolean };
export type RunRow = { id: string; flow: string; version: number; state: string; started_at: number; finished_at: number | null; tainted?: boolean; parent?: string; label?: string; error: { message?: string } | null };
export type Card = { id: string; version: number; hash: string; authorship: string; effects: any; caps: any; warnings: string[]; changes: string[]; text: string };

export async function listReal(): Promise<RealFlow[]> {
  const rows = await ask<{ id: string; name?: string; label?: string; status: string; active: boolean; versions: number; paused: unknown; level?: string; line?: string }[]>("flows.list");
  return Promise.all((Array.isArray(rows) ? rows : []).map(async (r) => {
    const g = await ask<Graph>("flows.graph", { id: r.id }).catch(() => null);
    // the Flow's own words, never its id: flows.list carries the label (the name is the code's)
    return { id: r.id, name: r.label || r.name || r.id, status: r.status, active: r.active, versions: r.versions, paused: r.paused, trigger: g?.trigger ?? "", level: r.level, line: r.line };
  }));
}

export const graphReal = (id: string) => ask<Graph>("flows.graph", { id });
export const getReal = (id: string) => ask<{ id: string; version: number; hash: string; status: string; approver: unknown; flow?: { label?: string; name?: string } }>("flows.get", { id });
export const healthReal = (id: string) => ask<{ level: string; line: string }>("flows.health", { id });
export const runsReal = (id: string) => ask<RunRow[]>("flows.runs", { id, limit: 20 });
/** A run in plain words and its lines (flows.describe by run): what it did, where it stands, what is next. */
export const explainReal = (run: string) => ask<{ explain?: string; lines?: string[] }>("flows.describe", { run });
export const runReal = (run: string) => ask<{ run: any; painted: { nodes: any[]; edges?: any[] } | null }>("flows.run", { run });
export const cardReal = (id: string, version: number) => ask<Card>("flows.card", { id, version });
/** A person's own approval of one version, by its hash. The box asks for the person's proof; the app's session answers it (a real Face ID or fingerprint prompt). */
export const approveReal = (id: string, version: number, hash: string) => ask("flows.approve", { id, version, hash });
export const setPausedReal = (id: string, paused: boolean) => ask(paused ? "flows.pause" : "flows.resume", { id });
