// @ts-check
// The REAL kernel for module tests: `createKernel` (gateway, grants store, tasks, room, rule evaluator, event log, in-memory store), nothing assembled by hand and no
// internals of a fake to poke. People get roles through `grants.setRole` and agents through `grants.addActor` and `grants.create`, each with a presence proof the way
// kernel/chats.test.js does it. What is still a stand-in is labelled SHIM here and counted in docs/work/assistant.md:
//   SHIM(model): kernel.model is the test's scripted provider (the real door needs a provider and the sealing process; a model provider stand-in is allowed).
//   SHIM(presence): the presence verifier accepts a proof built for exactly this operation (a headless test has no hardware signer).
// Tests only.
import { createKernel } from "../kernel/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";

const SPACE = "spc_aaaaaaaaaaaa";
let n = 0;

/**
 * @param {{ space?: string, owner?: string, people?: Record<string, "admin"|"manager"|"member">, agents?: string[], defs?: any[], clock?: () => number }} [o]
 *   people: person id (`per_...`) to role. The owner is always there and is an owner.
 */
export async function createRig({ space = SPACE, owner = "per_alex", people = {}, agents = [], defs = [], clock } = {}) {
  const used = new Set();
  // SHIM(presence)
  const presence = { check: async (/** @type {any} */ { chain, op, fields, proof }) => (chain && proof && proof.op === op && canonical(proof.fields) === canonical(fields) && !used.has(proof.n) && (used.add(proof.n), true) ? null : "wrong_proof") };
  const k = await createKernel({ space, owner, owner_uid: 501, key: Buffer.alloc(32, 9), presence, ...(clock ? { clock } : {}) });
  const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: ++n + Math.random() });
  const ownerChain = k.chains.fromFacts({ kind: "device", device_key_id: `d-${owner}`, person: owner, path: "direct", session: "s" });
  const G = k.gateway.grants;
  const actor = (/** @type {string} */ kind, /** @type {string} */ id) => ({ kind, id, space });
  for (const [p, role] of Object.entries(people)) { const r = { person: p, role }; await G.setRole(ownerChain, r, { presence: proof("grants.role", r, `vyre://${space}/member/${p}`) }); }
  for (const a of agents) { const x = actor("agent", a); await G.addActor(ownerChain, x, { presence: proof("grants.role", { actor: x }, `vyre://${space}/member/${a}`) }); }
  if (defs.length) await k.gateway.records.define(ownerChain, { add_types: defs });

  /** A person's own chain (a device). */
  const person = (/** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: `d-${id}`, person: id, path: "direct", session: "s" });
  /** An assistant acting for a person. */
  const assistant = (/** @type {string} */ id, /** @type {string} */ agent, session = "sess") => k.chains.fromFacts({ kind: "agent_session", vouched: true, person: id, agent, session });
  /** The memory service beside a person (what a fact is written under). */
  const withService = (/** @type {any} */ chain, /** @type {string} */ name) => k.chains.appendService(chain, name, true);
  /** An admin gives an actor access: the real grants store, with a presence proof. */
  async function grantTo(/** @type {any} */ subject, /** @type {string[]} */ actions, prefix = `vyre://${space}/*/*`, extra = {}) {
    const input = { subject: { kind: "actor", actor: subject }, actions, resource: { prefix, ...(/** @type {any} */ (extra).fields ? { fields: /** @type {any} */ (extra).fields } : {}) }, conditions: /** @type {any} */ (extra).conditions || {}, source: /** @type {any} */ (extra).source || "test" };
    return G.create(ownerChain, input, { presence: proof("grants.create", input, `vyre://${space}/grant/new`) });
  }
  /**
   * The room a turn answers in, from the REAL chats and sessions: `asker` opens a chat with `others`, a session is opened for it, and the kernel's own `audienceFor` gives
   * the handle (`{ group, read, canRead }`, no chains). A chat of one person is `{ group: false }`.
   * @param {string} asker @param {string[]} [others] @param {string[]} [assistants]
   */
  async function room(asker, others = [], assistants = []) {
    const c = await G.chats.create(person(asker), { people: others, assistants });
    const t = await k.surfaces.open(person(asker), { chat: c.id });
    k.bindCalls(() => ({ token: t.token }));
    const h = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
    return h.audienceFor({});
  }
  /** The owner's (or any person's) hardware approval of a task waiting for a check, over the payload the kernel stored and the decision it bound. SHIM(presence): the rig's verifier accepts exactly this. */
  async function taskProof(/** @type {any} */ chain, /** @type {string} */ id) {
    const t = await gw0().ask.get(chain, id);
    return { op: "task.decide", fields: { task: id, payload_hash: t.payload.payload_hash, decision: t.payload.decision }, n: ++n + Math.random() };
  }
  const gw0 = () => k.gateway;
  /** A person's role grants cut down by the owner (the real `grants.narrow`): fewer actions, a deeper prefix, a smaller field list. Never wider. */
  async function restrict(/** @type {string} */ personId, /** @type {{ actions?: string[], prefix?: string, fields?: string[] }} */ patch) {
    const mine = await G.list(ownerChain, { subject: { kind: "actor", actor: actor("person", personId) }, status: "active" });
    for (const g of mine) { const input = { id: g.id, patch }; await G.narrow(ownerChain, g.id, patch, { presence: proof("grants.narrow", input, `vyre://${space}/grant/${g.id}`) }); }
  }
  /** A temporary member limited to named records, until `expires`. */
  async function addTemp(/** @type {string} */ personId, /** @type {string[]} */ scope, expires = Date.now() + 3600_000) {
    const r = { person: personId, role: "temp", scope, expires }; await G.setRole(ownerChain, r, { presence: proof("grants.role", r, `vyre://${space}/member/${personId}`) });
  }
  /** SHIM(model): a scripted provider. */
  /** @type {(call: any) => any} */ let script = () => ({ content: "" });
  /** @type {any[]} */ const modelCalls = [];
  const model = { call: async (/** @type {any} */ input) => { modelCalls.push(input); return { id: `m${modelCalls.length}`, provider: "stand-in", model: "stand-in", content: "", ...(await script(input)) }; } };
  const gw = k.gateway;
  /** The port the work modules take: the real gateway's calls, plus the one stand-in. */
  const kernel = { space, authorize: gw.authorize, records: gw.records, events: gw.events, ask: gw.ask, tasks: gw.tasks, grants: gw.grants, members: gw.members, definitions: gw.definitions, actions: gw.actions, serviceChain: gw.serviceChain, model };
  return {
    k, kernel, space, owner, ownerChain, room, person, assistant, withService, grantTo, restrict, addTemp, taskProof, actor, proof, modelCalls,
    /** SHIM(model): what the provider answers, as a function of the call. */
    script: (/** @type {(call: any) => any} */ fn) => { script = fn; },
    /** Make a record as the owner. */
    create: (/** @type {string} */ type, /** @type {any} */ data) => gw.records.create(ownerChain, type, data),
    define: (/** @type {any} */ d) => gw.records.define(ownerChain, { add_types: [d] }),
  };
}
