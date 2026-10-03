// @ts-check
// The REAL kernel for module tests (kernel/gateway and kernel/tasks over the in-memory store), replacing the fake kernel where the gateway already provides
// what a module needs: records, authorize, events, tasks (ask) and the chain builder. What the gateway does not yet provide is added here as a port and
// named in docs/work/assistant.md "Gaps for platform": a definitions list, members.roleOf/isAdmin, grants.list/create, tasks.list and model.call.
// Tests only.
import { createGateway } from "../kernel/gateway/index.js";
import { createTasks, TASK_ACTIONS } from "../kernel/tasks/tasks.js";
import crypto from "node:crypto";
import { Presence } from "../kernel/seal/proof.js";
import { payloadHash, proofBytes, chainCtx } from "../kernel/seal/wire.js";
import { createMemoryStore } from "../kernel/store/memory.js";
import { createEventLog } from "../kernel/core/events.js";
import { createChainBuilder } from "../kernel/core/chain.js";
import { parseExpr, evalExpr } from "../records/language/expr.js";
import { createAuthorizer } from "../kernel/core/authorize.js";
import { createToolSurface } from "../kernel/tools/surface.js";
import { generateKeyPairSync } from "node:crypto";

/**
 * @param {{ space?: string, owner?: string, defs?: any[], actions?: any[], agents?: Record<string, string[]>, ownerActions?: string[], services?: Record<string, string[]>, people?: Record<string, { actions: string[], fields?: string[] }>, grantList?: any[], model?: (call: any) => any }} [o]
 *   agents: agent name to the actions its grant holds on everything in the Space.
 */
