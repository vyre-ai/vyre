// @ts-check
// iq/space: the Space's memory as one more source the answer pipeline retrieves from (CUTOVER section G, "one Ask door"). The pipeline is not rebuilt: a person asks
// memory.ask once, and the passages it reads are the usual ones from Recall plus what core/work's engine finds in the Space's records, events and session lines, authorized
// for the person's own chain by that engine. A Space passage is shaped like a turn passage so the cite and check steps work on it unchanged: its `session` is the source's
// address and its `seq` is 0. In a chat with more than one person personal memory does not answer at all: the question is answered by the Space's memory alone, narrowed to the room.
import { FUSE_K } from "./retrieve.js";

/** A Space source counts a little less than the question's own search, like an expansion does. */
export const SPACE_WEIGHT = 0.8;
const MAX_SPACE = 6;

/** @param {{ source: string, kind?: string, snippet?: string }[]} hits */
export function spacePassages(hits) {
  return (hits || []).slice(0, MAX_SPACE).map((h, rank) => ({
    id: `space:${h.source}`, session: String(h.source), seq: 0, role: "space", ts: 0, text: String(h.snippet || "").slice(0, 600),
    name: `Space ${h.kind || "record"}`, cwd: null, score: Math.round((SPACE_WEIGHT / (FUSE_K + 1 + rank)) * 1e5) / 1e5, via: ["space"],
  }));
}

/** The base retrieval with the Space's passages fused in by their rank score, the best `k` kept. @param {any} base @param {any[]} hits @param {number} [k] */
export function mergeSpace(base, hits, k = 8) {
  const extra = spacePassages(hits);
  if (!extra.length) return base;
  const passages = [...base.passages, ...extra].sort((a, b) => b.score - a.score || String(a.session).localeCompare(String(b.session)) || a.seq - b.seq).slice(0, k);
  return { ...base, passages };
}

/**
 * The Space's hits for a question, through the work module's own tool (it authorizes every source for the running turn's own chain). Nothing when there is no such
 * module or it refuses: the answer then comes from personal memory alone, as today.
 * @param {(tool: string, input: any) => Promise<any>} call @param {string} question @param {number} [k]
 */
export async function spaceHits(call, question, k = MAX_SPACE) {
  try {
    const r = await call("work.know.search", { query: String(question).slice(0, 500), k });
    return r && !r.error && r.data && Array.isArray(r.data.hits) ? r.data.hits : [];
  } catch { return []; }
}

/**
 * A question asked in a chat with more than one person: answered from the Space's memory alone (`work.know.answer`, which reads the room the kernel built), in the shape of a
 * memory.ask answer. Personal memory is never consulted.
 * @param {(tool: string, input: any) => Promise<any>} call @param {string} question
 */
export async function spaceOnlyAnswer(call, question) {
  const none = { answer: null, answer_id: null, confidence: 0, abstained: true, known: [], sources: [], via: "space", latency_ms: 0, cost_usd: 0, room: true };
  try {
    const r = await call("work.know.answer", { question: String(question).slice(0, 500) });
    const a = r && !r.error && r.data && r.data.result;
    if (!a || !a.text || !(a.citations || []).length) return none;
    return { ...none, answer: String(a.text), abstained: false, confidence: 0.5, sources: a.citations.map((/** @type {string} */ c) => ({ session: String(c), seq: 0, name: "Space source", quote: "", ts: 0 })), ...(a.withheld ? { withheld: a.withheld } : {}) };
  } catch { return none; }
}
