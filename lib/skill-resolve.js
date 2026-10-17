// @ts-check
// How approved library items combine for one session (R031-18, 0.6): space skills are enforced — a space-level name cannot be replaced by a personal, agent or project skill with the same name. Among the rest, the narrower level still wins.

/** @typedef {"space" | "personal" | "agent" | "project"} SkillLevel */

const RANK = { space: 0, personal: 1, agent: 2, project: 3 };

/**
 * Approved rows for one caller, with space enforcement. Space-level names are pinned; personal, agent and project rows apply only when no space row shares the name. Among those, the narrowest level wins.
 * @param {any[]} items rows with { name, level, scope, state, ... }
 * @param {{ person?: string | null, agent?: string | null, projects?: string[], agents?: string[], allAgents?: boolean }} who
 */
export function resolveApproved(items, who) {
  const ok = items.filter(i => i.state === "approved" && (
    i.level === "space" ||
    (i.level === "personal" && who.person && i.scope === who.person) ||
    (i.level === "agent" && ((who.agent && i.scope === who.agent) || (!who.agent && who.person && (who.allAgents || (who.agents || []).includes(i.scope))))) ||
    (i.level === "project" && (who.projects || []).includes(i.scope))));
  const spaceNames = new Set(ok.filter(i => i.level === "space").map(i => i.name));
  const rest = ok.filter(i => i.level !== "space" && !spaceNames.has(i.name));
  const space = ok.filter(i => i.level === "space");
  const best = new Map();
  for (const i of rest) {
    const have = best.get(i.name);
    if (!have || RANK[/** @type {SkillLevel} */ (i.level)] > RANK[/** @type {SkillLevel} */ (have.level)]) best.set(i.name, i);
  }
  return [...space, ...best.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

