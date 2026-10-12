// @ts-check
// THE MEMBER DOOR'S ONE TABLE (0.3.3, the owner's rule: a team member is a meaningful part of the team command center; roles and Settings come later and edit THIS table). A team member reaches the team's server only
// through the Space's kernel (kernel/remote), never through a registry tool, so every thing a member may do beyond chat is a ROW here: a door call -> [the registry tool that serves it, its call name]. The service
// takes the chain's one person hop (never the owner), refuses a non-member, and runs the tool with registry.callInSpace IN THE TEAM'S SPACE under that member's own chain; the tool's `crossSpace` action
// (a kernel action the MEMBER role holds, kernel/grants/roles.js) is checked by the Space's own authorize first, and the tool itself judges what the person may do with the chain it is handed.
//
// ADDING A ROW (the same three steps for every group):
//   1. kernel/remote/wire.js: put the call name in CALLS.<group> (a new group needs its name in the peer door's services, below, which is automatic from this table's keys);
//   2. here: add `"<group>.<call>": { tool, call, keys, types }` to MEMBER_TOOLS: with a call name the tool is a *.serve entry and is run with `{ call, input }`, with `null` it is run with the input itself; `keys` are the only input keys the door passes;
//      `types` are the record types the row keeps (each in kernel/remote/member-guard.js MEMBER_BLOCKED_TYPES, a test fails otherwise);
//   3. the tool: declare it in its module.json with "reach": "modules" and "crossSpace": "<an action the MEMBER role holds>", and read the person from `extra.in_space_chain` (NEVER assume the owner; the work
//      module's chainOf and skills' serve tools are the pattern). Test it as a member, as the owner and as a non-member (core/work/member-tools.test.js is the template: a row without that test is not added).
// A row is added only for a tool that takes the person from the chain.

import { KernelError } from "../../kernel/core/errors.js";
import { CALLS } from "../../kernel/remote/wire.js";

/**
 * door call ("<group>.<call>") -> the registry tool that serves it, the call name it is run with (null: the tool is run with the input itself), the input keys the door lets through (every other key is dropped,
 * so a member never names the person, the agent, the project or the Space), and the record types the row keeps (each must be in kernel/remote/member-guard.js MEMBER_BLOCKED_TYPES: a test fails otherwise).
 * Edited by roles and Settings later; today it is this file. @type {Readonly<Record<string, { tool: string, call: string | null, keys: readonly string[], types: readonly string[], target?: "project" }>>}
 */
