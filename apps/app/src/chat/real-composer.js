// @ts-check
// What a real chat's composer offers, from the box: the person's own models (the one model service, through src/models/useMyModels.ts), the people and assistants to @mention (records.actors, agents.list), and the records to # tag (the person's own
// records, with how many of their fields are sealed). Pure, so Node tests it; src/chat/useRealComposer.ts reads the box and calls these.

/**
 * What a person's model pick in a chat asks the box (CONTRACT-one-chat.md): threads.chat-switch { chat, slot, provider, model, account, effort? }. The pick is the person's own, from the one model
 * picker (their own account and one of its models): it is kept for their turns in this chat and changes no one else's.
 * @param {string} chat @param {{ account: { id: string }, model: { id: string, provider: string } } | null | undefined} pick @param {string} [slot] @param {string | null} [effort]
 * @returns {{ tool: string, input: Record<string, unknown> } | null}
 */
export function switchCall(chat, pick, slot, effort = null) {
  if (!pick || !pick.model || !pick.model.id || !pick.model.provider) return null;
  return { tool: "threads.chat-switch", input: { chat, ...(slot ? { slot } : {}), provider: pick.model.provider, model: pick.model.id, ...(pick.account && pick.account.id ? { account: pick.account.id } : {}), ...(effort ? { effort } : {}) } };
}

/** The people and assistants to @mention: this chat's own first, then the space's actors and the person's agents, each once, never the viewer. @param {{ actors?: any, agents?: any, viewer?: string | null, here?: { name: string, family: string }[] }} o */
export function peopleFor({ actors, agents, viewer, here = [] }) {
  /** @type {Map<string, { name: string, id: string, family: "person" | "assistant", doing?: string }>} */ const out = new Map();
  const add = (/** @type {string} */ name, /** @type {string} */ family, /** @type {string} */ id = "") => { const n = String(name || "").trim(); if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, id: String(id || n), family: family === "assistant" || family === "agent" ? "assistant" : "person" }); };
  for (const p of here) add(p.name, p.family);
  for (const a of Array.isArray(actors?.actors) ? actors.actors : Array.isArray(actors) ? actors : []) if (a && a.id !== viewer && a.name !== viewer) add(a.name || a.id, a.family, a.id);
  for (const a of Array.isArray(agents) ? agents : []) {
    add(a?.name, "assistant");
    // what the live session is doing now and where it works, said under its name in the picker
    const row = out.get(String(a?.name || "").trim().toLowerCase());
    if (row) { const line = doingLine(a); if (line) row.doing = line; }
  }
  return [...out.values()];
}

/** The records to tag: every record of the person's own types, named by its title, with the number of sealed fields that hold a value. @param {{ types: any[], byType: Record<string, any[]> } | null | undefined} world @param {(def: any, rec: any) => string} titleOf @param {number} [max] */
export function recordPicks(world, titleOf, max = 300) {
  const out = [];
  for (const def of world?.types ?? []) {
    if (def.internal || /^(def-|flow-|kit-)/.test(String(def.name))) continue;
    const sealedKeys = (def.fields ?? []).filter((/** @type {any} */ f) => f.kind === "sealed" || f.seal).map((/** @type {any} */ f) => f.name);
    for (const rec of world?.byType?.[def.name] ?? []) {
      const sealed = sealedKeys.filter((/** @type {string} */ k) => rec?.data?.[k] != null && (typeof rec.data[k] !== "object" || rec.data[k].present !== false)).length;
      out.push({ name: titleOf(def, rec), type: String(def.label ?? def.name), sealed, urn: String(rec.urn ?? rec.id), kind: "record" });
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** "Working on billing" or "Waiting on your answer": what an agent's live session is doing now, and the one project it works on when it works on one. Nothing for an agent that has not started. @param {{ doing?: string, projects?: unknown } | null | undefined} a */
export function doingLine(a) {
  const d = a && typeof a.doing === "string" ? a.doing : "";
  if (!d || d === "not started") return "";
  const word = d === "working" ? "Working" : d === "idle" ? "Idle" : d.charAt(0).toUpperCase() + d.slice(1);
  const ps = a && Array.isArray(a.projects) ? a.projects.map(String).filter(Boolean) : [];
  return ps.length === 1 ? `${word} on ${ps[0]}` : word;
}
