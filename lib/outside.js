// @ts-check
// lib/outside: what an outside agent is to the rest of Vyre (team/contracts/ext-agents.md): its names, its limits and the small fixed set of tools /agents-mcp offers, written once. An outside agent is
// something that is not a Vyre session (Dots, Muse, Hermes, ChatGPT, a person's own Claude Code on another machine). It holds only what it was given, every use is on the record, and the person can end
// it at once. Pure: the outside module, the Vault's pass and the Settings screen import this; none copies it.

export const LIMITS = Object.freeze({ maxDays: 90, defaultDays: 7, defaultRate: 30, maxRate: 600, nameChars: 80, noteChars: 200, badTokens: 5, lockMinutes: 10 });

/** New agents get 24 lower-case letters and digits; a pass made before registration existed has its time-ordered uuid (36 characters, with dashes), and keeps it. */
const RAND = /^[a-z0-9][a-z0-9-]{9,39}$/;

/** The registry caller of an outside agent: `ext:<random>`. The kernel decides everything else from its grants. @param {string} id the random part */
export const callerOf = id => { if (!RAND.test(id)) throw new Error("an outside agent's id is 10 to 40 lower-case letters, digits and dashes"); return `ext:${id}`; };
/** The kernel actor id the same agent holds grants under. The Vault pass already used this shape (`ext_<id>`), so a pass and a registered agent share one namespace. @param {string} id */
export const actorIdOf = id => { if (!RAND.test(id)) throw new Error("an outside agent's id is 10 to 40 lower-case letters, digits and dashes"); return `ext_${id}`; };
/** The random id in a registry caller (`ext:<id>`), or null for any other label. Exact: nothing before or after. @param {string|{caller?: string}} meta @returns {string|null} */
export const idOfCaller = meta => { const m = /^ext:([a-z0-9][a-z0-9-]{9,39})$/.exec(typeof meta === "string" ? meta : String((meta && meta.caller) || "")); return m ? m[1] : null; };
/** Whether a label is an outside agent's. Never the person, never a module, never a model session. @param {string|{caller?: string}} meta */
export const isOutside = meta => idOfCaller(meta) !== null;
/** The random id in a kernel actor id (`ext_<id>`), or null. @param {string} actorId */
export const idOfActor = actorId => { const m = /^ext_([a-z0-9][a-z0-9-]{9,39})$/.exec(String(actorId)); return m ? m[1] : null; };

/**
 * What the person can give an outside agent, by kind. `records` reads typed records of chosen types; `memory` asks one project's memory room; `files` reads one project's folder; `vault` uses chosen api credentials
 * through the Vault pass (given by the Vault until it moves in). `write` is a separate yes for records, and a write only ever files a Gate item.
 * @typedef {{ kind: "records", types?: string[], write?: boolean } | { kind: "memory", project: string } | { kind: "files", project: string } | { kind: "vault", items: string[], hosts?: string[], reveal?: boolean }} Reach
 */

/**
 * The tools /agents-mcp can offer, with the reach each needs. A tool is listed only when the agent holds it, so an agent with no grant lists `whoami` and nothing else. No `tools_call`: an outsider reaches
 * these and no other tool of the registry. Descriptions are product copy (at most 25 words).
 */
export const MCP_TOOLS = Object.freeze([
  { name: "whoami", needs: null, description: "Who you are to this Vyre and what you may reach: your name, your grants in plain words, when they end.", inputSchema: { type: "object", properties: {} } },
  { name: "records_types", needs: "records.read", description: "The kinds of records you may read, with their fields.", inputSchema: { type: "object", properties: {} } },
  { name: "records_list", needs: "records.read", description: "List records of one type you may read: { type, filter?, limit? }. Sealed fields come back as placeholders.", inputSchema: { type: "object", required: ["type"], properties: { type: { type: "string" }, filter: { type: "object" }, limit: { type: "integer" } } } },
  { name: "records_get", needs: "records.read", description: "One record by its urn: { urn }. Fields you were not given are absent and sealed ones are placeholders. Unreadable means not found.", inputSchema: { type: "object", required: ["urn"], properties: { urn: { type: "string" } } } },
  { name: "memory_ask", needs: "memory.read", description: "Ask the memory of a project you were given: { project, question }. Answers in words with where they came from.", inputSchema: { type: "object", required: ["project", "question"], properties: { project: { type: "string" }, question: { type: "string" } } } },
  { name: "files_read", needs: "files.read", description: "List or read a file in a project folder you were given: { project, path? }. Text comes back as text; others by name.", inputSchema: { type: "object", required: ["project"], properties: { project: { type: "string" }, path: { type: "string" } } } },
  { name: "records_create", needs: "records.write", description: "Ask to add a record: { type, fields }. It waits for the person's yes and answers { held }; poll held_get.", inputSchema: { type: "object", required: ["type", "fields"], properties: { type: { type: "string" }, fields: { type: "object" } } } },
  { name: "records_update", needs: "records.write", description: "Ask to change a record: { urn, fields }. It waits for the person's yes and answers { held }; poll held_get.", inputSchema: { type: "object", required: ["urn", "fields"], properties: { urn: { type: "string" }, fields: { type: "object" } } } },
  { name: "held_get", needs: "records.write", description: "Whether a change you asked for was approved: { held } returns waiting, done or declined.", inputSchema: { type: "object", required: ["held"], properties: { held: { type: "string" } } } },
]);

/**
 * The tools listed to an agent that holds these needs (`records.read`, `records.write`, `memory.read`, `files.read`). Vault tools are added by the Vault's pass for an agent that holds a vault reach.
 * @param {Iterable<string>} held @returns {typeof MCP_TOOLS[number][]}
 */
export function toolsFor(held) {
  const has = new Set(held);
  return MCP_TOOLS.filter(t => t.needs === null || has.has(t.needs));
}

/** The reach, in one plain line for Settings and for `whoami`: "reads Clients and Matters; asks to add or change records; asks the Harlow project's memory". @param {Reach[]} reach @param {(project: string) => string} [projectName] */
export function reachLine(reach, projectName = p => p) {
  const parts = [];
  for (const r of reach) {
    if (r.kind === "records") parts.push(`${r.types && r.types.length ? `reads ${r.types.join(" and ")}` : "reads records"}${r.write ? "; asks to add or change them" : ""}`);
    else if (r.kind === "memory") parts.push(`asks the memory of ${projectName(r.project)}`);
    else if (r.kind === "files") parts.push(`reads the files of ${projectName(r.project)}`);
    else if (r.kind === "vault") parts.push(`uses ${r.items.length === 1 ? r.items[0] : `${r.items.length} credentials`} without seeing ${r.items.length === 1 ? "it" : "them"}${r.reveal ? "; may ask to see a value" : ""}`);
  }
  return parts.length ? parts.join("; ") : "has been given nothing yet";
}
