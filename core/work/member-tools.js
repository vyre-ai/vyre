// @ts-check
// THE MEMBER DOOR'S ONE TABLE (0.3.3, the owner's rule: a team member is a meaningful part of the team command center; roles and Settings come later and edit THIS table). A team member reaches the team's server only
// through the Space's kernel (kernel/remote), never through a registry tool, so every thing a member may do beyond chat is a ROW here: a door call -> [the registry tool that serves it, its call name]. The service
// takes the chain's one person hop (never the owner), refuses a non-member, and runs the tool with registry.callInSpace IN THE TEAM'S SPACE under that member's own chain; the tool's `crossSpace` action
// (a kernel action the MEMBER role holds, kernel/grants/roles.js) is checked by the Space's own authorize first, and the tool itself judges what the person may do with the chain it is handed.
//
// ADDING A ROW (the same three steps for every group):
//   1. kernel/remote/wire.js: put the call name in CALLS.<group> (a new group needs its name in the peer door's services, below, which is automatic from this table's keys);
//   2. here: add `"<group>.<call>": ["<registry tool>", "<call>"]` to MEMBER_TOOLS. With a call name the tool is a *.serve entry and is run with `{ call, input }`; with `null` the tool is run with the input itself;
//   3. the tool: declare it in its module.json with "reach": "modules" and "crossSpace": "<an action the MEMBER role holds>", and read the person from `extra.in_space_chain` (NEVER assume the owner; the work
//      module's chainOf and skills' serve tools are the pattern). Test it as a member, as the owner and as a non-member (core/work/member-tools.test.js is the template: a row without that test is not added).
// A row is added only for a tool that takes the person from the chain.

import { KernelError } from "../../kernel/core/errors.js";

/** door call ("<group>.<call>") -> [registry tool, its call name or null]. Edited by roles and Settings later; today it is this file. @type {Readonly<Record<string, [string, string | null]>>} */
export const MEMBER_TOOLS = Object.freeze({
  // a member's own skills (core/skills/member-ops.js): her personal skill is drafted and approved by her alone; a draft at a higher level waits for its owner; kind "skill" only
  "skills.list": ["skills.serve", "list"],
  "skills.get": ["skills.serve", "get"],
  "skills.versions": ["skills.serve", "versions"],
  "skills.draft": ["skills.serve-write", "draft"],
  "skills.approve": ["skills.serve-write", "approve"],
});

const CODES = /** @type {Record<string, string>} */ ({ denied: "not_allowed", not_allowed: "not_allowed", not_found: "not_found", bad_input: "bad_input", not_declared: "not_found" });

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
  const who = (/** @type {any} */ chain) => {
    const h = chain && Array.isArray(chain.hops) ? chain.hops : [];
    if (chain?.space !== o.space || chain.viewer === true || chain.delegated === true || h.length !== 1 || !h[0].actor || h[0].actor.kind !== "person") throw new KernelError("not_found", "not found");
    return String(h[0].actor.id);
  };
  const isMember = (/** @type {string} */ person) => {
    try { const r = o.kernel?.gateway?.members?.roleOf({ kind: "person", id: person, space: o.space }); return typeof r === "string" && r !== ""; } catch { return false; }
  };
  const run = (/** @type {string} */ door) => async (/** @type {any} */ chain, /** @type {any} */ input) => {
    const person = who(chain);
    if (!isMember(person)) throw new KernelError("not_found", "not found");   // not a member: nothing to say
    const i = input && typeof input === "object" && !Array.isArray(input) ? { ...input } : {};
    delete i.space; delete i.as;
    const [tool, call] = MEMBER_TOOLS[door];
    const r = await o.registry.callInSpace({ name: "vyred" }, o.space, o.kernel, tool, call ? { call, input: i } : i, chain);
    if (r && r.error) throw new KernelError(/** @type {any} */ (CODES[r.error.code] || "bad_input"), String(r.error.message || "that did not work"));
    return r.data;
  };
  /** @type {Record<string, Record<string, any>>} */ const out = {};
  for (const [group, calls] of Object.entries(memberGroups())) out[group] = Object.fromEntries(calls.map(c => [c, run(`${group}.${c}`)]));
  return out;
}
