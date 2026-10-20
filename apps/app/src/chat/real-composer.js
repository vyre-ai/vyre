// @ts-check
// What a real chat's composer offers, from the box: the person's own models (the one model service, through src/models/useMyModels.ts), the people and assistants to @mention (records.actors, agents.list), and the records to # tag (the person's own
// records, with how many of their fields are sealed). Pure, so Node tests it; src/chat/useRealComposer.ts reads the box and calls these.
import { agentWords } from "../state/agent-name.js";

/**
 * What a person's model pick in a chat asks the box (CONTRACT-one-chat.md): threads.chat-switch { chat, slot, provider, model, account, effort? }. The pick is the person's own, from the one model
 * picker (their own account and one of its models): it is kept for their turns in this chat and changes no one else's.
 * @param {string} chat @param {{ account: { id: string }, model: { id: string, provider: string } } | null | undefined} pick @param {string} [slot] @param {string | null} [effort]
 * @returns {{ tool: string, input: Record<string, unknown> } | null}
 */
export function switchCall(chat, pick, slot, effort = null) {
  if (!pick || !pick.model || !pick.model.id || !pick.model.provider) return null;
  return { tool: "threads.chat-switch", input: { chat, ...(slot ? { slot } : {}), provider: pick.model.provider, model: pick.model.id, ...(pick.account && pick.account.id ? { account: pick.account.id } : {}), ...(effort ? { effort } : {}) } };
}

/** A raw person id ("per_q7k2m9..."): never a name to show. */
const ID_LIKE = /^per_[a-z0-9]{6,}$/i;

/**
 * A person's or an agent's name as a person reads it, never an id: an agent by its words ("engineer" is "Engineer"), a person by the name they chose, else their username (spaces.members.list
 * names a member "alex.vyre.run": "alex"), else nothing (the row is left out rather than show an id).
 * @param {string} name @param {"person" | "assistant"} family @param {string} [id] @param {Record<string, string>} [names] person id to the name spaces.members.list gave
 */
export function shownName(name, family, id = "", names = {}) {
  const raw = String(name || "").trim();
  if (family === "assistant") return raw && !ID_LIKE.test(raw) ? agentWords(raw) : "";
  const key = String(id || "").replace(/^person:/, "");
  // "Someone" is what a member list says for a person it cannot name: not a name to pick either
  const own = raw && !ID_LIKE.test(raw) && raw !== key && raw !== "Someone" ? raw : "";
  const pick = own || String(names[key] || "").trim();
  return ID_LIKE.test(pick) ? "" : pick.replace(/\.vyre\.run$/, "");
}

/**
 * The people and assistants to @mention: this chat's own first, then the space's actors and the person's agents, each once, never the viewer, and never a raw id: a person with no name and no
 * username known here is left out. `names` is spaces.members.list as person id to name.
 * @param {{ actors?: any, agents?: any, viewer?: string | null, here?: { name: string, family: string, id?: string }[], names?: Record<string, string> }} o
 */
export function peopleFor({ actors, agents, viewer, here = [], names = {} }) {
  /** @type {Map<string, { name: string, id: string, family: "person" | "assistant", doing?: string }>} */ const out = new Map();
  const add = (/** @type {string} */ name, /** @type {string} */ family, /** @type {string} */ id = "") => {
    const fam = family === "assistant" || family === "agent" ? "assistant" : "person";
    const n = shownName(name, fam, id, names);
    if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, id: String(id || String(name || "").trim()), family: fam });
  };
  for (const p of here) add(p.name, p.family, p.id);
  for (const a of Array.isArray(actors?.actors) ? actors.actors : Array.isArray(actors) ? actors : []) if (a && a.id !== viewer && a.name !== viewer) add(a.name || "", a.family, a.id);
  for (const a of Array.isArray(agents) ? agents : []) {
    add(a?.name, "assistant");
    // what the live session is doing now and where it works, said under its name in the picker
    const row = out.get(agentWords(String(a?.name || "").trim()).toLowerCase());
    if (row) { const line = doingLine(a); if (line) row.doing = line; }
  }
  return [...out.values()];
}

/** spaces.members.list as person id to the name it gave (a username such as "alex.vyre.run"), for peopleFor. @param {any} d @returns {Record<string, string>} */
export function memberNames(d) {
  /** @type {Record<string, string>} */ const out = {};
  for (const m of Array.isArray(d?.members) ? d.members : []) if (m && typeof m.person === "string" && typeof m.name === "string" && m.name.trim()) out[m.person] = m.name.trim();
  return out;
}

/** The records to tag: every record of the person's own types, named by its title, with the number of sealed fields that hold a value. @param {{ types: any[], byType: Record<string, any[]> } | null | undefined} world @param {(def: any, rec: any) => string} titleOf @param {number} [max] */
export function recordPicks(world, titleOf, max = 300) {
  const out = [];
  for (const def of world?.types ?? []) {
    if (def.internal || /^(def-|flow-|kit-)/.test(String(def.name))) continue;
    const sealedKeys = (def.fields ?? []).filter((/** @type {any} */ f) => f.kind === "sealed" || f.seal).map((/** @type {any} */ f) => f.name);
    for (const rec of world?.byType?.[def.name] ?? []) {
      const sealed = sealedKeys.filter((/** @type {string} */ k) => rec?.data?.[k] != null && (typeof rec.data[k] !== "object" || rec.data[k].present !== false)).length;
      out.push({ name: titleOf(def, rec), type: String(def.label ?? def.name), sealed, urn: String(rec.urn ?? rec.id), kind: "record" });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** "Working on billing" or "Waiting on your answer": what an agent's live session is doing now, and the one project it works on when it works on one. Nothing for an agent that has not started. @param {{ doing?: string, projects?: unknown } | null | undefined} a */
export function doingLine(a) {
  const d = a && typeof a.doing === "string" ? a.doing : "";
  if (!d || d === "not started") return "";
  const word = d === "working" ? "Working" : d === "idle" ? "Idle" : d.charAt(0).toUpperCase() + d.slice(1);
  const ps = a && Array.isArray(a.projects) ? a.projects.map(String).filter(Boolean) : [];
  return ps.length === 1 ? `${word} on ${ps[0]}` : word;
}