export const MEMBER_TOOLS = Object.freeze({
  // a member's own skills (core/skills/member-ops.js): her personal skill is drafted and approved by her alone; a draft at a higher level waits for its owner; kind "skill" only
  "skills.list": { tool: "skills.serve", call: "list", keys: ["level"], types: ["skill"] },
  "skills.get": { tool: "skills.serve", call: "get", keys: ["id"], types: ["skill"] },
  "skills.versions": { tool: "skills.serve", call: "versions", keys: ["name", "level", "scope", "state"], types: ["skill"] },
  "skills.draft": { tool: "skills.serve-write", call: "draft", keys: ["name", "level", "scope", "kind", "body", "note"], types: ["skill"] },
  "skills.approve": { tool: "skills.serve-write", call: "approve", keys: ["name", "level", "scope", "version"], types: ["skill"] },
  // a member's daily work on the team's records and tasks, the app Store's own calls (same names, same input keys): her chain decides every record and task; the kept record types are refused in the tool and by the gateway
  "records.me": { tool: "records.serve", call: "me", keys: [], types: [] },
  "records.actors": { tool: "records.serve", call: "actors", keys: [], types: [] },
  "records.types": { tool: "records.serve", call: "types", keys: [], types: [] },
  "records.list": { tool: "records.serve", call: "list", keys: ["type", "filter", "sort", "cursor", "limit", "include_deleted"], types: [] },
  "records.get": { tool: "records.serve", call: "get", keys: ["urn"], types: [] },
  "records.events": { tool: "records.serve", call: "events", keys: ["record", "task", "since", "limit"], types: [] },
  "records.create": { tool: "records.serve-create", call: "create", keys: ["type", "data", "idem"], types: [] },
  "records.update": { tool: "records.serve-update", call: "update", keys: ["urn", "patch", "base_version"], types: [] },
  "tasks.list": { tool: "tasks.serve", call: "list", keys: ["record", "doer", "checker", "state", "limit"], types: [] },
  "tasks.get": { tool: "tasks.serve", call: "get", keys: ["id"], types: [] },
  "tasks.request": { tool: "tasks.serve-request", call: "request", keys: ["task", "idem"], types: [] },
  "tasks.move": { tool: "tasks.serve-work", call: "move", keys: ["id", "to", "reason", "suggested_fix"], types: [] },
  "tasks.submit": { tool: "tasks.serve-work", call: "submit", keys: ["id", "evidence"], types: [] },
  // a member's own projects (core/work/member-projects.js): she starts her own, blank or from an installed template; a template record is read inside the call by the work module, what it makes is made under her chain
  // a member's project files (core/work/member-files.js): list, read and upload in one project's files area; the folder is built from the project record, a name is a plain name, a size and a count cap, nothing else of Drive
  // a member's own Flows (core/flows/member.js): Flows belong to the Space; any member drafts, a version runs on the authority of whoever approved it, and she approves her own with any trigger
  "flows.cheatsheet": { tool: "flows.serve", call: "cheatsheet", keys: [], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.compile-text": { tool: "flows.serve", call: "compile-text", keys: ["text", "id", "format"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.list": { tool: "flows.serve", call: "list", keys: [], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.health": { tool: "flows.serve", call: "health", keys: ["id"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.get": { tool: "flows.serve", call: "get", keys: ["id", "version"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.card": { tool: "flows.serve", call: "card", keys: ["id", "version"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.code": { tool: "flows.serve", call: "code", keys: ["id", "version", "format"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.graph": { tool: "flows.serve", call: "graph", keys: ["id", "version"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.diff": { tool: "flows.serve", call: "diff", keys: ["id", "from", "to"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.describe": { tool: "flows.serve", call: "describe", keys: ["id", "version", "run"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.define": { tool: "flows.serve", call: "define", keys: ["id", "flow", "text", "format"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.patch": { tool: "flows.serve", call: "patch", keys: ["id", "base", "ops"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.from-chat": { tool: "flows.serve", call: "from-chat", keys: ["calls", "name", "label", "variables", "propose"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.test-save": { tool: "flows.serve", call: "test-save", keys: ["id", "version", "name", "event", "input", "expect", "from_run"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.test-remove": { tool: "flows.serve", call: "test-remove", keys: ["id", "name"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.test-list": { tool: "flows.serve", call: "test-list", keys: ["id", "version"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.test-run": { tool: "flows.serve", call: "test-run", keys: ["id", "version", "name"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.simulate": { tool: "flows.serve", call: "simulate", keys: ["id", "version", "flow", "against", "samples", "since", "until", "limit"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.start": { tool: "flows.serve", call: "start", keys: ["id", "input"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.runs": { tool: "flows.serve", call: "runs", keys: ["id", "state", "limit"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.run": { tool: "flows.serve", call: "run", keys: ["run"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.timeline": { tool: "flows.serve", call: "timeline", keys: ["run", "step"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.attention": { tool: "flows.serve", call: "attention", keys: [], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.cancel": { tool: "flows.serve", call: "cancel", keys: ["run", "reason"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.retry": { tool: "flows.serve", call: "retry", keys: ["run", "skip", "value", "version"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.approve": { tool: "flows.serve", call: "approve", keys: ["id", "version", "hash"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  "flows.propose": { tool: "flows.serve", call: "propose", keys: ["id", "version", "note"], types: ["def-flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run"] },
  // a member's own projects (core/work/member-projects.js): she starts her own, blank or from an installed template; a template record is read inside the call by the work module, what it makes is made under her chain
  "work.templates": { tool: "work.serve", call: "templates", keys: [], types: ["project-template"] },
  "work.timeline": { tool: "work.serve", call: "timeline", keys: ["project", "record", "limit"], types: [], target: "project" },
  "work.project-create": { tool: "work.serve-write", call: "create-project", keys: ["name", "slug"], types: [] },
  "work.start-project": { tool: "work.serve-write", call: "start-project", keys: ["template", "name", "slug"], types: ["project-template"] },
  // a member's project files (core/work/member-files.js): list, read and upload in one project's files area; the folder is built from the project record, a name is a plain name, a size and a count cap, nothing else of Drive
  "files.list": { tool: "work.serve", call: "files-list", keys: ["project"], types: [], target: "project" },
  "files.read": { tool: "work.serve", call: "files-read", keys: ["project", "name"], types: [], target: "project" },
  "files.upload": { tool: "work.serve-write", call: "files-upload", keys: ["project", "name", "data"], types: [], target: "project" },
});

/**
 * Door names the kernel's gateway also serves (records.get(type, id), tasks.get(id), tasks.request(spec)): a member's HOME reaches the team through the gateway's shapes, her APP through the Store's. A call whose
 * first argument is not the Store's object goes to the gateway untouched, and every call of these two groups the table does not name passes through to the gateway as before.
 */
const SHARED = Object.freeze({
  "records.get": (/** @type {any} */ a) => a && typeof a === "object" && typeof a.urn === "string",
  "records.create": (/** @type {any} */ a) => a && typeof a === "object" && typeof a.type === "string" && a.data && typeof a.data === "object",
  "records.update": (/** @type {any} */ a) => a && typeof a === "object" && typeof a.urn === "string",
  "tasks.get": (/** @type {any} */ a) => a && typeof a === "object" && typeof a.id === "string",
  "tasks.request": (/** @type {any} */ a) => a && typeof a === "object" && a.task && typeof a.task === "object",
});

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_allowed: "not_allowed", not_found: "not_found", bad_input: "bad_input", not_declared: "not_found", version_conflict: "version_conflict", sealed_value_refused: "sealed_value_refused", unavailable: "unavailable" });

/** The groups of the table, each with its calls: the peer door's services. */
export const memberGroups = () => {
  /** @type {Record<string, string[]>} */ const g = {};
  for (const k of Object.keys(MEMBER_TOOLS)) { const [group, call] = [k.slice(0, k.indexOf(".")), k.slice(k.indexOf(".") + 1)]; (g[group] ||= []).push(call); }
  return g;
};

/**
 * One service per group of the table, for the peer door's `services`. @param {{ space: string, kernel: any, registry: { callInSpace(m: any, space: string, base: any, tool: string, input: any, chain: any): Promise<any> } }} o
 */
export function createMemberTools(o) {
  // every row's tool must be one only this door runs: internal, for modules, declared to run in another Space (a row whose tool is not is a mistake that must stop the daemon, not a hole)
  const tools = /** @type {any} */ (o.registry).tools;
  if (tools && typeof tools.get === "function") for (const [door, row] of Object.entries(MEMBER_TOOLS)) {
    const def = tools.get(row.tool);
    if (def && !(def.internal === true && def.crossSpace && def.reach === "modules")) throw new Error(`member door row ${door}: ${row.tool} must be an internal tool for modules that declares crossSpace`);
  }
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  /** The gateway's own function for a name: called as the peer door calls it, (chain, ...args). @param {string} door */
  const gatewayFn = (door) => {
    const group = door.slice(0, door.indexOf(".")), name = door.slice(door.indexOf(".") + 1);
    const tree = group === "tasks" ? o.kernel?.gateway?.ask : o.kernel?.gateway?.[group];
    const fn = tree && Object.hasOwn(tree, name) ? tree[name] : null;
    return typeof fn === "function" ? fn : null;
  };
  const run = (/** @type {string} */ door) => async (/** @type {any} */ chain, /** @type {any} */ input, /** @type {any[]} */ ...rest) => {
    if (Object.hasOwn(SHARED, door) && !(/** @type {any} */ (SHARED)[door])(input)) {
      const g = gatewayFn(door);
      if (!g) throw new KernelError("not_found", "not found");
      return g(chain, input, ...rest);
    }
    const person = who(chain);
    if (!isMember(person)) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const row = MEMBER_TOOLS[door];
    const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const i = Object.fromEntries(row.keys.filter(k => Object.hasOwn(src, k)).map(k => [k, src[k]]));   // only the keys the row names: never the person, the agent, the project or the Space
    const r = await o.registry.callInSpace({ name: "vyred" }, o.space, o.kernel, row.tool, row.call ? { call: row.call, input: i } : i, chain);
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  /** @type {Record<string, Record<string, any>>} */ const out = {};
  for (const [group, calls] of Object.entries(memberGroups())) {
    out[group] = Object.fromEntries(calls.map(c => [c, run(`${group}.${c}`)]));
    // records and tasks are groups the gateway serves too: this service stands in for the whole group at the door, so every other call of the gateway's passes through unchanged
    if (group !== "records" && group !== "tasks") continue;
    for (const c of (/** @type {Record<string, readonly string[]>} */ (CALLS)[group] || [])) {
      if (Object.hasOwn(out[group], c)) continue;
      const g = gatewayFn(`${group}.${c}`);
      if (g) out[group][c] = (/** @type {any} */ chain, /** @type {any[]} */ ...a) => g(chain, ...a);
    }
  }
  return out;
}
