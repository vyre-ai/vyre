// @ts-check
// The pure half of the Agents home: agents.list rows as the list shows them, the groups, and the shape the list header filters. No tool is called here.

/** The three built-in groups a row falls in: [id, title]. A person's own groups come after them. */
export const AGENT_GROUPS = /** @type {[string, string][]} */ ([["yours", "Yours"], ["team", "Your team's agents"], ["builders", "Builders"]]);

/** One line of role: the first line of the instructions with the markup taken off, at most 90 characters. @param {string | null | undefined} instructions @param {string} [fallback] */
export function roleLine(instructions, fallback = "") {
  const first = String(instructions ?? "").split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/\*\*|__|`/g, "").trim()).find(Boolean);
  return (first || fallback).slice(0, 90);
}

/** @param {any} a */
export const statusOf = (a) => (a.status === "stopped" ? "Paused" : a.status === "running" || a.doing ? "Running now" : "Idle");

/** @param {any} a */
export function groupOf(a) {
  if (a.builtin) return "builders";
  return a.kind === "assistant" || a.personal ? "yours" : "team";
}

const worksLine = (/** @type {unknown} */ projects) => {
  if (projects === "*") return "Works on every project";
  const n = Array.isArray(projects) ? projects.length : 0;
  if (n === 1 || n === 2) return `Works on ${/** @type {unknown[]} */ (projects).map(String).join(" and ")}`;
  return n ? `Works on ${n} projects` : "No projects yet";
};

/** One agents.list row as the list shows it. @param {any} a */
export function agentRow(a) {
  return {
    name: String(a.name), kind: String(a.kind ?? "agent"), role: roleLine(a.instructions, a.kind === "assistant" ? "Your assistant" : a.builtin ? "Builds your Space by conversation" : "Agent"),
    model: a.model ? String(a.model) : "Default model", works: worksLine(a.projects), status: statusOf(a), group: groupOf(a), canPause: !!a.thread, builtin: !!a.builtin,
    ...(a.autonomy ? { autonomy: String(a.autonomy) } : {}), ...(a.effort ? { effort: String(a.effort) } : {}),
  };
}

/** The agents as a record type the list header can filter and search (kind, model, status, where it works). @param {ReturnType<typeof agentRow>[]} rows */
export function agentsDef(rows) {
  const uniq = (/** @type {string[]} */ xs) => [...new Set(xs)];
  return {
    name: "agent", label: "Agent", plural: "Agents",
    fields: [
      { name: "name", label: "Name", kind: "text" },
      { name: "role", label: "Role", kind: "text" },
      { name: "kind", label: "Kind", kind: "choice", options: uniq(rows.map((r) => r.kind)) },
      { name: "model", label: "Model", kind: "choice", options: uniq(rows.map((r) => r.model)) },
      { name: "status", label: "Status", kind: "choice", options: ["Running now", "Idle", "Paused"] },
      { name: "works", label: "Works on", kind: "text" },
    ],
  };
}

/** @param {ReturnType<typeof agentRow>[]} rows */
export const asRecords = (rows) => rows.map((r) => ({ id: r.name, data: { name: r.name, role: r.role, kind: r.kind, model: r.model, status: r.status, works: r.works } }));

const KEY = "vyre.agents.groups";
/** A person's own groups of agents, kept on this device (a per-viewer convenience: nothing on the server holds them). @param {{ getItem(k: string): string | null }} store @returns {{ groups: { name: string, collapsed?: boolean }[], placed: Record<string, string> }} */
export function loadGroups(store) {
  try {
    const j = JSON.parse(store.getItem(KEY) ?? "null");
    if (j && Array.isArray(j.groups) && j.placed && typeof j.placed === "object") return { groups: j.groups.filter((/** @type {any} */ g) => g && typeof g.name === "string"), placed: j.placed };
  } catch { /* an unreadable store is no groups */ }
  return { groups: [], placed: {} };
}
/** @param {{ setItem(k: string, v: string): void }} store @param {{ groups: unknown[], placed: Record<string, string> }} v */
export function saveGroups(store, v) {
  try { store.setItem(KEY, JSON.stringify(v)); } catch { /* the device may refuse; the groups then last for this visit only */ }
}
