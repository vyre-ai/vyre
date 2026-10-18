// Quick Look opens at once when the next file was read before it was asked for: the neighbours of the open file are read in the background (the Space's Drive only, small files, a few kept) and the viewer's source
// takes a kept copy instead of asking again. A kept copy is dropped when used, so a changed file is never shown stale for long, and it is a copy of what the caller could read anyway.
import { spaceRead } from "./real";

const KEEP = 6, MAX_BYTES = 3 * 1024 * 1024;
const kept = new Map<string, string>();
const inflight = new Set<string>();

/** Read a Space file into the cache unless it is big, already kept or being read. */
export function warm(path: string, size: number): void {
  if (size > MAX_BYTES || kept.has(path) || inflight.has(path)) return;
  inflight.add(path);
  void spaceRead(undefined, path).then((r) => { if (kept.size >= KEEP) kept.delete(kept.keys().next().value as string); kept.set(path, r.base64); }).catch(() => {}).finally(() => inflight.delete(path));
}

/** A kept copy, once. */
export function take(path: string): string | null {
  const v = kept.get(path) ?? null;
  kept.delete(path);
  return v;
}
