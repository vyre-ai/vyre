// @ts-check
// The Space's assistants and teammates as a member sees them (read-only): the `agent` and `team-member` records the team's door lets a member read (kernel/remote/member-guard.js: readable, never writable). Name, what kind,
// and its tags; never an agent's instructions or sign-in (those are not on the record, and agents.list, which has them, is not a member call). Pure: the screen draws these.
import { useRefusal } from "../../src/real/own-home.js";

/** @param {unknown} d @returns {any[]} */
const rowsOf = (d) => { const x = /** @type {any} */ (d); return Array.isArray(x) ? x : (x && (x.rows || x.records || x.items)) || []; };

/** The Space's agents: { name, kind, tags } (an assistant first, then by name). @param {unknown} d */
export function spaceAgents(d) {
  return rowsOf(d).map((r) => r && r.data ? r.data : r).filter((x) => x && typeof x.name === "string" && x.name)
    .map((x) => ({ name: String(x.name), kind: x.kind === "assistant" ? "assistant" : "agent", tags: typeof x.tags === "string" ? x.tags.split(",").map((/** @type {string} */ t) => t.trim()).filter(Boolean) : Array.isArray(x.tags) ? x.tags.map(String) : [] }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "assistant" ? -1 : 1));
}

/** The Space's teammates: { name, role }. @param {unknown} d */
export function spaceTeammates(d) {
  return rowsOf(d).map((r) => r && r.data ? r.data : r).filter((x) => x && typeof x.name === "string" && x.name)
    .map((x) => ({ name: String(x.name), role: typeof x.role === "string" ? x.role : "" })).sort((a, b) => a.name.localeCompare(b.name));
}

/** What pressing "Ask" says for one of them: the gate's own words; nothing is started. @param {{ name: string }} who @param {"agent" | "teammate"} kind */
export const askWords = (who, kind) => useRefusal({ name: who.name, kind }, false);
