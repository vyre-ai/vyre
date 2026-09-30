// @ts-check
// team: the person's own words "retire the designer" and "fill the design role with kit" as
// act_out intents for the teammate acts that run for a model only when the person asked
// (core/team's team.act.target, reach "asked"). Duties are not here: a model's duty is always a
// proposal and turning one on is the person's tap. Same rules as pr.js: deterministic, only
// plain asks from the person's unquoted words (no question, condition or standing permission),
// one recorded use, 15 minutes, and nothing recorded when the role or agent is not named
// exactly once.
//
// The keys are the ones core/team builds, character for character:
//   team.retire:<project>/<role>
//   team.role.fill:<project>/<role>/<agent|default>
// The roles and agents come from the caller (what the thread's project really has), never
// from the words, so a word that is not one of them records nothing.

import { asks } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const RETIRE = V("retire|retiring");
const FILL = V("fill|staff|assign|reassign|put|move|swap|switch|set|use|have|let|make|back|return|reset");
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}_@-])${esc(word)}($|[^\\p{L}\\p{N}_@-])`, "iu").test(text);

const SEAT = "(?:role|teammate|seat|position)";
/**
 * A role as the person refers to it, as a pattern source: "the design teammate", "the designer",
 * "design role", "our front-end". A bare word ("design" as a verb) is not a reference.
 * @param {string} role
 */
function roleSrc(role) {
  const r = esc(String(role)).replace(/\\?-/g, "[- ]?") + "(?:e?r|or|s)?";
  return `(?:(?:the|a|our|my)\\s+${r}(?:\\s+${SEAT})?|${r}\\s+${SEAT})`;
}
const END = "(?=$|[^\\p{L}\\p{N}_@'’-])";
const START = "(?:^|[^\\p{L}\\p{N}_@-])";
const roleRe = role => new RegExp(`${START}${roleSrc(role)}${END}`, "iu");

/**
 * Does the clause say, in one of the shapes of a fill, that this agent takes this role? Only
 * these shapes: a common verb plus a role and an agent somewhere ("have the designer review
 * kit's work") is not one.
 * @param {string} clause @param {string} role @param {string} agent
 */
function fillsWith(clause, role, agent) {
  const R = roleSrc(role), A = esc(agent);
  const shapes = [
    `(?:fill|staff)\\s+${R}\\s+(?:with|using|by)\\s+${A}`,
    `(?:assign|reassign|put|move|swap|switch)\\s+${A}\\s+(?:to|as|into|on|onto|in)\\s+${R}`,
    `(?:assign|reassign|swap|switch)\\s+${R}\\s+(?:to|with)\\s+${A}`,
    `make\\s+${A}\\s+${R}`,
    `(?:have|let)\\s+${A}\\s+(?:be|take|cover|play|fill)\\s+${R}`,
  ];
  return shapes.some(sh => new RegExp(`${START}${sh}${END}`, "iu").test(clause));
}

/** Does the clause put this role back on the default helper, in one of those shapes? */
function defaultsTo(clause, role) {
  const R = roleSrc(role);
  const shapes = [
    `(?:put|switch|set|move|return|reset|change)\\s+${R}\\s+(?:back\\s+)?(?:to|on)\\s+the\\s+default(?:\\s+helper)?`,
    `(?:use|switch\\s+to)\\s+the\\s+default(?:\\s+helper)?\\s+(?:for|on|as)\\s+${R}`,
  ];
  return shapes.some(sh => new RegExp(`${START}${sh}${END}`, "iu").test(clause));
}

/**
 * @typedef {{ project: string, roles?: { role: string }[], agents?: string[] }} TeamWhere
 *   roles: the project's live teammates; agents: the person's agents that may fill a role (not the

 * @param {string} text the turn as typed
 * @param {TeamWhere|null|undefined} where
 * @returns {{ intents: any[], skipped: { reason: string, act?: string }[] }}
 */
export function teamIntents(text, where) {
  const intents = [];
  const skipped = [];
  if (!where || typeof where.project !== "string" || !where.project) return { intents, skipped };
  const project = where.project;
  const roles = (where.roles || []).map(r => String(r.role)).filter(Boolean);
  const agents = (where.agents || []).map(String).filter(Boolean);
  const seen = new Set();
  const add = (key, what) => { if (!seen.has(key)) { seen.add(key); intents.push(actIntent(key, what, "team")); } };

  for (const { clause } of askClauses(text)) {
    const hit = roles.filter(r => roleRe(r).test(clause));
    const role = hit.length === 1 ? hit[0] : null;
    const agentHit = agents.filter(a => has(clause, a));
    const agent = agentHit.length === 1 ? agentHit[0] : null;

    if (asks(clause, RETIRE)) {
      if (!role) { skipped.push({ reason: hit.length > 1 ? "ambiguous_role" : "no_role", act: "retire" }); continue; }
      add(`team.retire:${project}/${role}`, "retire a teammate");
      continue;
    }
    if (role && asks(clause, FILL)) {
      if (agentHit.length > 1) { skipped.push({ reason: "ambiguous_agent", act: "fill" }); continue; }
      if (agent && fillsWith(clause, role, agent)) add(`team.role.fill:${project}/${role}/${agent}`, "fill a role with an agent");
      else if (!agent && defaultsTo(clause, role)) add(`team.role.fill:${project}/${role}/default`, "put a role back on the default helper");
    }
  }
  return { intents, skipped };
}
