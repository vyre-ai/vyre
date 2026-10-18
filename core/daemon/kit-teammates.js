// @ts-check
// A Kit's assistants (its `teammates` part): the port the Kit manager (kernel/flows/kits.js) uses to make an assistant when a Kit is installed and to remove it when the Kit is removed. Each call runs AS THE PERSON
// who approved the install or the removal, on that person's own short session, through the agents module's own tools (agents.create, agents.update for the tag, agents.delete): the checks are the ones that
// person would meet doing it by hand. The person comes only from `by`, which the Kit manager sets from the approval; it is never read from the Kit and never guessed from a chain. No `by`, no call.

/**
 * @param {{ callAs: (tool: string, input: any, token: string) => Promise<any>, session: (person: string) => Promise<string>, log?: (m: string) => void, space?: string }} o
 */
export function teammatePort({ callAs, session, log = () => {}, space = "" }) {
  const denied = (/** @type {string} */ what) => Object.assign(new Error(`${what} runs as the person who approved it: this change carries none`), { code: "denied" });
  /** @param {any} by @param {string} what */
  const tokenFor = async (by, what) => {
    if (!by || by.kind !== "person" || typeof by.id !== "string" || !by.id) throw denied(what);
    return session(by.id);
  };
  return {
    /** @param {any} _chain @param {{ name: string, instructions?: string, kit?: string, by?: any }} t */
    create: async (_chain, t) => {
      const token = await tokenFor(t && t.by, "Installing a Kit's assistants");
      const have = await callAs("agents.list", {}, token);
      const list = have && !have.error && have.data ? (Array.isArray(have.data) ? have.data : have.data.agents || []) : [];
      if (list.some((/** @type {any} */ a) => a && a.name === t.name)) { log(`flows ${space}: Kit ${t.kit} names an assistant ${t.name} that is already here; it is left as it is`); return { id: null, existed: true }; }
      const r = await callAs("agents.create", { name: t.name, instructions: String(t.instructions || ""), projects: [] }, token);
      if (r && r.error) throw Object.assign(new Error(`the Kit's assistant ${t.name} could not be made: ${r.error.message}`), { code: r.error.code || "failed" });
      // where it came from, in its visible tags (never in its instructions); a refusal here does not undo the assistant
      if (t.kit) { const tag = await callAs("agents.update", { agent: t.name, tags: [`kit-${String(t.kit).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)}`] }, token).catch(() => null); if (tag && tag.error) log(`flows ${space}: the assistant ${t.name} was made but not tagged with its Kit: ${tag.error.message}`); }
      log(`flows ${space}: Kit ${t.kit} made the assistant ${t.name} with the Kit's instructions as written, as the person who approved it`);
      return { id: r && r.data && (r.data.id || r.data.uid) ? String(r.data.id || r.data.uid) : null };
    },
    /** @param {any} _chain @param {string} name @param {string | undefined} id @param {any} by */
    remove: async (_chain, name, id, by) => {
      const token = await tokenFor(by, "Removing a Kit's assistants");
      const r = await callAs("agents.delete", { agent: name, ...(id ? { id } : {}) }, token);
      if (r && r.error && r.error.code !== "not_found") throw Object.assign(new Error(`the Kit's assistant ${name} was not removed: ${r.error.message}`), { code: r.error.code || "failed" });
    },
  };
}
