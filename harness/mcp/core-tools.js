// @ts-check
// The small always-loaded core of Vyre's MCP tools (R031-00j), and the two that reach the rest.
//
// A session lists only the CORE below, plus tools_find and tools_call. Every other tool (about 700 an agent may use) stays reachable
// through them: tools_find ranks them for an intent in plain words and hands back a ready example call, tools_call runs one.
// The listing is kept small on purpose, because every listed tool costs the model its description on every turn: test/tools-budget.test.js
// fails above 30 tools or about 6,000 tokens (lib/tokens.js). To add a tool here, say which one leaves or why the budget grows.
import { ALIASES, REPLACED } from "./memory-tools.js";
import { buildToolIndex, findTools } from "../../lib/tools-index.js";
import { ASKS } from "./asks.js";

/** MCP names allow letters, digits, "_" and "-", so "recall.search" is offered as "recall_search". @param {string} t */
export const mcpName = (t) => t.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/** What a session is always offered, by MCP name: memory, recall, records (work_tools/work_call), planner, flows, connections, vault use, files, asking a teammate, docs, skills, and the map of modules. */
export const CORE = [
  "memory_ask", "memory_search", "memory_turn", "memory_remember", "recall_search",
  "work_tools", "work_call",
  "planner_add", "planner_list",
  "flows_define", "flows_list",
  "connectors_connection_list",
  "vault_list", "vault_request",
  "files_search", "files_preview",
  "team_ask", "agents_ask", "gate_request",
  "docs_find", "docs_read",
  "skills_find", "skills_list",
  "vyre_core",
];

/** The two tools the server answers itself. They are listed beside the core. */
export const META = ["tools_find", "tools_call"];

/**
 * Every tool a caller may use, by the name it is called with: a module tool under its own name, the memory tools under theirs (their raw twins are not offered beside them).
 * @param {{ name: string, description?: string, input?: any }[]} offered the registry's tools after the caller's scope
 * @returns {{ name: string, tool: string, alias?: string, description: string, input: any }[]}
 */
export function catalogOf(offered) {
  const has = new Set(offered.map((t) => t.name));
  const list = offered.filter((t) => !(REPLACED.has(t.name) && Object.values(ALIASES).some((a) => a.tool === t.name)));
  const out = list.map((t) => ({ name: mcpName(t.name), tool: t.name, description: t.description || t.name, input: { type: "object", ...(t.input || {}) } }));
  for (const [name, a] of Object.entries(ALIASES)) if (has.has(a.tool)) out.push({ name, tool: a.tool, alias: name, description: a.description, input: a.input });
  return out;
}

/** The two meta tools' definitions. */
export const META_TOOLS = [
  {
    name: "tools_find",
    description: "Find the Vyre tool for what you are about to do. Describe it in plain words (\"remind me at 6\", \"search my inbox\"): you get the best three, each with a ready example call. Only tools you may use are found. Run one with tools_call.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 300 }, limit: { type: "integer", minimum: 1, maximum: 10 } } },
  },
  {
    name: "tools_call",
    description: "Run any Vyre tool you may use, by the name tools_find gave: { tool, arguments }. Held and approval rules are the same as calling it directly.",
    inputSchema: { type: "object", required: ["tool"], properties: { tool: { type: "string", maxLength: 100 }, arguments: { type: "object" } } },
  },
];

/** The MCP listing: the core that this caller has, then the two meta tools. @param {ReturnType<typeof catalogOf>} catalog */
export function listing(catalog) {
  const by = new Map(catalog.map((c) => [c.name, c]));
  const core = CORE.filter((n) => by.has(n)).map((n) => { const c = /** @type {any} */ (by.get(n)); return { name: c.name, description: c.description, inputSchema: c.input }; });
  return [...core, ...META_TOOLS];
}

/** The search index over a catalog (and any hub tools handed in the same shape). @param {{ name: string, tool?: string, description: string, input: any }[]} catalog */
export function indexOf(catalog) {
  const core = new Set(CORE);
  const hand = Object.fromEntries(Object.entries(ASKS).map(([k, v]) => [k, { ...v, core: core.has(k) }]));
  for (const n of CORE) if (!hand[n]) hand[n] = { core: true };
  return buildToolIndex(catalog.map((c) => ({ name: c.name, also: c.tool, description: c.description, input: c.input })), hand);
}

/** The best tools for an intent, named as they are called. @param {ReturnType<typeof indexOf>} index @param {string} query @param {number} [limit] */
export function find(index, query, limit = 3) {
  return findTools(index, query, { limit });
}
