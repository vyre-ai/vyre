// @ts-check
// core/vault/kernel-rig.js: a real kernel (the grants store and the authorizer, kernel/grants and kernel/gateway) behind the handle the vault module gets as `ctx.kernel`, for tests of who may use a
// login or a vault. Presence is permissive (the vault's own tests cover proofs); everything else is the kernel's own code. The vault's two fakes: `ctx.call` answers `agents.uid` for the agents named
// in `agents`, and `chain(meta)` is the owner unless a test hands in `meta.chain`.

import { createGateway } from "../../kernel/gateway/index.js";
import { createGrantsStore } from "../../kernel/grants/index.js";
import { createMemoryStore } from "../../kernel/store/memory.js";
import { createEventLog } from "../../kernel/core/events.js";
import { createChainBuilder } from "../../kernel/core/chain.js";
import { AGENT_ACTIONS, ACCESS_LEVELS } from "../../kernel/seal/uses.js";

export const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";

/** `taskOpen` (default: every task is open; false: not wired) is the kernel's answer to whether a task is still open (kernel/tasks taskOpen): a lease or lend sourced from a task ends with it. @param {{ taskOpen?: false | ((id: string) => boolean | Promise<boolean>), clock?: () => number, agents?: Record<string, string>, people?: string[], projects?: Record<string, string>, call?: (tool: string, input: any) => Promise<any> | any }} [o] */
export async function kernelRig(o = {}) {
  let T = Date.now();
  const clock = o.clock || (() => ++T);
  const agents = o.agents || { kit: "agt_kit", juno: "agt_juno" };
  const projects = o.projects || {};
  const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
  const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
  const person = (/** @type {string} */ who) => chains.fromFacts({ kind: "device", device_key_id: `d-${who}`, person: who, path: "direct" });
  /** An agent acting for a person, as the kernel builds it for a session. */
  const assistant = (/** @type {string} */ uid, who = OWNER, thread = "t") => chains.fromFacts({ kind: "agent_session", agent: uid, session: "s", thread, vouched: true, person: who });
  const presence = { check: async () => null };
  const log = createEventLog({ space: SPACE, clock });
  const gs = createGrantsStore({ space: SPACE, log, chains, clock, key: Buffer.alloc(32, 5), presence });
  const gw = createGateway({ space: SPACE, store: createMemoryStore({ clock }), log, chains, clock, grantsStore: gs, presence, owner: OWNER, hasPresenceSession: () => true, ...(o.taskOpen === false ? {} : { taskOpen: o.taskOpen || (() => true) }), approverHolds: (/** @type {string} */ p, /** @type {string} */ a, /** @type {string} */ r) => K.vault.personMay(p, a, r) });
  await gs.bootstrap({ owner: OWNER });
  // the vault module's right to make grants for others, as its manifest declares it (core/vault/module.json needs.kernel.mints)
  await gs.installModule("vault", { actions: [], mints: [{ prefix: "vault", actions: ["vault.fill", "vault.totp", "vault.read", "vault.call", "vault.reveal", "vault.edit", "vault.rotate"] }] });
  // The Space's agents are registered actors (an unregistered hop is not a member of the Space and the authorizer refuses it before any grant is read)
  for (const uid of Object.values(agents)) await gw.grants.addActor(owner(), { kind: "agent", id: uid, space: SPACE }, { presence: { n: Math.random() } });
  // The owner holds their personal vault whole (not a member's connection items, which sit under the member): an owner holds nothing of a vault by being the owner, it is the manage grant that making a vault gives its maker (kernel/grants vaults.create)
  if (o.ownerVault !== false) await gw.grants.create(owner(), { subject: { kind: "actor", actor: { kind: "person", id: OWNER, space: SPACE } }, actions: [...ACCESS_LEVELS.manage], resource: { prefix: `vyre://${SPACE}/vault/${await gs.personalVault()}/*` }, conditions: {}, source: "vault:owner" }, { presence: { n: Math.random() } });
  for (const who of o.people || []) await gw.grants.setRole(owner(), { person: who, role: "member" }, { presence: { n: Math.random() } });
  const K = {
    space: SPACE, owner: OWNER, grants: gw.grants, authorize: gw.authorize,
    chain: async (/** @type {any} */ meta) => (meta && meta.chain) || owner(),
    mint: Object.freeze({ make: (/** @type {any} */ i) => gs.mint("vault", i), end: (/** @type {any} */ q) => gs.unmint("vault", q), list: async (/** @type {any} */ q) => gs.minted("vault", String((q && q.source) || "")) }),
    proofFrom: () => ({ presence: { n: Math.random() } }),
    vault: Object.freeze({ carryOver: (/** @type {any[]} */ rows) => gs.carryOver("vault", rows), takeBack: (/** @type {any} */ q) => gs.takeBack(q), personalVault: () => gs.personalVault(), grantsOn: (/** @type {string} */ p) => gs.grantsOn(p),
      // Mirror kernel/index.js vault.personMay (owner role only; no extra test-only shortcuts).
      personMay: async (/** @type {string} */ person, /** @type {string} */ action, /** @type {string} */ resource) => {
        if (gs.roleOf({ kind: "person", id: person, space: SPACE }) === "owner") return true;
        try { return await gw.authorize({ chain: chains.fromFacts({ kind: "device", device_key_id: "lend-check", person, path: "direct", session: "lend-check" }), action, resource }).then(r => r.effect === "allow" || (action === "vault.call" && r.effect === "ask" && r.reason === "needs_approval")); } catch { return false; }   // as lib/credential-held.js
      } }),
    // the same question the kernel's handle answers (kernel/index.js agentMay): the agent acting for the owner
    agentMay: async (/** @type {string} */ agent, /** @type {string} */ action, /** @type {string} */ resource, /** @type {string} */ origin, /** @type {boolean} */ full, /** @type {string} */ thread, /** @type {string} */ person) => {
      if (!AGENT_ACTIONS.includes(action)) return false;
      try { const who = person === undefined ? OWNER : (typeof person === "string" && person !== OWNER && /^per_[A-Za-z0-9_-]{1,64}$/.test(person) && gs.roleOf({ kind: "person", id: person, space: SPACE }) ? person : null); if (who === null) return false; const e = (await gw.authorize({ chain: assistant(agent, who, thread || "t"), action, resource, ...(origin ? { origin } : {}) })).effect; return full ? e : e === "allow"; } catch { return false; }
    },
  };
  const ctx = { kernel: K, log: () => {}, call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (o.call) { const r = await o.call(tool, input); if (r !== undefined) return r; }
    if (tool === "connectors.connection.get") return { data: { id: input.id } };   // a lease names Connections that exist: the rig has them all
    if (tool === "agents.list") return { data: Object.entries(agents).map(([name, uid]) => ({ uid, name, kind: name === "assistant" ? "assistant" : "agent" })) };
    if (tool === "projects.record") return projects[input.project] ? { data: { urn: `vyre://${SPACE}/project/${projects[input.project]}` } } : { error: { code: "not_found", message: "no project" } };
    if (tool !== "agents.uid") return { error: { code: "no_such_tool", message: tool } };
    if (input.uid !== undefined) return { data: { name: Object.keys(agents).find(n => agents[n] === input.uid) || null } };
    return agents[input.name] ? { data: { uid: agents[input.name] } } : { error: { code: "not_found", message: `no agent ${input.name}` } };
  } };
  return { K, ctx, gw, gs, chains, owner, person, assistant, clock, agents, uid: (/** @type {string} */ n) => agents[n] };
}
