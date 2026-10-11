// @ts-check
// lib/tools-extras: the things besides registry tools that tools_find also finds, so there is one index. A skill the caller may use becomes an entry that is called like a tool: calling it returns the
// skill's whole SKILL.md (skills.get), which the model then follows. Each entry carries its group (area.verb), so a model that does not know the phrasing can ask by area. Pure: the caller hands in
// what skills.list gave (already cut to what this caller may use) and the names already taken.

import { mcpName } from "../harness/mcp/core-tools.js";

/** The area.verb a found entry is filed under. */
export const SKILL_GROUP = "skills.use";

const slug = (/** @type {string} */ s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "skill";

/**
 * @param {{ id?: string, name?: string, description?: string, level?: string }[]} skills the rows skills.list gave
 * @param {Set<string>} taken names the catalog already has
 * @returns {{ catalog: { name: string, tool: string, group: string, description: string, input: any }[], routes: Map<string, { tool: string, fixed: Record<string, string> }> }}
 */
export function skillEntries(skills, taken) {
  const catalog = [], routes = new Map();
  for (const s of skills) {
    if (!s || typeof s.id !== "string" || !s.id) continue;
    let name = mcpName(`skill_${slug(s.name || s.id)}`), n = 2;
    while (taken.has(name) || routes.has(name)) name = mcpName(`skill_${slug(s.name || s.id)}_${n++}`);
    const desc = String(s.description || s.name || s.id).replace(/\s+/g, " ").trim();
    catalog.push({ name, tool: "skills.get", group: SKILL_GROUP, description: `Skill: ${desc}. Call it with no arguments to read the steps, then follow them.`.slice(0, 400), input: { type: "object", properties: {} } });
    routes.set(name, { tool: "skills.get", fixed: { id: s.id } });
  }
  return { catalog, routes };
}
