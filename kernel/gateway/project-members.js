// @ts-check
// Who belongs to a project, for the guard on a project's own files (kernel/core/folders.js). An adapter, not the trusted base: it reads the Project record and its team-member rows as the work
// module's service chain (a Space with no work module has no members: fail closed). A person is a member when they are the Project's owner or have a team-member row of kind person. A teammate
// (an agent with a team-member row) opens the files only while a task of its own in this project is ready or working; the person's default assistant opens them for a member and needs nothing more.

const WORKING = ["ready", "working"];

/** @param {{ space: string, chains: any, records: () => any, tasks?: any }} o */
export function projectOracle({ space, chains, records, tasks }) {
  const svc = () => chains.fromFacts({ kind: "module", module: "work", first_party: true });
  const idOf = (/** @type {any} */ a) => (a && a.actor && a.actor.id) || (a && a.id) || null;
  /** @param {string} project the Project record's id */
  async function team(project) {
    const r = records();
    if (!r) return null;
    try {
      const rec = await r.get(svc(), "project", project);
      const rows = (await r.query(svc(), "team-member", { filter: { field: "project", op: "eq", value: { urn: `vyre://${space}/project/${project}` } }, page: { limit: 500 } })).rows;
      return { owner: rec && idOf(rec.data.owner), rows: rows.map((/** @type {any} */ x) => ({ kind: x.data.actor && x.data.actor.actor ? x.data.actor.actor.kind : null, id: idOf(x.data.actor) })) };
    } catch { return null; }
  }
  return Object.freeze({
    /** @param {string} person @param {string} project */
    async member(person, project) { const t = await team(project); return Boolean(t && (t.owner === person || t.rows.some((/** @type {any} */ x) => x.kind === "person" && x.id === person))); },
    /** May this agent open the project's files for a member: the default assistant always, a teammate only while it has a task here. @param {string} agent @param {string} project */
    async agent(agent, project) {
      if (agent === "assistant") return true;
      const t = await team(project);
      if (!t || !t.rows.some((/** @type {any} */ x) => x.kind === "agent" && x.id === agent) || !tasks) return false;
      try { return (await tasks.list(svc(), { doer: agent, state: WORKING })).some((/** @type {any} */ x) => String(x.project || "").endsWith(`/${project}`) || x.project === project); } catch { return false; }
    },
  });
}
