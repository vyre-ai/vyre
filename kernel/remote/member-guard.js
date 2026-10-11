// @ts-check
// The member door's records group runs under the MEMBER role, which holds records.read/create/update/remove/restore on every type. The record types a service keeps its own bookkeeping in must not be reachable
// that way: a member could read another member's personal skill, approve a draft by writing its state, change a Flow version or forge its approval. This is the one place that closes it: for a chain that is not
// an owner or admin, any records call on a type of MEMBER_BLOCKED_TYPES answers "not found", a search or a list of definitions leaves those types out. Services write these types with their own chain, which never
// comes through this door; the owner and admins keep their access. A new service that keeps records adds its type here (and the member door's table, core/work/member-tools.js, names the types a row keeps).

import { KernelError } from "../core/errors.js";

/** @type {ReadonlySet<string>} */
export const MEMBER_BLOCKED_TYPES = Object.freeze(new Set(["skill", "def-flow", "def_flow", "flow-approval", "flow-state", "flow-control", "flow-tests", "flow-schedule", "flow-run", "project-template", "def-watcher", "kit-proposal", "kit-install", "planner_state", "planner_firing", "preview_doc"]));

/** Types a member may READ (the app shows a project's team and the roster) but never write through the door: the project team decides who may open what a project shares, and the agent records are a view the module puts back. @type {ReadonlySet<string>} */
export const MEMBER_READ_ONLY_TYPES = Object.freeze(new Set(["team-member", "agent"]));

const TYPED = new Set(["get", "reference", "query", "aggregate", "create", "update", "remove", "restore"]);
const WRITES = new Set(["create", "update", "remove", "restore"]);

/**
 * Wrap one call of the records group for the member door. @param {string} name the call after "records." @param {(chain: any, ...args: any[]) => Promise<any>} fn @param {(chain: any) => boolean} trusted owner or admin
 */
export function guardRecordsCall(name, fn, trusted) {
  if (TYPED.has(name)) return async (/** @type {any} */ chain, /** @type {any[]} */ ...args) => {
    if (!trusted(chain) && typeof args[0] === "string") {
      if (MEMBER_BLOCKED_TYPES.has(args[0])) throw new KernelError("not_found", "not found");
      if (WRITES.has(name) && MEMBER_READ_ONLY_TYPES.has(args[0])) throw new KernelError("not_allowed", "That is kept by the team's own tools; ask the owner or an admin.");
    }
    return fn(chain, ...args);
  };
  if (name === "search") return async (/** @type {any} */ chain, /** @type {any[]} */ ...args) => {
    const r = await fn(chain, ...args);
    return trusted(chain) || !r || !Array.isArray(r.rows) ? r : { ...r, rows: r.rows.filter((/** @type {any} */ h) => !MEMBER_BLOCKED_TYPES.has(String(h && h.type))) };
  };
  if (name === "definitions") return async (/** @type {any} */ chain, /** @type {any[]} */ ...args) => {
    const r = await fn(chain, ...args);
    if (trusted(chain)) return r;
    const keep = (/** @type {any} */ t) => !MEMBER_BLOCKED_TYPES.has(String(t && (t.name || t.type)));
    return Array.isArray(r) ? r.filter(keep) : r && Array.isArray(r.types) ? { ...r, types: r.types.filter(keep) } : r;
  };
  return fn;
}
