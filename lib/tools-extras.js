// @ts-check
// lib/tools-extras: the things besides registry tools that tools_find also finds, so there is one index. A skill the caller may use becomes an entry that is called like a tool: calling it returns the
// skill's whole SKILL.md (skills.get), which the model then follows. Each entry carries its group (area.verb), so a model that does not know the phrasing can ask by area. Pure: the caller hands in
// what skills.list gave (already cut to what this caller may use) and the names already taken.

import { mcpName } from "../harness/mcp/core-tools.js";

/** The area.verb a found entry is filed under. */
export const SKILL_GROUP = "skills.use";

const slug = (/** @type {string} */ s) => String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "skill";

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

/** The group a learned site operation is filed under. */
export const SITE_GROUP = "sites.run";

const hostOf = (/** @type {string} */ site) => { try { return new URL(site).hostname.replace(/^www\./, ""); } catch { return ""; } };
const words = (/** @type {string} */ camel) => String(camel).replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/**
 * The website operations Vyre learned for the person (memory.site.learned: site, name, kind, input names), as entries that tools_find returns and tools_call runs through the Chrome tool
 * (chrome.op, action call). Offered only when the caller's catalog has that tool, so the finder never points at something the session cannot run. A call that is not a read is held for the
 * person's yes by the Chrome tool itself; the description says so. Nothing recorded from a page is in an entry.
 * @param {{ site?: string, name?: string, kind?: string, params?: { name: string, required?: boolean }[] }[]} ops
 * @param {Set<string>} taken names the catalog already has
 * @param {boolean} canRun whether the caller's catalog has the Chrome tool
 * @returns {{ catalog: { name: string, tool: string, group: string, description: string, input: any }[], routes: Map<string, { tool: string, fixed: Record<string, any> }> }}
 */
export function siteEntries(ops, taken, canRun) {
  const catalog = [], routes = new Map();
  if (!canRun) return { catalog, routes };
  for (const o of ops) {
    if (!o || typeof o.site !== "string" || typeof o.name !== "string" || !hostOf(o.site)) continue;
    const host = hostOf(o.site), kind = o.kind || "read";
    let name = mcpName(`site_${slug(host)}_${slug(o.name)}`), n = 2;
    while (taken.has(name) || routes.has(name)) name = mcpName(`site_${slug(host)}_${slug(o.name)}_${n++}`);
    const params = Array.isArray(o.params) ? o.params.filter(p => p && typeof p.name === "string") : [];
    const props = Object.fromEntries(params.map(p => [p.name, {}]));
    const need = params.filter(p => p.required !== false).map(p => p.name);
    const ask = kind === "read" ? "" : ` It is a ${kind}: the person is asked first.`;
    catalog.push({ name, tool: "chrome.op", group: SITE_GROUP, description: `Learned on ${host}: ${words(o.name)} (${kind})${params.length ? `, inputs: ${params.map(p => p.name).join(", ")}` : ""}. Runs in the person's own Chrome, signed in.${ask}`.slice(0, 400),
      input: { type: "object", properties: { inputs: { type: "object", properties: props, ...(need.length ? { required: need } : {}) } } } });
    routes.set(name, { tool: "chrome.op", fixed: { action: "call", site: o.site, name: o.name } });
  }
  return { catalog, routes };
}
