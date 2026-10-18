// @ts-check
// The New menu (the compose button, Cmd N): a compact popover with a To: field, the agents (each starts a new thread), the people, then New group, New agent and New Flow. Pure: what to show for what was typed.

/** @typedef {{ kind: "agent" | "person" | "group" | "new-agent" | "flow", id: string, label: string, sub?: string }} NewRow */

/**
 * The rows for a typed word: agents and people whose name starts with or contains it (best first), then the three "New ..." rows, which stay while nothing is typed and drop out once a name is being looked for.
 * @param {string} query @param {readonly { name: string, role?: string, id?: string }[]} agents @param {readonly { id: string, name: string, role?: string }[]} people
 * @returns {{ agents: NewRow[], people: NewRow[], make: NewRow[] }}
 */
export function newMenuRows(query, agents, people) {
  const q = String(query ?? "").trim().toLowerCase();
  const rank = (/** @type {string} */ name) => { const n = name.toLowerCase(); return !q || n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
  const pick = (/** @type {NewRow[]} */ rows) => rows.map((r, i) => ({ r, i, t: rank(r.label) })).filter((x) => x.t < 2).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.r);
  return {
    agents: pick(agents.map((a) => ({ kind: /** @type {const} */ ("agent"), id: a.id ?? a.name, label: a.name, ...(a.role ? { sub: a.role } : {}) }))),
    people: pick(people.map((p) => ({ kind: /** @type {const} */ ("person"), id: p.id, label: p.name, ...(p.role ? { sub: p.role } : {}) }))),
    make: q ? [] : [
      { kind: "group", id: "group", label: "New group" },
      { kind: "new-agent", id: "agent", label: "New agent" },
      { kind: "flow", id: "flow", label: "New Flow" },
    ],
  };
}

/** The first row Enter picks. @param {ReturnType<typeof newMenuRows>} r @returns {NewRow | null} */
export const firstRow = (r) => r.agents[0] ?? r.people[0] ?? r.make[0] ?? null;
