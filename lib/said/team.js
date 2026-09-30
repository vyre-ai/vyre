// @ts-check
// team: the person's own words "retire the designer", "fill the design role with kit", "turn on
// the inbox duty" as act_out intents for the teammate acts that run for a model only when the
// person asked (core/team asked.js, reach "asked"). Same rules as pr.js: deterministic, only
// plain asks from the person's unquoted words (no question, condition or standing permission),
// one recorded use, 15 minutes, and nothing recorded when the role, agent or duty is not named
// exactly once.
//
// The keys are the ones core/team builds, character for character:
//   team.retire:<project>/<role>
//   team.role.fill:<project>/<role>/<agent|default>
//   team.duties.create:<project>/<role>
//   team.duties.update:<teammate>/<duty id>
// The roles, agents and duties come from the caller (what the thread's project really has), never
// from the words, so a word that is not one of them records nothing.

import { asks } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const RETIRE = V("retire|retiring");
const FILL = V("fill|staff|assign|reassign|put|move|swap|switch|set|use|have|let|make|back|return|reset");
const CREATE = V("add|create|give|set\\s+up|start|make");
const UPDATE = V("turn\\s+on|enable|start|activate|resume|switch\\s+on|change|edit|update|rewrite");
const DUTY = /\b(duty|duties)\b/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}_@-])${esc(word)}($|[^\\p{L}\\p{N}_@-])`, "iu").test(text);

/**
 * A role as the person refers to it, not as a verb: "the design teammate", "the designer",
 * "design role", "as front-end". "have kit design the intake" names no role.
 * @param {string} role
 */
function roleRe(role) {
  const r = esc(String(role)).replace(/\\?-/g, "[- ]?");
  const tail = "(?=$|[^\\p{L}\\p{N}_@-])";
  return new RegExp(`(?:(?:^|[^\\p{L}\\p{N}_@-])(?:the|a|our|my|as|to|on|with)\\s+${r}(?:e?r|or|s)?${tail})|(?:(?:^|[^\\p{L}\\p{N}_@-])${r}(?:e?r|or|s)?\\s+(?:role|teammate|seat|position)${tail})`, "iu");
}

/**
 * @typedef {{ project: string, roles?: { role: string }[], agents?: string[], duties?: { id: string, teammate: string, title: string }[] }} TeamWhere
 *   roles: the project's live teammates; agents: the person's agents that may fill a role (not the
 *   assistant); duties: the project's duties with a short title (or the instruction) to name them by
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
  const duties = where.duties || [];
  const seen = new Set();
  const add = (key, what) => { if (!seen.has(key)) { seen.add(key); intents.push(actIntent(key, what, "team")); } };

  for (const { clause } of askClauses(text)) {
    const hit = roles.filter(r => roleRe(r).test(clause));
    const role = hit.length === 1 ? hit[0] : null;
    const agentHit = agents.filter(a => has(clause, a));
    const agent = agentHit.length === 1 ? agentHit[0] : null;
    const duty = DUTY.test(clause);

    if (!duty && asks(clause, RETIRE)) {
      if (!role) { skipped.push({ reason: hit.length > 1 ? "ambiguous_role" : "no_role", act: "retire" }); continue; }
      add(`team.retire:${project}/${role}`, "retire a teammate");
      continue;
    }
    if (duty) {
      if (asks(clause, CREATE) && role && !/\b(turn\s+on|enable|resume)\b/i.test(clause)) { add(`team.duties.create:${project}/${role}`, "give a teammate a duty"); continue; }
      if (asks(clause, UPDATE) && !/\b(turn\s+off|pause|stop|disable|cancel|delete|remove)\b/i.test(clause)) {
        const named = /\b(?:the|my)\s+([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}?)\s+duty\b/iu.exec(clause);
        const words = named ? named[1].toLowerCase().split(/\s+/).filter(w => w.length >= 3) : [];
        const match = words.length ? duties.filter(d => words.every(w => has(`${d.title}`.toLowerCase(), w))) : [];
        if (match.length === 1) add(`team.duties.update:${match[0].teammate}/${match[0].id}`, "turn on or change a duty");
        else skipped.push({ reason: match.length > 1 ? "ambiguous_duty" : "no_duty", act: "duty_update" });
      }
      continue;
    }
    if (role && asks(clause, FILL)) {
      if (agentHit.length > 1) { skipped.push({ reason: "ambiguous_agent", act: "fill" }); continue; }
      if (agent) add(`team.role.fill:${project}/${role}/${agent}`, "fill a role with an agent");
      else if (/\bdefault\b/i.test(clause)) add(`team.role.fill:${project}/${role}/default`, "put a role back on the default helper");
    }
  }
  return { intents, skipped };
}
