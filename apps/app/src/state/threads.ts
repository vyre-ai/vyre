import { create } from "zustand";

/** A session as threads.list gives it (team/archive/CONTRACT-native-apps.md 3.2), the fields Chats draws. */
export type ThreadRow = {
  id: string;
  name: string | null;
  agent: string | null;
  project: string | null;
  /** The project's name (projects.list), when known. */
  projectName?: string | null;
  status: string;
  asks: number;
  last: number;
  model: string | null;
  stopped_reason?: string | null;
};

type ThreadsState = { items: readonly ThreadRow[]; from: "none" | "cache" | "box" };

const useThreadsStore = create<ThreadsState>()(() => ({ items: [], from: "none" }));

export const useThreads = () => useThreadsStore((s) => s.items);
export const useThreadsFrom = () => useThreadsStore((s) => s.from);
export const useThread = (id: string) => useThreadsStore((s) => s.items.find((t) => t.id === id) ?? null);
export const threadsStore = { get: useThreadsStore.getState, set: useThreadsStore.setState };

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** threads.list's records, newest first; anything that is not one is dropped. */
export function toThreads(v: unknown): ThreadRow[] {
  if (!Array.isArray(v)) return [];
  const out: ThreadRow[] = [];
  for (const r of v) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const id = s(o.id);
    if (!id) continue;
    out.push({
      id,
      name: s(o.name),
      agent: s(o.agent),
      project: s(o.project),
      status: s(o.status) ?? "idle",
      asks: typeof o.asks === "number" ? o.asks : 0,
      last: typeof o.last === "number" ? o.last : 0,
      model: s(o.model),
      stopped_reason: s(o.stopped_reason),
      projectName: s(o.projectName),
    });
  }
  return out.sort((a, b) => b.last - a.last);
}
