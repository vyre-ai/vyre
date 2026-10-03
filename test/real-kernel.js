// @ts-check
// The REAL kernel for module tests (kernel/gateway and kernel/tasks over the in-memory store), replacing the fake kernel where the gateway already provides
// what a module needs: records, authorize, events, tasks (ask) and the chain builder. What the gateway does not yet provide is added here as a port and
// named in docs/work/assistant.md "Gaps for platform": a definitions list, members.roleOf/isAdmin, grants.list/create, tasks.list and model.call.
// Tests only.
import { createGateway } from "../kernel/gateway/index.js";
import { createTasks, TASK_ACTIONS } from "../kernel/tasks/tasks.js";
import { createPresence } from "../kernel/tasks/presence.js";
import { createMemoryStore } from "../kernel/store/memory.js";
import { createEventLog } from "../kernel/core/events.js";
import { createChainBuilder } from "../kernel/core/chain.js";
import { createToolSurface } from "../kernel/tools/surface.js";

/**
 * @param {{ space?: string, owner?: string, defs?: any[], actions?: any[], agents?: Record<string, string[]>, ownerActions?: string[] }} [o]
 *   agents: agent name to the actions its grant holds on everything in the Space.
 */
export async function createRealKernel({ space = "spc_aaaaaaaaaaaa", owner = "alex", defs = [], actions = [], agents = {}, ownerActions = ["records.*", "records.define", "events.read", "tasks.*"] } = {}) {
  let T = 1_800_000_000_000;
  const clock = () => ++T;
  const chains = createChainBuilder({ space, owner, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: () => true });
  const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space });
  let n = 0;
  const grant = (/** @type {any} */ a, /** @type {string[]} */ acts) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space, subject: { kind: "actor", actor: a }, actions: acts, action_set_version: 9, resource: { prefix: `vyre://${space}/*/*` }, conditions: {}, issuer: actor("person", owner), source: "test", status: "active", created_at: 0 });
  /** @type {any[]} */ const grants = [grant(actor("person", owner), [...ownerActions, ...actions.filter(a => String(a.risk).startsWith("outward.")).map(a => a.action)]), ...Object.entries(agents).map(([name, acts]) => grant(actor("agent", name), acts))];
  const members = new Set([`person:${owner}`, "service:tasks", ...Object.keys(agents).map(a => `agent:${a}`)]);
  const log = createEventLog({ space, clock });
  const registry = [...TASK_ACTIONS, ...actions];
  const gw = createGateway({ space, store: createMemoryStore({ clock }), log, chains, clock, actions: registry, grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: (/** @type {any} */ a) => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  const tasks = createTasks({ space, authorizer: { authorize: gw.authorize }, log, presence: createPresence({ clock }), chains, clock, members: { has: (/** @type {any} */ a) => members.has(`${a.kind}:${a.id}`) }, approver: () => actor("person", owner) });
  const person = () => chains.fromFacts({ kind: "device", device_key_id: `d-${owner}`, person: owner, path: "direct" });
  const agent = (/** @type {string} */ name) => chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });
  /** @type {any[]} */ const current = [];
  if (defs.length) { await gw.records.define(person(), { add_types: defs }); current.push(...defs); }
  const kernel = { space, authorize: gw.authorize, records: gw.records, events: gw.events, ask: tasks, definitions: async () => current, actions: () => registry, chainFor: () => person() };
  const surface = createToolSurface({ kernel, space, types: () => current, actions: () => registry });
  return { kernel, surface, space, person, agent, actor, log, gw, tasks, chains, define: async (/** @type {any} */ d) => { await gw.records.define(person(), { add_types: [d] }); current.push(d); } };
}
