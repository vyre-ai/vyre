// @ts-check
// core/vault/kernel-rig.js: a real kernel (the grants store and the authorizer, kernel/grants and kernel/gateway) behind the handle the vault module gets as `ctx.kernel`, for tests of who may use a
// login or a vault. Presence is permissive (the vault's own tests cover proofs); everything else is the kernel's own code. The vault's two fakes: `ctx.call` answers `agents.uid` for the agents named
// in `agents`, and `chain(meta)` is the owner unless a test hands in `meta.chain`.

import { createGateway } from "../../kernel/gateway/index.js";
import { createGrantsStore } from "../../kernel/grants/index.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createEventLog } from "../../kernel/core/events.js";
import { createChainBuilder } from "../../kernel/core/chain.js";
import { AGENT_ACTIONS } from "../../kernel/seal/uses.js";

export const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";

/** @param {{ clock?: () => number, agents?: Record<string, string>, people?: string[] }} [o] */
export async function kernelRig(o = {}) {
  let T = Date.now();
  const clock = o.clock || (() => ++T);
  const agents = o.agents || { kit: "agt_kit", juno: "agt_juno" };
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
  const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const person = (/** @type {string} */ who) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
  /** An agent acting for a person, as the kernel builds it for a session. */
  const assistant = (/** @type {string} */ uid, who = OWNER) => chains.fromFacts({ kind: "agent_session", agent: uid, session: "s", thread: "t", vouched: true, person: who });
  const presence = { check: async () => null };
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, 5), presence });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true });
  await gs.bootstrap({ owner: OWNER });
  for (const who of o.people || []) await gw.grants.setRole(owner(), { person: who, role: "member" }, { presence: { n: Math.random() } });
  const K = {
    space: SPACE, owner: OWNER, grants: gw.grants, authorize: gw.authorize,
    chain: async (/** @type {any} */ meta) => (meta && meta.chain) || owner(),
    proofFrom: () => ({ presence: { n: Math.random() } }),
    vault: Object.freeze({ carryOver: (/** @type {any[]} */ rows) => gs.carryOver("vault", rows), takeBack: (/** @type {any} */ q) => gs.takeBack(q), personalVault: () => gs.personalVault(), grantsOn: (/** @type {string} */ p) => gs.grantsOn(p) }),
    // the same question the kernel's handle answers (kernel/index.js agentMay): the agent acting for the owner
    agentMay: async (/** @type {string} */ agent, /** @type {string} */ action, /** @type {string} */ resource, /** @type {string} */ origin) => {
      if (!AGENT_ACTIONS.includes(action)) return false;
      try { return (await gw.authorize({ chain: assistant(agent), action, resource, ...(origin ? { origin } : {}) })).effect === "allow"; } catch { return false; }
    },
  };
  const ctx = { kernel: K, log: () => {}, call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool !== "agents.uid") return { error: { code: "no_such_tool", message: tool } };
    if (input.uid !== undefined) return { data: { name: Object.keys(agents).find(n => agents[n] === input.uid) || null } };
    return agents[input.name] ? { data: { uid: agents[input.name] } } : { error: { code: "not_found", message: `no agent ${input.name}` } };
  } };
  return { K, ctx, gw, gs, chains, owner, person, assistant, clock, agents, uid: (/** @type {string} */ n) => agents[n] };
}
