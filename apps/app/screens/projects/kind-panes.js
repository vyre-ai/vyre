// @ts-check
// The parts of a project page that depend on how it runs, pure: the extra tabs of each kind, the mail search for a client's Emails tab, the columns of an Ongoing board, and the Flows a project's stages turn on.
// Tested by kind-panes.test.js. The drawing is in KindPanes.tsx.

/** The tabs a kind adds after Chats. Stages keeps its stage track in About; Simple adds none. @param {any} data a project's fields @returns {("client" | "emails" | "board" | "flows")[]} */
export function kindTabs(data) {
  if (data && data.personal_of) return [];
  if (data && data.kind === "client") return ["client", "emails"];
  if (data && data.kind === "ongoing") return ["board", "flows"];
  return [];
}

/** The mail search for the emails to and from a client: their addresses only. Null when the client has none (the tab then says so). @param {any} client a contact's fields */
export function emailQuery(client) {
  const list = [client && client.email, ...(Array.isArray(client && client.emails) ? client.emails : [])].map((x) => (typeof x === "string" ? x : x && x.value)).filter((x) => typeof x === "string" && /^[^\s@]+@[^\s@]+$/.test(x));
  const uniq = [...new Set(list.map((x) => x.toLowerCase()))].slice(0, 5);
  return uniq.length ? uniq.map((a) => `from:${a} OR to:${a}`).join(" OR ") : null;
}

const COLUMNS = /** @type {const} */ ([["todo", "To do"], ["doing", "Doing"], ["done", "Done"]]);
/** @param {any} t a task */
const columnOf = (t) => (t.state === "done" || t.state === "skipped" ? "done" : t.state === "working" || t.state === "needs_check" || t.state === "stuck" ? "doing" : "todo");

/** An Ongoing project's board: its tasks in To do, Doing and Done, newest change first in each. @param {any[]} tasks @returns {{ id: string, label: string, tasks: any[] }[]} */
export function boardColumns(tasks) {
  return COLUMNS.map(([id, label]) => ({ id, label, tasks: tasks.filter((t) => columnOf(t) === id).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)) }));
}

/** The Flows a project's pinned stages turn on, from its snapshot: { flow, when } with "start" or the stage name. Nothing readable gives none. @param {unknown} snapshot @returns {{ flow: string, when: string, note?: string }[]} */
export function automationsOf(snapshot) {
  try {
    const j = JSON.parse(String(snapshot || ""));
    return (Array.isArray(j && j.automations) ? j.automations : []).filter((/** @type {any} */ a) => a && typeof a.flow === "string" && typeof a.when === "string").map((/** @type {any} */ a) => ({ flow: a.flow, when: a.when, ...(a.note ? { note: String(a.note) } : {}) }));
  } catch { return []; }
}

/**
 * What the "Runs on its own" tab lists: the Flows that name this project (flows.list with its short name), then the playbook's automations that no listed Flow already covers. Each says in a line when it runs.
 * @param {{ id: string, name?: string, label?: string, line?: string, active?: boolean }[]} rows @param {{ flow: string, when: string, note?: string }[]} automations
 * @returns {{ key: string, title: string, sub: string, id?: string }[]}
 */
export function flowsHere(rows, automations) {
  const nice = (/** @type {string} */ s) => s.replace(/_/g, " ");
  const out = rows.map((r) => ({ key: r.id, id: r.id, title: String(r.label || r.name || r.id), sub: r.active === false ? "Off" : String(r.line || "Runs here") }));
  const seen = new Set(rows.flatMap((r) => [r.id, r.name].filter(Boolean)));
  for (const a of automations) if (!seen.has(a.flow)) out.push({ key: `${a.flow}:${a.when}`, id: a.flow, title: nice(a.flow), sub: a.when === "start" ? "Runs when the project starts" : `Runs in ${a.when}${a.note ? `, ${a.note}` : ""}` });
  return out;
}
