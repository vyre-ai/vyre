// Find's calls over the one tools source: nothing here is new, it only asks and shapes.
import { moreTools } from "../chat-tools/instance";
import { MIN, agentsOf, parsePrefix, projectsOf, sessionsOf, type Base, type Found } from "./model.ts";
import { callT as call } from "../../src/real/call-tool";

/** What Find filters locally: sessions, projects and agents. A part that is not available is empty, never a failure. */
export async function loadBase(): Promise<Base & { notes: string[] }> {
  const [cat, th, pl, al] = await Promise.all([call("projects.catalog", { limit: 300 }), call("threads.list", { all: true }), call("projects.list", {}), call("agents.list")]);
  const notes = [cat.error ? "Recent chats are not available." : "", al.error ? "People are not available." : ""].filter(Boolean);
  return { sessions: sessionsOf(cat.data, th.data), projects: projectsOf(pl.data), agents: agentsOf(al.data), notes };
}

/** The three searches the box does. Each answers on its own so the first words show at once; `got` is told with what has come. */
export function search(raw: string, got: (f: Partial<Found> & { errs?: { chats?: string; files?: string; memory?: string } }) => void): void {
  const q = parsePrefix(raw)?.rest ?? raw.trim();
  if (q.length < MIN) return;
  moreTools.searchChats(q, 20).then((chats) => got({ chats }), (e) => got({ chats: [], errs: { chats: String(e?.message || "x") } }));
  moreTools.searchFiles(q, 20).then((files) => got({ files }), (e) => got({ files: { results: [], notes: [] }, errs: { files: String(e?.message || "x") } }));
  moreTools.searchMemory(q, 5).then((memory) => got({ memory }), (e) => got({ memory: [], errs: { memory: String(e?.message || "x") } }));
}
export const previewFile = (path: string, source?: "mac" | "box") => moreTools.preview(path, source);
