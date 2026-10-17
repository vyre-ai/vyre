// @ts-check
// spaces.members.add-agent: an agent (an assistant that does work in the space) joins a space as a kernel actor, owners and admins only, under the person's proof. Split out of index.js with the groups
// tools so the module stays inside its file-size record; the handler is the one index.js had, with the module's own helpers handed in.

/** @param { tool: Function, spaceOf: (s: any) => any, gate: Function, kernelHandle: (id: string) => any, kctxOf: Function, refuse: (m: string, c: string) => Error, obj: Function, str: any } d */
export function registerAddAgent({ tool, spaceOf, gate, kernelHandle, kctxOf, refuse, obj, str }) {
  tool("spaces.members.add-agent", "Add an agent (an assistant that does work in the space, for example as the doer of a task) to a space. The kernel's own actor membership: owners and admins only, under the person's proof.",
    obj({ space: str, agent: str }, ["space", "agent"]),
    async (i, meta) => {
      const row = spaceOf(i.space);
      await gate(row.id, undefined, meta);
      const agent = String(i.agent || "").trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(agent)) throw refuse("An agent's name is letters, digits, - and _, up to 40.", "bad_input");
      const h = kernelHandle(row.id);
      if (!h || !h.gateway || !h.gateway.grants || typeof h.gateway.grants.addActor !== "function") throw refuse("This space has no kernel here to add an agent to.", "unavailable");
      const k = await kctxOf(meta, row.id);
      try { await h.gateway.grants.addActor(k.chain, { kind: "agent", id: agent, space: row.id }, k.proof); }
      catch (e) {
        const c = String(/** @type {any} */ (e).code || "");
        if (c === "needs_presence") throw refuse("This change needs your approval on your device.", "needs_presence");
        if (c === "not_allowed") throw refuse("Only an owner or an admin can add an agent.", "forbidden");
        throw e;
      }
      return { space: row.id, agent: { kind: "agent", id: agent } };
    }, { presence: { summary: (/** @type {any} */ i) => `Add the agent ${i && i.agent} to ${i && i.space}` } });
}
