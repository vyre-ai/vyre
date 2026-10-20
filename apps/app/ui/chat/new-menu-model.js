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

/**
 * The agents the New menu offers, from the chat list's rows: every row that is one agent (your assistant's own chat, an agent's threads, an agent with no chat yet), by the name a person reads,
 * your assistant first and said as yours. Never a second row for the same agent.
 * @param {readonly { id: string, title: string, lone: string, section: string, agent?: string, names?: readonly string[] }[]} convos @returns {{ id: string, name: string, role?: string }[]}
 */
export function newMenuAgents(convos) {
  const seen = new Set();
  /** @type {{ id: string, name: string, role?: string }[]} */ const out = [];
  for (const c of convos) {
    if (c.lone !== "agent") continue;
    const key = String(c.agent || (c.names && c.names[0]) || c.title).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ id: c.id, name: c.title, ...(c.section === "pinned" ? { role: "Your assistant" } : {}) });
  }
  return out.sort((a, b) => Number(!!b.role) - Number(!!a.role));
}
