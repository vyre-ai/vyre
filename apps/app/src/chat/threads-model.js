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
 * The tabs of the side panel. An agent: Threads, Computer, Details. A group has no tab row: its first level is everyone as faces plus the group's threads, and a tap on a person or an agent goes in (see panelView). A person: Details alone. A Flow: Runs and Details.
 * @param {ChatKind} kind @param {readonly string[]} agents the agents in the chat, by name @returns {[string, string][]}
 */
export function panelTabs(kind, agents) {
  if (kind === "agent") return [["threads", "Threads"], ["computer", "Computer"], ["details", "Details"]];
  if (kind === "group") return [["group", "Group"]];
  if (kind === "flow") return [["runs", "Runs"], ["details", "Details"]];
  return [["details", "Details"]];
}

/**
 * The tab /threads opens: Threads for an agent, Runs for a Flow, and in a group the group's own threads (its first level), or the agent's panel when one is already open. Null when the chat has no threads (a person).
 * @param {ChatKind} kind @param {readonly string[]} agents @param {string} current the tab showing now @returns {string | null}
 */
export function threadsTab(kind, agents, current) {
  if (kind === "agent") return "threads";
  if (kind === "flow") return "runs";
  if (kind === "group") return /^agent:/.test(current) && agents.includes(current.slice(6)) ? current : "group";
  return null;
}

/** The tab to show: the one asked for if this chat has it, else its first. @param {readonly [string, string][]} tabs @param {string} want */
export function tabOf(tabs, want) { return tabs.some(([id]) => id === want) ? want : tabs[0][0]; }

/**
 * An agent's threads as the panel lists them: newest first with the live one on top. The row says whether it is live and whether it needs the person.
 * @param {unknown} raw work.agent.threads' answer: { threads: [{ thread, title, last_active, state: "live" | "needs_you" | "idle" }] } (an older { id, at, live, needs } row reads too)
 * @returns {{ id: string, title: string, at: number, live: boolean, needs: boolean, forkedFrom: { thread: string, message: string } | null }[]}
 */
export function threadRows(raw) {
  /** @type {any[]} */ const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(/** @type {any} */ (raw).threads) ? /** @type {any} */ (raw).threads : [];
  return list
    .filter((t) => t && typeof t === "object" && typeof (t.thread ?? t.id) === "string" && (t.thread ?? t.id))
    .map((t) => ({ id: String(t.thread ?? t.id), forkedFrom: t.forked_from && typeof t.forked_from.thread === "string" ? { thread: String(t.forked_from.thread), message: String(t.forked_from.message ?? "") } : null, title: String(t.title || "New thread"), at: Number(t.last_active ?? t.at) || 0, live: t.live === true || t.state === "live" || t.state === "needs_you", needs: t.needs === true || t.state === "needs_you" }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.at - a.at);
}

/** One line before people are added to a thread with an agent: what they and the agent get. @param {readonly string[]} names @param {string} agent */
export function addPeopleLine(names, agent) {
  const who = names.length <= 1 ? names[0] ?? "They" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${who} will see this thread's earlier messages. ${agent} keeps what it knows from this thread.`;
}

/**
 * The quiet word after an agent's name in the chat header: the thread's own title, or nothing when it has none yet ("New chat", "Chat") or only repeats the agent ("engineer").
 * @param {string | null | undefined} title @param {string | null | undefined} agent
 */
export function threadSub(title, agent) {
  const t = String(title ?? "").trim();
  if (!t || /^(new chat|new thread|chat)$/i.test(t)) return undefined;
  return t.toLowerCase() === String(agent ?? "").trim().toLowerCase() ? undefined : t;
}

/** A title that says nothing yet. @param {unknown} t */
export const untitledTitle = (t) => !String(t ?? "").trim() || /^(new chat|new thread|chat)$/i.test(String(t ?? "").trim());

/**
 * A short title for a thread from its first message, as chat apps do: the first line, without mentions, tags, links or markup, cut at a word to about six words. Nothing for a command or a message
 * with no words, so the thread keeps waiting for a better one.
 * @param {unknown} text @returns {string}
 */
export function titleFrom(text) {
  const line = String(text ?? "").trim().split(/\n/).find((l) => l.trim()) ?? "";
  if (!line || line.startsWith("/")) return "";
  const words = line.replace(/https?:\/\/\S+/g, " ").replace(/[@#][\w.-]+/g, " ").replace(/[*_`>~[\]()]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return "";
  let out = "";
  for (const w of words.slice(0, 6)) { if ((out + " " + w).trim().length > 48) break; out = (out + " " + w).trim(); }
  if (!out) out = words[0].slice(0, 48);
  out = out.replace(/[,;:.!?-]+$/, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** The hint under the composer for an agent: /new and /threads. @param {string} agent @param {boolean} working */
export function agentHint(agent, working) {
  return working ? `Your message steers ${agent} now. Press Tab to queue it for after.` : `/new starts a new thread. /threads shows every thread with ${agent}, ready to continue.`;
}

/**
 * What a group's panel shows: its first level, or one person or one agent drilled into (the tab is `person:<id>` or `agent:<name>`). A tab that names someone who left falls back to the first level.
 * @param {string} tab @param {readonly { id: string, name: string, family: string }[]} members
 * @returns {{ level: "first" } | { level: "person", id: string } | { level: "agent", name: string }}
 */
export function groupView(tab, members) {
  const person = /^person:(.+)$/.exec(tab), agent = /^agent:(.+)$/.exec(tab);
  if (person && members.some((m) => m.id === person[1] && m.family !== "assistant")) return { level: "person", id: person[1] };
  if (agent && members.some((m) => m.name === agent[1] && m.family === "assistant")) return { level: "agent", name: agent[1] };
  return { level: "first" };
}
