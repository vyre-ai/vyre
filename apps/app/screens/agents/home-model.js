// @ts-check
// The pure half of the Agents home: agents.list rows as the list shows them, the groups, and the shape the list header filters. No tool is called here.

/** The three built-in groups a row falls in: [id, title]. A person's own groups come after them. */
export const AGENT_GROUPS = /** @type {[string, string][]} */ ([["yours", "Yours"], ["team", "Your team's agents"], ["shared", "Shared with you"], ["builders", "Builders"]]);

/** One line of role: the agent's description, else its role; never the raw instruction text. At most 90 characters. @param {any} a @param {string} [fallback] */
export function roleLine(a, fallback = "") {
  const one = (/** @type {unknown} */ t) => String(t ?? "").split("\n").map((l) => l.replace(/^[#>\-*\s]+/, "").replace(/\*\*|__|`/g, "").trim()).find(Boolean) ?? "";
  return (one(a?.description) || one(a?.role) || fallback).slice(0, 90);
}

/** @param {any} a */
export const statusOf = (a) => (a.status === "stopped" ? "Paused" : a.status === "running" || a.doing ? "Running now" : "Idle");

/** Builders are the built-in agents; mine are the assistant and what I made (made_by) or a personal agent; shared with me when its shares name me; the rest are the team's. @param {any} a @param {string} [me] */
export function groupOf(a, me) {
  if (a.builtin) return "builders";
  if (a.kind === "assistant" || a.personal || (me && a.made_by === me)) return "yours";
  if (me && Array.isArray(a.shares) && a.shares.some((/** @type {any} */ s) => s?.person === me)) return "shared";
  return "team";
}

/** What I may do with an agent shared with me ("Can use", "Can edit") and how many it is shared with (only an editor is told all of them). @param {any} a @param {string} [me] */
export function sharingOf(a, me) {
  const sh = Array.isArray(a.shares) ? a.shares : [];
  const mine = sh.find((/** @type {any} */ s) => me && s?.person === me);
  return { mine: mine ? (mine.level === "edit" ? "Can edit" : "Can use") : "", count: sh.length };
}

const worksLine = (/** @type {unknown} */ projects, /** @type {Record<string, string>} */ names = {}) => {
  if (projects === "*") return "Works on every project";
  const n = Array.isArray(projects) ? projects.length : 0;
  if (n === 1 || n === 2) return `Works on ${/** @type {unknown[]} */ (projects).map((x) => names[String(x)] || String(x)).join(" and ")}`;
  return n ? `Works on ${n} projects` : "No projects yet";
};

/** One agents.list row as the list shows it. @param {any} a @param {string} [me] @param {Record<string, string>} [names] project names by id */
export function agentRow(a, me, names = {}) {
  const sharing = sharingOf(a, me);
  return {
    name: String(a.name), kind: String(a.kind ?? "agent"), maker: a.made_by ? String(a.made_by) : "", role: roleLine(a, a.kind === "assistant" ? "Your assistant" : a.builtin ? "Builds your Space by conversation" : "Agent"),
    model: a.model ? String(a.model) : "Default model", works: worksLine(a.projects, names), status: statusOf(a), group: groupOf(a, me), mine: sharing.mine, sharedWith: sharing.count, canPause: !!a.thread, builtin: !!a.builtin,
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

/** The titles of the groups the list works out for a person (facts, not folders): nobody moves an agent into them. */
export const COMPUTED_TITLES = AGENT_GROUPS.map(([, t]) => t);

/**
 * The agents this person sees: every agent, but only their own Assistant (another person's never appears), the Assistant first.
 * @param {ReturnType<typeof agentRow>[]} rows @param {string} [me]
 */
export function visibleAgents(rows, me) {
  const mine = rows.filter((r) => r.kind !== "assistant" || !r.maker || !me || r.maker === me);
  return [...mine.filter((r) => r.kind === "assistant"), ...mine.filter((r) => r.kind !== "assistant")];
}

/**
 * What a row's menu offers, in order, as { key, label } (key "move" carries `to`). Only what makes sense for this row and this person.
 * The Assistant has one chat and its settings; no sharing, deleting or moving. Pause and Resume only when the agent can pause. Share and Delete are for the maker, an owner or an admin; the built-in agents are not deleted.
 * @param {ReturnType<typeof agentRow>} r
 * @param {{ me?: string, staff?: boolean, chats?: number, groups?: string[], placed?: string, canDelete?: boolean }} o
 * @returns {{ key: string, label: string, to?: string }[]}
 */
export function rowActions(r, o = {}) {
  if (r.kind === "assistant") return [{ key: "chat", label: "Open chat" }, { key: "open", label: "Settings" }];
  const may = !!o.staff || (!!o.me && r.maker === o.me);
  /** @type {{ key: string, label: string, to?: string }[]} */
  const out = [{ key: "open", label: "Open" }, { key: "new-chat", label: "New chat" }];
  if (o.chats) out.push({ key: "chats", label: o.chats === 1 ? "Chat with it" : `Chats with it (${o.chats})` });
  if (r.canPause) out.push({ key: "pause", label: r.status === "Paused" ? "Resume" : "Pause" });
  if (may && !r.builtin) out.push({ key: "share", label: "Share" });
  if (may && !r.builtin && o.canDelete !== false) out.push({ key: "delete", label: "Delete" });
  const mine = (o.groups ?? []).filter((g) => !COMPUTED_TITLES.includes(g) && g !== o.placed);
  for (const g of mine.slice(0, 6)) out.push({ key: "move", label: `Move to ${g}`, to: g });
  return out;
}

/** Whether a chat row has this agent in it. @param {{ agents?: string[], pinned?: string }} c @param {string} name */
export const chatHas = (c, name) => c.pinned !== "assistant" && (c.agents ?? []).some((a) => a === name);
