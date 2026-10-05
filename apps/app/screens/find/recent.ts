// Recent searches, kept on this device only. Browser storage may be absent or blocked: every read and write is guarded and Find works without it.
import { remember } from "./model.ts";
const KEY = "vyre.find.recent";
const store = (): { getItem(k: string): string | null; setItem(k: string, v: string): void } | null => { try { return (globalThis as any).localStorage ?? null; } catch { return null; } };
export function readRecent(): string[] {
  try { const v = JSON.parse(store()?.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 8) : []; } catch { return []; }
}
export function addRecent(q: string): string[] {
  const next = remember(readRecent(), q);
  try { store()?.setItem(KEY, JSON.stringify(next)); } catch { /* not kept */ }
  return next;
}
