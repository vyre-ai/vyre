// The pure half of Files > Linked (files.linked.*): the words for a sync, the name a link gets, the paths the tools take, and plain refusals. Nothing here talks to the box.
import { spaceDriveRefusal } from "./space-model.ts";

export type LinkedFolder = { id: string; name: string; path: string; provider: string; source: Record<string, unknown>; linked_by: string; at: number };
export type SyncState = { status: "ok" | "error"; count: number; at: number; error?: string };
export type ProviderInfo = { id: string; label: string; pick: boolean };
export type PickFolder = { id: string; name: string };
export type LinkedEntry = { name: string; path: string; dir: boolean; size: number; modified: number | null; rev: string | null };
export type LinkedFile = { path: string; name: string; mime: string; rev: string; size: number; base64: string };
export type LinkedVersion = { rev: string; modified: number; by?: string };

const NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** A folder's name as a link name: letters, digits, dash and underscore, at most 64; never empty. */
export function suggestName(folder: string): string {
  const s = folder.trim().replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return s || "Linked";
}
/** Why a typed name will not do, or "" when it will. */
export function nameProblem(name: string): string {
  if (!name.trim()) return "Give the folder a name.";
  return NAME.test(name) ? "" : "Use letters, digits, dash and underscore, up to 64.";
}

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
};
/** The line under a linked folder: not synced, what it holds and when, or why the last sync failed. */
export function syncLine(s: SyncState | null, now: number): string {
  if (!s) return "Not synced yet";
  if (s.status === "error") return `Could not sync: ${s.error || "the source did not answer"}`;
  return `${s.count} ${s.count === 1 ? "item" : "items"}, synced ${ago(s.at, now)}`;
}

/** The box answers paths as Linked/<name>/a/b; the tools take a/b. */
export function pathIn(name: string, full: string): string {
  const root = `Linked/${name}`;
  return full === root ? "" : full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full;
}
/** Each step inside a linked folder: its name at the top, then each folder, with the path tapping it opens. */
export function crumbsOf(name: string, path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  return [{ name, path: "" }, ...parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") }))];
}
export const providerLabel = (ps: ProviderInfo[], id: string): string => ps.find((p) => p.id === id)?.label ?? id;

const TEXT = /\.(txt|md|csv|json|xml|ya?ml|html?|log)$/i;
export const EDIT_MAX = 262144;
/** Small text files open in the app and can be saved back; anything else opens at the source. */
export const editable = (name: string, size: number): boolean => TEXT.test(name) && size <= EDIT_MAX;

export function linkedRefusal(code: string | undefined, message: string): string {
  if (code === "conflict") return "This file changed at the source since you opened it, so nothing was saved. Reload it, then make your change again.";
  if (code === "denied") return message ? `Your account at the source does not allow that. ${message}` : "Your account at the source does not allow that.";
  if (code === "unavailable") return "The source is not answering right now. Try again in a moment.";
  if (code === "unsupported") return message || "That cannot be done from here.";
  if (code === "no_such_tool") return "This box does not have linked folders yet. Update your Vyre.";
  return spaceDriveRefusal(code, message);
}
