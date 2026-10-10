// @ts-check
// The small always-loaded core of Vyre's MCP tools (R031-00j), and the two that reach the rest.
//
// A session lists only the CORE below, plus tools_find and tools_call. Every other tool (about 700 an agent may use) stays reachable
// through them: tools_find ranks them for an intent in plain words and hands back a ready example call, tools_call runs one.
// The listing is kept small on purpose, because every listed tool costs the model its description on every turn: test/tools-budget.test.js
// fails above 30 tools or about 6,000 tokens (lib/tokens.js). To add a tool here, say which one leaves or why the budget grows.
import { ALIASES, REPLACED } from "./memory-tools.js";
import { buildToolIndex, findTools, confident } from "../../lib/tools-index.js";
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

/** The four tools the server answers itself (find, run many in one call, read a result by handle, call one by name). They are listed beside the core. */
export const META = ["tools_find", "tools_run", "results_read", "tools_call"];

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
    description: "Find the Vyre tool for what you are about to do. Describe it in plain words (\"remind me at 6\", \"search my inbox\"): you get the best three, each with a ready example call, and two more in brief. Only tools you may use are found. Run one with tools_call.",
    inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", maxLength: 300 }, limit: { type: "integer", minimum: 1, maximum: 10 } } },
  },
  {
    name: "tools_run",
    description: "Run up to 20 tool calls in one go and get one answer. steps: [{id, call, input, when?} or {id, fn: \"JS body returning an object\", inputs?}]. A value {expr:\"steps.<id>.rows[0].id\"} reads an earlier result; return:{name:{expr}} shapes the answer. Each step is judged as if you called it alone; it stops at a held, refused or failed step and says where.",
    inputSchema: { type: "object", required: ["steps"], properties: { steps: { type: "array", maxItems: 20, items: { type: "object" } }, return: { type: "object" } } },
  },
  {
    name: "results_read",
    description: "Read part of a big result you were given a handle for: { handle, select?, where?, sort?, fields?, offset?, limit? }. select is a path (result.records); on a list, where {\"data.stage\":\"Open\"}, sort (\"data.name\", \"-\" for descending) and fields [\"data.name\"] narrow it first, so one read can be all you need. Drop one with tools_call results_drop.",
    inputSchema: { type: "object", required: ["handle"], properties: { handle: { type: "string", maxLength: 80 }, select: { type: "string", maxLength: 200 }, where: { type: "object" }, sort: { type: "string", maxLength: 100 }, fields: { type: "array", maxItems: 20, items: { type: "string" } }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 200 } } },
  },
  {
    name: "tools_call",
    description: "Run any Vyre tool you may use, by the name tools_find gave: { tool, arguments }. Held and approval rules are the same as calling it directly.",
    inputSchema: { type: "object", required: ["tool"], properties: { tool: { type: "string", maxLength: 100 }, arguments: { type: "object" } } },
  },
];

/**
 * Which of the two batching features a session has. Unset (every real session): tools_run only; results by reference is OFF until a paid run proves it pays (lead ruling 9 Oct). Set, for measuring:
 * "" both, "run" (tools_run), "ref" (results by reference), "none".
 * @param {string} [v]
 */
export const featuresOf = (v) => (v === undefined ? { run: true, ref: false } : { run: v === "" || v === "run", ref: v === "" || v === "ref" });

/**
 * The MCP listing: the core that this caller has, then the meta tools. With `mode` "all" (VYRE_MCP_LISTING=all) every tool is listed, as before 0.3.1: only the token proof
 * (scripts/token-proof.mjs) sets it, to measure the old listing against the new one.
 * @param {ReturnType<typeof catalogOf>} catalog @param {string} [mode] @param {string} [features]
 */
export function listing(catalog, mode = "", features = "") {
  if (mode === "all") return catalog.map((c) => ({ name: c.name, description: c.description, inputSchema: c.input }));
  const by = new Map(catalog.map((c) => [c.name, c]));
  const core = CORE.filter((n) => by.has(n)).map((n) => { const c = /** @type {any} */ (by.get(n)); return { name: c.name, description: c.description, inputSchema: c.input }; });
  const f = featuresOf(features);
  return [...core, ...META_TOOLS.filter((t) => (t.name === "tools_run" ? f.run : t.name === "results_read" ? f.ref : true))];
}

/** The search index over a catalog (and any hub tools handed in the same shape). @param {{ name: string, tool?: string, description: string, input: any }[]} catalog */
export function indexOf(catalog) {
  const core = new Set(CORE);
  const hand = Object.fromEntries(Object.entries(ASKS).map(([k, v]) => [k, { ...v, core: core.has(k) }]));
  for (const n of CORE) if (!hand[n]) hand[n] = { core: true };
  return buildToolIndex(catalog.map((c) => ({ name: c.name, also: c.tool, description: c.description, input: c.input })), hand);
}

/** The best tools for an intent, named as they are called. @param {ReturnType<typeof indexOf>} index @param {string} query @param {number} [limit] */
export function find(index, query, limit = 3, boost = undefined) {
  return findTools(index, query, { limit, boost });
}

/** A weak answer: nothing found, or a close call (the three views of lib/tools-index.js disagree and the first two are near). Half of the close calls are wrong at first place and three in four have the right tool in the first two. @param {{ score: number, agree?: number }[]} found */
export const weak = (found) => !confident(found);

/**
 * What tools_find sends back: the best three in full, with a ready call each, then the next ones compactly (name, a short description, the arguments they need), so a near miss is still on the
 * page. A close call says so and names the two, so the model reads both (and asks the person when their words do not settle it); an empty answer points at vyre_core, the map of modules.
 * @param {ReturnType<typeof find>} found @param {(name: string) => any} [inputOf] the input schema of a tool, for the compact entries
 */
export function shapeFind(found, inputOf = () => null) {
  const full = found.slice(0, 3).map((f) => ({ name: f.name, description: f.description, call: { tool: "tools_call", arguments: { tool: f.call.tool, arguments: f.call.arguments } } }));
  const more = found.slice(3).map((f) => { const inp = inputOf(f.name); const need = inp && Array.isArray(inp.required) ? inp.required.slice(0, 6) : []; return { name: f.name, description: f.description.slice(0, 80), ...(need.length ? { needs: need } : {}) }; });
  const close = found.length > 1 && weak(found) ? `Close call between ${found[0].name} and ${found[1].name}. Read both, take the one that does what the person asked, and if their words do not settle it, ask them which they mean.` : "";
  return { tools: full, ...(more.length ? { also: more } : {}), ...(close ? { unsure: close } : {}), ...(!found.length ? { browse: "Nothing fits? Call vyre_core for the map of Vyre's modules, then tools_find again with a module's name." } : {}) };
}
