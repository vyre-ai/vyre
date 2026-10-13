// @ts-check
// New chat (Chats): who to start with, and the work.chat.create call for it. Pure, so Node tests it.

/** @typedef {{ name: string, kind?: string }} AgentRow */
/** @typedef {{ id: string, label?: string, accounts?: { id: string, signed_in?: boolean, default?: boolean }[] }} ProviderRow */

/** The agents to pick from, the person's assistant first (it is the default). @param {unknown} list @returns {{ name: string, kind: string, assistant: boolean }[]} */
export function agentChoices(list) {
  const rows = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.name === "string" && a.name);
  const out = rows.map((a) => ({ name: String(a.name), kind: String(a.kind ?? "agent"), assistant: a.kind === "assistant" }));
  return [...out.filter((a) => a.assistant), ...out.filter((a) => !a.assistant)];
}

/**
 * The work.chat.create input for a new chat (CONTRACT-one-chat.md): the person is always in it. The person's own assistant is never a listed member (it acts as the person), so choosing it adds nobody;
 * choosing a space or project agent lists that agent by name.
 * @param {{ agent: { name: string, assistant: boolean } | null, title?: string }} o
 */
export function createInput(o) {
  const title = String(o.title ?? "").trim();
  return { ...(title ? { title } : {}), people: [], agents: o.agent && !o.agent.assistant ? [o.agent.name] : [] };
}

/**
 * The New chat picker's three groups: your assistant, the people on the team (never you), and the agents the Agents screen shows. Each filtered by the search words.
 * @param {{ agents: { name: string, kind?: string, assistant?: boolean }[], people: { id: string, name: string, role?: string }[], me?: string, q?: string }} o
 * @returns {{ assistant: { name: string } | null, people: { id: string, name: string, role?: string }[], agents: { name: string }[] }}
 */
export function pickerGroups(o) {
  const w = String(o.q ?? "").trim().toLowerCase();
  const hit = (/** @type {string} */ n) => !w || n.toLowerCase().includes(w);
  const asst = o.agents.find((a) => a.assistant || a.kind === "assistant") ?? null;
  return {
    assistant: asst && (hit(asst.name) || hit("your assistant")) ? { name: asst.name } : null,
    people: o.people.filter((p) => p.id !== o.me && p.name && hit(p.name)),
    agents: o.agents.filter((a) => a !== asst && hit(a.name)).map((a) => ({ name: a.name })),
  };
}

/** The work.chat.create people and agents for what was picked (ids of people, names of agents). Picking only your assistant is not a selection here: it opens the pinned chat. @param {{ people: string[], agents: string[] }} sel */
export const inputFor = (sel) => ({ people: [...new Set(sel.people)], agents: [...new Set(sel.agents)] });

/** The new chat's id out of what work.chat.create answers: { chat, title, project, people, agents }. @param {any} r */
export const chatIdOf = (r) => (typeof r?.chat === "string" && r.chat ? r.chat : null);
