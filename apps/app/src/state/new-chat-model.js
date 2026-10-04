// @ts-check
// New chat (Chats): who to start with, and the threads.start call for it. Pure, so Node tests it.
// A person's own surface may name the agent and the AI account the session runs on (threads.start: agent, agent_kind, account); a model's call naming one is refused by the box.

/** @typedef {{ name: string, kind?: string }} AgentRow */
/** @typedef {{ id: string, label?: string, accounts?: { id: string, signed_in?: boolean, default?: boolean }[] }} ProviderRow */

/** The agents to pick from, the person's assistant first (it is the default). @param {unknown} list @returns {{ name: string, kind: string, assistant: boolean }[]} */
export function agentChoices(list) {
  const rows = (Array.isArray(list) ? list : []).filter((a) => a && typeof a.name === "string" && a.name);
  const out = rows.map((a) => ({ name: String(a.name), kind: String(a.kind ?? "agent"), assistant: a.kind === "assistant" }));
  return [...out.filter((a) => a.assistant), ...out.filter((a) => !a.assistant)];
}

/** The AI account a session runs on: the default signed-in account of the first provider that has one, else null (the box then picks). @param {unknown} providers @returns {string | null} */
export function defaultAccount(providers) {
  for (const p of Array.isArray(providers) ? providers : []) {
    /** @type {{ id: string, signed_in?: boolean, default?: boolean }[]} */
    const accts = Array.isArray(p?.accounts) ? p.accounts : [];
    const a = accts.find((x) => x.default && x.signed_in !== false) ?? accts.find((x) => x.signed_in);
    if (a && typeof a.id === "string") return a.id;
  }
  return null;
}

/**
 * The threads.start input for a chosen agent. `root` is the folder the session starts in (the first root the box lists, files.dirs): threads.start needs one.
 * @param {{ agent: { name: string, kind: string } | null, account: string | null, text: string, root: string | null, surface: string }} o
 * @returns {{ input: Record<string, any> } | { error: string }}
 */
export function startInput(o) {
  if (!o.root) return { error: "Vyre has no folder to start a chat in yet." };
  const prompt = String(o.text ?? "").trim();
  return { input: { surface: o.surface, cwd: o.root, ...(prompt ? { prompt } : {}), ...(o.agent ? { agent: o.agent.name, agent_kind: o.agent.kind } : {}), ...(o.account ? { account: o.account } : {}) } };
}

/** The thread's id out of what threads.start answers. @param {any} r */
export const threadIdOf = (r) => (typeof r?.id === "string" && r.id ? r.id : typeof r?.thread?.id === "string" ? r.thread.id : null);
