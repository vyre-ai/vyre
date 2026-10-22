// files.recent answers with folders chats worked in (path, last, sessions), newest first. The Files page shows those under On your computer.

export type WorkedFolder = { path: string; name: string; sessions: number };

/** Folders from a files.recent answer. Anything that is not a list of paths is no folders. */
export function workedInLately(d: unknown): WorkedFolder[] {
  if (!Array.isArray(d)) return [];
  const out: WorkedFolder[] = [];
  for (const r of d) {
    if (!r || typeof r !== "object") continue;
    const path = typeof (r as { path?: unknown }).path === "string" ? (r as { path: string }).path : "";
    if (!path) continue;
    const name = path.split("/").filter(Boolean).pop() || path;
    const n = Number((r as { sessions?: unknown }).sessions);
    out.push({ path, name, sessions: Number.isFinite(n) && n > 0 ? n : 1 });
  }
  return out;
}

/** How many chats worked in a folder, as a short line. */
export function workedLine(f: WorkedFolder): string {
  return f.sessions === 1 ? "1 chat" : `${f.sessions} chats`;
}
