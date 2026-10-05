// The searches kept on this device, newest first. Storage can be missing or refuse (a private window, a native build without it); then none, and Find works the same.
import { RECENT_MAX } from "./model";

const KEY = "vyre.find.recent";
const mem: { list: string[] } = { list: [] };

export async function loadRecents(): Promise<string[]> {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const v = raw ? JSON.parse(raw) : mem.list;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x).slice(0, RECENT_MAX) : [];
  } catch { return mem.list; }
}
export async function saveRecents(list: string[]): Promise<void> {
  mem.list = list;
  try { if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* kept in memory */ }
}
