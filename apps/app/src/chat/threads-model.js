// @ts-check
// The pure half of the chat panel's tabs and of an agent's threads. An agent is one chat with many threads inside: /new starts one, /threads lists them, a fork starts one at a message.
// No tool is called here (threads-source.ts does that, over acct6's shapes).

/** @typedef {"agent" | "person" | "group" | "flow"} ChatKind */

/**
 * What kind of chat this is, from who else is in it. A Flow is one chat whose runs are its threads.
 * @param {{ others: readonly { family: string }[], flow?: boolean }} o @returns {ChatKind}
 */
export function chatKind({ others, flow = false }) {
  if (flow) return "flow";
  if (others.length >= 2) return "group";
  if (others.length === 1 && others[0].family === "assistant") return "agent";
  return "person";
}

/**
 * The tabs of the side panel. An agent: Threads, Computer, Details. A group: Group, then one tab per agent in it. A person: Details alone. A Flow: Runs and Details.
 * @param {ChatKind} kind @param {readonly string[]} agents the agents in the chat, by name @returns {[string, string][]}
 */
export function panelTabs(kind, agents) {
  if (kind === "agent") return [["threads", "Threads"], ["computer", "Computer"], ["details", "Details"]];
  if (kind === "group") return [["group", "Group"], ...agents.map((a) => /** @type {[string, string]} */ ([`agent:${a}`, a]))];
  if (kind === "flow") return [["runs", "Runs"], ["details", "Details"]];
  return [["details", "Details"]];
}

/**
 * The tab /threads opens: Threads for an agent, Runs for a Flow, and in a group the first agent's tab unless an agent tab is already open. Null when the chat has no threads (a person).
 * @param {ChatKind} kind @param {readonly string[]} agents @param {string} current the tab showing now @returns {string | null}
 */
export function threadsTab(kind, agents, current) {
  if (kind === "agent") return "threads";
  if (kind === "flow") return "runs";
  if (kind === "group") return /^agent:/.test(current) && agents.includes(current.slice(6)) ? current : agents.length ? `agent:${agents[0]}` : null;
  return null;
}

/** The tab to show: the one asked for if this chat has it, else its first. @param {readonly [string, string][]} tabs @param {string} want */
export function tabOf(tabs, want) { return tabs.some(([id]) => id === want) ? want : tabs[0][0]; }

/**
 * An agent's threads as the panel lists them: newest first with the live one on top. The row says whether it is live and whether it needs the person.
 * @param {unknown} raw agents.threads' answer: { threads: [{ id, title, at, live?, needs? }] }
 * @returns {{ id: string, title: string, at: number, live: boolean, needs: boolean }[]}
 */
export function threadRows(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).threads) ? /** @type {any} */ (raw).threads : [];
  return list
    .filter((t) => t && typeof t === "object" && typeof t.id === "string" && t.id)
    .map((t) => ({ id: String(t.id), title: String(t.title || "New thread"), at: Number(t.at) || 0, live: t.live === true, needs: t.needs === true }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at);
}

/** The hint under the composer for an agent: /new and /threads. @param {string} agent @param {boolean} working */
export function agentHint(agent, working) {
  return working ? `Your message steers ${agent} now. Press Tab to queue it for after.` : `/new starts a new thread. /threads shows every thread with ${agent}, ready to continue.`;
}
