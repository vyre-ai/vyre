// @ts-check
// spaces.groups.*: the groups of a space (named sets of people and agents), over the kernel's teams. Split out of index.js so the module stays inside its file-size record; the handlers are the ones
// index.js had, with the module's own helpers handed in.

/** @param { tool: Function, spaceOf: (s: any) => any, gate: Function, kernelHandle: (id: string) => any, kctxOf: Function, refuse: (m: string, c: string) => Error, obj: Function, str: any } d */
export function registerGroups({ tool, spaceOf, gate, kernelHandle, kctxOf, refuse, obj, str }) {
  // Groups: named sets of people and agents of a space, for sharing (a vault, a Flow, later a chat or a project) with several at once. The kernel's teams (grants.teams); a group is the same thing in the
  // product's words. Owners and admins make, change and remove them under the person's proof; everyone else sees only the groups they are in. An agent in a group holds `use` and nothing more.
  const groupsOf = async (/** @type {any} */ i, /** @type {any} */ meta) => {
    const row = spaceOf(i.space);
    await gate(row.id, undefined, meta);
    const h = kernelHandle(row.id);
    if (!h || !h.gateway || !h.gateway.grants || !h.gateway.grants.teams) throw refuse("This space has no kernel here to keep groups in.", "unavailable");
    return { row, teams: h.gateway.grants.teams, k: await kctxOf(meta, row.id) };
  };
  const shapeGroup = (/** @type {any} */ t) => ({ id: String(t.id), name: String(t.name), people: [...t.members], agents: [...(t.agents || [])] });
  const kernelWords = (/** @type {any} */ e) => {
    const c = String(/** @type {any} */ (e).code || "");
    if (c === "needs_presence") return refuse("This change needs your approval on your device.", "needs_presence");
    if (c === "not_allowed") return refuse("Only an owner or an admin can make or change a group.", "forbidden");
    if (c === "exists") return refuse("A group with that name already exists: choose another name, or change that group by its id.", "exists");
    if (c === "not_found") return refuse("There is no such group: check the id against the space's groups, or ask an owner or an admin.", "not_found");
    if (c === "bad_input") return refuse(String(/** @type {any} */ (e).message || "That is not a valid group."), "bad_input");
    return e;
  };
  tool("spaces.groups.list", "The groups of a space: a name, the people and the agents in each. Owners and admins see all of them, everyone else only the groups they are in.",
    obj({ space: str }, ["space"]), async (i, meta) => {
      const { teams, k } = await groupsOf(i, meta);
      try { return { groups: (await teams.list(k.chain)).map(shapeGroup) }; } catch (e) { throw kernelWords(e); }
    });
  tool("spaces.groups.set", "Make a group, or change one (rename it, change its people and agents). Owners and admins only, under the person's proof. An agent in a group can use what the group is given and never see a value or change one.",
    obj({ space: str, id: str, name: str, people: { type: "array", items: str, description: "person ids" }, agents: { type: "array", items: str, description: "agent ids (the stable id from spaces.members.list, never a name or a label)" } }, ["space"]), async (i, meta) => {
      const { teams, k } = await groupsOf(i, meta);
      try {
        const t = await teams.set(k.chain, { ...(i.id !== undefined ? { id: String(i.id) } : {}), ...(i.name !== undefined ? { name: String(i.name) } : {}), ...(i.people !== undefined ? { members: i.people } : {}), ...(i.agents !== undefined ? { agents: i.agents } : {}) }, k.proof);
        return { group: shapeGroup(t) };
      } catch (e) { throw kernelWords(e); }
    }, { presence: { summary: (/** @type {any} */ i) => `${i && i.id ? "Change" : "Make"} the group ${(i && i.name) || ""}`.trim() } });
  tool("spaces.groups.remove", "Remove a group. What was shared with it stays on record and reaches no one. Owners and admins only, under the person's proof.",
    obj({ space: str, id: str }, ["space", "id"]), async (i, meta) => {
      const { teams, k } = await groupsOf(i, meta);
      try { return await teams.remove(k.chain, String(i.id), k.proof); } catch (e) { throw kernelWords(e); }
    }, { presence: { summary: (/** @type {any} */ i) => `Remove the group ${(i && i.id) || ""}`.trim() } });
}