export async function createRealKernel({ space = "spc_aaaaaaaaaaaa", owner = "alex", defs = [], actions = [], agents = {}, ownerActions = ["records.*", "records.define", "events.read", "tasks.*"], services = {}, people = {}, model = () => ({ content: "" }) } = {}) {
  let T = 1_800_000_000_000;
  const clock = () => ++T;
  const chains = createChainBuilder({ space, owner, owner_uid: 501, key: Buffer.alloc(32, 3), clock, is_person: () => true });
  const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space });
  let n = 0;
  const grant = (/** @type {any} */ a, /** @type {string[]} */ acts) => ({ id: `gr_${String(++n).padStart(4, "0")}`, space, subject: { kind: "actor", actor: a }, actions: acts, action_set_version: 9, resource: { prefix: `vyre://${space}/*/*` }, conditions: {}, issuer: actor("person", owner), source: "test", status: "active", created_at: 0 });
  /** @type {any[]} */ const grants = [grant(actor("person", owner), [...ownerActions, ...actions.filter(a => String(a.risk).startsWith("outward.")).map(a => a.action)]), ...Object.entries(agents).map(([name, acts]) => grant(actor("agent", name), acts)), ...Object.entries(services).map(([name, acts]) => grant(actor("service", name), acts)), ...Object.entries(people).map(([name, p]) => { const g = grant(actor("person", name), p.actions); if (p.fields) g.resource = { ...g.resource, fields: p.fields }; return g; })];
  const members = new Set([`person:${owner}`, "service:tasks", ...Object.keys(agents).map(a => `agent:${a}`), ...Object.keys(services).map(a => `service:${a}`), ...Object.keys(people).map(a => `person:${a}`)]);
  const log = createEventLog({ space, clock });
  const registry = [...TASK_ACTIONS, ...actions];
  const gw = createGateway({ expr: { parseExpr, evalExpr }, space, store: createMemoryStore({ clock }), log, chains, clock, actions: registry, grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: (/** @type {any} */ a) => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  // The one verifier is the sealing process's Presence class; the rig wraps it the way the process's presence.check does (as kernel/tasks/tasks.test.js does).
  const pr = new Presence(clock, { allowUnattested: true });
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  pr.keys.set(`key-${owner}`, { person: owner, signer: "secure_enclave", attested: true, key: publicKey });
  const presence = { check: async (/** @type {any} */ { chain, op, fields, proof }) => (chain && proof ? pr.refuse(proof, { op, space, fields, ctx: chainCtx(chain) }) : "no_proof") };
  // Tasks reads the registry from the authorizer itself (a send must name an outward action), so it gets the real one over the same grants.
  const authorizer = createAuthorizer({ space, actions: [...registry, ...(await import("../kernel/gateway/records.js")).RECORD_ACTIONS], clock, grants: { forSubject: (/** @type {any} */ a) => grants.filter(g => g.subject.actor.kind === a.kind && g.subject.actor.id === a.id), get: () => undefined }, members: { has: (/** @type {any} */ a) => members.has(`${a.kind}:${a.id}`) }, hasPresenceSession: () => true });
  const tasks = createTasks({ space, authorizer, log, presence, chains, clock, members: { has: (/** @type {any} */ a) => members.has(`${a.kind}:${a.id}`) }, approver: () => actor("person", owner) });
  const person = (/** @type {string} */ who = owner) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
  const agent = (/** @type {string} */ name) => chains.fromFacts({ kind: "agent_session", agent: name, session: "s", thread: "t", vouched: true });
  /** @type {any[]} */ const current = [];
  if (defs.length) { await gw.records.define(person(), { add_types: defs }); current.push(...defs); }
  /** The owner's hardware-signed approval of a task waiting for a check, over the payload the kernel stored and the chain that is deciding. */
  const proofFor = async (/** @type {any} */ chain, /** @type {string} */ id) => {
    const t = await tasks.get(chain, id);
    const fields = { task: id, payload_hash: t.payload.payload_hash, decision: t.payload.decision };
    const base = { signer: "secure_enclave", key_id: `key-${owner}`, payload_hash: payloadHash("task.decide", space, fields), decision: "task.decide", chain_hash: chainCtx(chain).chain_hash, issued_at: T, expires_at: T + 60_000, nonce: `n${Math.random()}` };
    return { ...base, signature: crypto.sign("sha256", proofBytes(base), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
  };
  const modelCalls = [];
  const kernel = { space, grants: { list: async (/** @type {any} */ _c, /** @type {any} */ f = {}) => grants.filter(g => (!f.subject || (g.subject.actor.kind === f.subject.actor.kind && g.subject.actor.id === f.subject.actor.id)) && (!f.status || g.status === f.status)), create: async (/** @type {any} */ _c, /** @type {any} */ g) => { const made = { id: `gr_${String(++n).padStart(4, "0")}`, space, status: "active", created_at: 0, action_set_version: 9, issuer: actor("person", owner), ...g }; grants.push(made); members.add(`${g.subject.actor.kind}:${g.subject.actor.id}`); return made; } },
    members: { roleOf: (/** @type {any} */ c) => (c.hops[0].actor.kind === "person" ? "owner" : null), isAdmin: (/** @type {any} */ c) => c.hops[0].actor.kind === "person" && c.hops[0].actor.id === owner },
    model: { call: async (/** @type {any} */ i) => { modelCalls.push(i); return { id: "m", provider: "fake", model: "fake", ...(await model(i)) }; } },
    engineerChain: () => agentChain("engineer"),
    serviceChain: (/** @type {string} */ name) => chains.fromFacts({ kind: "module", module: name, first_party: true }),
    chainForPerson: () => person(), authorize: gw.authorize, records: gw.records, events: gw.events, ask: tasks, definitions: async () => current, actions: () => registry, chainFor: () => person() };
  const agentChain = agent;
  const surface = createToolSurface({ kernel, space, types: () => current, actions: () => registry });
  return { kernel, surface, proofFor, modelCalls, members, grants, space, person, agent, actor, log, gw, tasks, chains, define: async (/** @type {any} */ d) => { await gw.records.define(person(), { add_types: [d] }); current.push(d); } };
}
