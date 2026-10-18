// @ts-check
// The new-agent card (a task whose form is what: "agent.new"): which task is one, and what the card says of the stored draft (agents.draft.get). Pure.

/** A proposal task for a new agent is titled by the agents module "Make the agent <name>?". @param {string} title */
export const isNewAgentTitle = (title) => /^Make the agent [a-z][a-z0-9-]*\?$/.test(String(title ?? "").trim());

/** The draft id the task's form names, or "". @param {unknown} task tasks.get's answer ({ task }) */
export function draftIdOf(task) {
  const t = /** @type {any} */ (task && typeof task === "object" ? (/** @type {any} */ (task).task ?? task) : null);
  const f = t && (t.form ?? t.input ?? null);
  return f && f.what === "agent.new" && typeof f.draft === "string" ? f.draft : "";
}

/**
 * The rows of the card, in words: what the person is about to make. Only what the draft names; "All projects" is said as such. @param {any} input the draft's agents.create input
 * @returns {{ name: string, look: string, rows: [string, string][] }}
 */
export function cardOf(input) {
  const i = input && typeof input === "object" ? input : {};
  const a = i.auth && typeof i.auth === "object" ? i.auth : {};
  /** @type {[string, string][]} */ const rows = [];
  if (i.instructions) rows.push(["Instructions", String(i.instructions).length > 280 ? `${String(i.instructions).slice(0, 279)}…` : String(i.instructions)]);
  rows.push(["Projects", i.projects === "*" ? "All projects" : Array.isArray(i.projects) && i.projects.length ? i.projects.join(", ") : "None yet"]);
  if (Array.isArray(i.skills) && i.skills.length) rows.push(["Skills", i.skills.join(", ")]);
  if (a.vault || a.fallback) rows.push(["AI account", [a.vault ? String(a.vault) : "", a.fallback ? `then ${a.fallback}${typeof a.budget_usd === "number" ? ` (up to $${a.budget_usd} a month)` : ""}` : ""].filter(Boolean).join(", ")]);
  if (i.model) rows.push(["Model", String(i.model)]);
  if (i.effort) rows.push(["Effort", String(i.effort)]);
  if (i.computer === true) rows.push(["Computer", "Its own, in Space's Cloud"]);
  if (i.personal === true) rows.push(["Personal memory", "It may read yours"]);
  return { name: String(i.name ?? ""), look: String(i.look ?? ""), rows };
}

/** The words that ask the Engineer to change one thing in the proposal. @param {string} what @param {string} value */
export const changeWords = (what, value) => `Change the new agent: ${what}: ${String(value).trim()}`;
