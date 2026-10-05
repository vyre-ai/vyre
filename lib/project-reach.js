// @ts-check
// Which agents may reach a Project: a kernel grant, nothing else (the user ruled one permission system). The action is `project.reach` (read risk), the resource is the Project record's URN,
// the subject is the agent. A person holds the action by role; an agent holds it only by a grant of its own, and an agent chain is [owner, agent], so it passes only if both do.
//
// Shared by the projects module (the tools) and the agents module (an agent's `projects` list is kept in step with these grants as part of the person's own, already-proved create or update), because
// a grant is a person's act with a fresh proof and only the person's own call carries one. A module never imports another module's files; both import this.

export const REACH = "project.reach";

/** @param {any} K the module's kernel handle @param {string} name */
export const agentActor = (K, name) => ({ kind: "agent", id: String(name), space: K.space });

/** The caller's own chain and proof, as every module that makes a grant takes them. @param {any} K @param {any} meta */
export async function asPerson(K, meta) { return { chain: await K.chain(meta), proof: K.proofFrom(meta) }; }

/** Give an agent reach to a Project. One grant per (agent, project): an existing live one is returned as it is. @param {any} K @param {any} meta @param {{ urn: string, agent: string }} o */
export async function grantReach(K, meta, { urn, agent }) {
  const { chain, proof } = await asPerson(K, meta);
  const have = (await reachGrants(K, chain, { urn, agent }))[0];
  if (have) return have;
  // an agent holds grants only as a kernel actor of this Space: it is added the first time it is given something, as the same person's act with the same proof
  await ensureAgent(K, meta, agent);
  return K.grants.create(chain, { subject: { kind: "actor", actor: agentActor(K, agent) }, actions: [REACH], resource: { prefix: urn }, source: "projects:reach", reason: "project reach" }, proof);
}

/** The live reach grants, optionally for one project and/or one agent. Needs a chain that may list grants (an owner or admin sees all). @param {any} K @param {any} chain @param {{ urn?: string, agent?: string }} [f] */
export async function reachGrants(K, chain, f = {}) {
  const all = await K.grants.list(chain, {});
  return (Array.isArray(all) ? all : all && all.grants ? all.grants : []).filter((/** @type {any} */ g) => g.status === "active" && Array.isArray(g.actions) && g.actions.includes(REACH)
    && g.subject && g.subject.kind === "actor" && g.subject.actor && g.subject.actor.kind === "agent"
    && (f.urn === undefined || g.resource.prefix === f.urn) && (f.agent === undefined || String(g.subject.actor.id).toLowerCase() === String(f.agent).toLowerCase()));
}

/** Take reach away: every matching grant is revoked (and anything delegated from it goes too). @param {any} K @param {any} meta @param {{ urn?: string, agent?: string }} f */
export async function revokeReach(K, meta, f) {
  const { chain, proof } = await asPerson(K, meta);
  const list = await reachGrants(K, chain, f);
  for (const g of list) await K.grants.revoke(chain, g.id, "project reach taken away", proof);
  return list.length;
}

/** Whether an agent may reach a Project right now, asked of the kernel (the agent's chain never leaves it). @param {any} K @param {string} agent @param {string} urn */
export const mayReach = (K, agent, urn) => K.agentMay(String(agent), REACH, urn);

/** Make the agent a kernel actor of this Space, as the person's own act with the kernel's proof (already one: nothing changes). @param {any} K @param {any} meta @param {string} agent */
export async function ensureAgent(K, meta, agent) {
  const { chain, proof } = await asPerson(K, meta);
  try { await K.grants.addActor(chain, agentActor(K, agent), proof); }
  catch (e) { const c = String(/** @type {any} */ (e).code || ""); if (c !== "conflict" && c !== "exists") throw e; }
}
