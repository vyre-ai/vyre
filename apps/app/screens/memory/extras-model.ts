// The pure half of Memory's graph, corrections and Ask on a real vyred: the shapes memory.graph (core/memory/floor.js), memory.corrections
// (memory_corrections rows) and memory.ask (core/memory/iq/ask.js) answer, as the lines the screen shows.

export type GraphNode = { id: string; kind: string; label: string; weight: number; pinned: boolean; muted: boolean; role: string | null; room: string; last: number | null };
export type GraphRoom = { id: string; name?: string; kind?: string; nodes: number; facts: number };
export type GraphOut = { rooms: GraphRoom[]; nodes: GraphNode[]; edges: { id: string; src: string; rel: string; dst: string }[]; counts: { nodes: number; facts: number; drawn: number }; truncated: boolean };
export type CorrectionRow = { id: number; action: string; src: string; rel: string | null; dst: string | null; object: string | null; scope: string; note: string | null; created: number; undone: number | null };
export type Asked = { answer: string | null; confidence: number; abstained: boolean; known: string[]; sources: { session?: string; name?: string; quote?: string; ts?: number }[]; answer_id?: string };

/** A node id as words: "per:jane-doe" is "jane doe". */
export const wordsOf = (id: string | null): string => String(id ?? "").replace(/^[a-z]+:/, "").replace(/[-_]/g, " ");
/** The graph's own entity kinds are drawn as nodes; facts and threads hang off them. */
const ENTITY = (n: GraphNode) => n.kind !== "fact" && n.kind !== "thread";

/** Rooms with their entities, pinned first then the most seen, a muted one last. A room with nothing drawn is left out. */
export function roomsOf(g: GraphOut): { id: string; name: string; counts: string; nodes: GraphNode[] }[] {
  return g.rooms.map((r) => {
    const nodes = g.nodes.filter((n) => n.room === r.id && ENTITY(n)).sort((a, b) => Number(a.muted) - Number(b.muted) || Number(b.pinned) - Number(a.pinned) || b.weight - a.weight);
    return { id: r.id, name: r.name || (r.id === "shared" ? "Shared" : r.id === "unfiled" ? "Unfiled" : r.id), counts: `${r.nodes} ${r.nodes === 1 ? "thing" : "things"}, ${r.facts} ${r.facts === 1 ? "fact" : "facts"}`, nodes };
  }).filter((r) => r.nodes.length);
}

const WHAT: Record<string, string> = { wrong: "was never true", forget: "was forgotten", ended: "stopped being true", replace: "was replaced", confirm: "was confirmed", add: "was added", merge: "was merged", split: "was split" };
/** One correction as a line the person would say. A merge or split names no relation. */
export function correctionLine(c: CorrectionRow): string {
  const rel = c.rel ? c.rel.replace(/_/g, " ") : "";
  if ((c.action === "replace" || c.action === "add") && c.object) return `${[wordsOf(c.src), rel].filter(Boolean).join(" ")}: now ${c.object}`;
  return `${[wordsOf(c.src), rel, wordsOf(c.dst)].filter(Boolean).join(" ")} ${WHAT[c.action] ?? c.action}`;
}

/** Corrections still standing, newest first. */
export const standing = (rows: CorrectionRow[]): CorrectionRow[] => rows.filter((c) => c.undone == null).sort((a, b) => b.created - a.created);

/** What Ask shows: the answer and its sources, or an honest nothing. Never a made-up line. */
export function asked(a: Asked): { kind: "answer"; text: string; sources: { name: string; quote: string }[] } | { kind: "none"; text: string } {
  if (a.abstained || !a.answer) return { kind: "none", text: a.known?.[0] || "Nothing remembered about that yet." };
  return { kind: "answer", text: a.answer, sources: (a.sources ?? []).map((s) => ({ name: s.name || "a past session", quote: s.quote ?? "" })).filter((s) => s.name || s.quote) };
}
