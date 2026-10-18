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
 * The rows of the card, in words: what the yes grants. The risky things are said plainly (a computer, personal memory, every project, a key of the owner's) and are never left out when set; the
 * instructions show their first lines and their length. @param {any} input the draft's agents.create input
 * @returns {{ name: string, look: string, grants: string[], rows: [string, string][] }}
 */
export function cardOf(input) {
  const i = input && typeof input === "object" ? input : {};
  const a = i.auth && typeof i.auth === "object" ? i.auth : {};
  /** @type {string[]} */ const grants = [];
  if (i.projects === "*") grants.push("Can see every project");
  if (i.computer === true) grants.push("Can use a computer of its own in Space's Cloud");
  if (i.personal === true) grants.push("Can read your personal memory");
  if (a.vault) grants.push(`Runs on your ${a.vault} key`);
  if (a.fallback) grants.push(`Falls back to your ${a.fallback} key${typeof a.budget_usd === "number" ? `, up to $${a.budget_usd} a month` : ""}`);
  /** @type {[string, string][]} */ const rows = [];
  if (i.instructions) {
    const text = String(i.instructions), first = text.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n");
    rows.push(["Instructions", `${first.length > 280 ? `${first.slice(0, 279)}\u2026` : first}${text.length > first.length ? `\n(${text.length} characters in all)` : ` (${text.length} characters)`}`]);
  }
  rows.push(["Projects", i.projects === "*" ? "Every project" : Array.isArray(i.projects) && i.projects.length ? i.projects.join(", ") : "None yet"]);
  if (Array.isArray(i.skills) && i.skills.length) rows.push(["Skills", i.skills.join(", ")]);
  if (a.vault || a.fallback) rows.push(["AI account", [a.vault ? String(a.vault) : "", a.fallback ? `then ${a.fallback}${typeof a.budget_usd === "number" ? ` (up to $${a.budget_usd} a month)` : ""}` : ""].filter(Boolean).join(", ")]);
  if (i.model || i.fallback_model) rows.push(["Model", [i.model ? String(i.model) : "", i.fallback_model ? `then ${i.fallback_model} if it runs out` : ""].filter(Boolean).join(", ")]);
  if (i.effort) rows.push(["Effort", String(i.effort)]);
  return { name: String(i.name ?? ""), look: String(i.look ?? ""), grants, rows };
}

/** The words that ask the Engineer to change one thing in the proposal. @param {string} what @param {string} value */
export const changeWords = (what, value) => `Change the new agent: ${what}: ${String(value).trim()}`;
