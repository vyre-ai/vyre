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
 * `project` is a project's short name when the chat starts from inside one (threads.start files the chat there); empty or absent, the box files it in General.
 * @param {{ agent: { name: string, kind: string } | null, account: string | null, text: string, root: string | null, surface: string, project?: string | null }} o
 * @returns {{ input: Record<string, any> } | { error: string }}
 */
export function startInput(o) {
  if (!o.root) return { error: "Vyre has no folder to start a chat in yet." };
  const prompt = String(o.text ?? "").trim();
  return { input: { surface: o.surface, cwd: o.root, ...(prompt ? { prompt } : {}), ...(o.agent ? { agent: o.agent.name, agent_kind: o.agent.kind } : {}), ...(o.account ? { account: o.account } : {}), ...(o.project ? { project: o.project } : {}) } };
}

/** The thread's id out of what threads.start answers. @param {any} r */
export const threadIdOf = (r) => (typeof r?.id === "string" && r.id ? r.id : typeof r?.thread?.id === "string" ? r.thread.id : null);

/** A Project record's id (the kernel's v4 uuid). A chat started from a project's page names the project by it; threads.start takes the short name, so the screen asks work.project.ref first. @param {unknown} v */
export const isProjectRecordId = (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);

/** The short name threads.start takes, from what work.project.ref answered (or null: the project is not here). @param {any} ref */
export const slugFromRef = (ref) => (typeof ref?.slug === "string" && ref.slug ? ref.slug : null);
