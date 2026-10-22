// Quick Look opens at once when the next file was read before it was asked for: the neighbours of the open file are read in the background (a Space file, or a file in the same linked folder; small files, a few kept) and the viewer's source
// takes a kept copy instead of asking again. A kept copy is dropped when used, so a changed file is never shown stale for long, and it is a copy of what the caller could read anyway.
import { linked, spaceRead } from "./real";

const KEEP = 6, MAX_BYTES = 3 * 1024 * 1024;
const kept = new Map<string, string>();
const inflight = new Set<string>();

function readAhead(key: string, size: number, load: () => Promise<string>): void {
  if (size > MAX_BYTES || kept.has(key) || inflight.has(key)) return;
  inflight.add(key);
  void load().then((b64) => { if (kept.size >= KEEP) kept.delete(kept.keys().next().value as string); kept.set(key, b64); }).catch(() => {}).finally(() => inflight.delete(key));
}

function takeKey(key: string): string | null {
  const v = kept.get(key) ?? null;
  kept.delete(key);
  return v;
}

/** Read a Space file into the cache unless it is big, already kept or being read. */
export function warm(path: string, size: number): void {
  readAhead(`space:${path}`, size, () => spaceRead(undefined, path).then((r) => r.base64));
}

/** Read a linked-folder file into the cache, kept apart from a Space file of the same path. */
export function warmLinked(link: string, path: string, size: number): void {
  readAhead(`linked:${link}:${path}`, size, () => linked.read(link, path).then((r) => r.base64));
}

/** A kept Space copy, once. */
export function take(path: string): string | null {
  return takeKey(`space:${path}`);
}

/** A kept linked-folder copy, once. */
export function takeLinked(link: string, path: string): string | null {
  return takeKey(`linked:${link}:${path}`);
}
