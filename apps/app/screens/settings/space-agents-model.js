// @ts-check
// The Space's agents as a member sees them (read-only): the roster the team's door gives a member (agents.roster: id, name, kind, role, model, status; core/agents agents.serve). Never an agent's instructions, tools, projects,
// computer or sign-in: those are not in the roster. Pure: the screen draws these.
import { useRefusal } from "../../src/real/own-home.js";

/** @param {unknown} d @returns {any[]} */
const rowsOf = (d) => { const x = /** @type {any} */ (d); return Array.isArray(x) ? x : (x && (x.agents || x.rows)) || []; };

/** The roster: { name, kind, role, model, status } (an assistant first, then by name). @param {unknown} d */
export function spaceAgents(d) {
  return rowsOf(d).filter((x) => x && typeof x.name === "string" && x.name)
    .map((x) => ({ name: String(x.name), kind: x.kind === "assistant" ? "assistant" : "agent", role: typeof x.role === "string" ? x.role : "", model: typeof x.model === "string" ? x.model : "", status: typeof x.status === "string" ? x.status : "" }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "assistant" ? -1 : 1));
}

/** What pressing "Ask" says: the gate's own words for an agent; neutral words for a teammate. Nothing is started. @param {{ name: string }} who @param {"agent" | "teammate"} kind */
export const askWords = (who, kind) => (kind === "teammate" ? "Only the owner and admins can ask this teammate in this release." : useRefusal({ name: who.name, kind }, false));
