// @ts-check
// What a real chat's composer offers, from the box: the models and accounts that can answer (providers.list), the people and assistants to @mention (records.actors, agents.list), and the records to # tag (the person's own
// records, with how many of their fields are sealed). Pure, so Node tests it; src/chat/useRealComposer.ts reads the box and calls these.
import { answerRows } from "./core/answer-with.js";

/** @typedef {{ id: string, label: string, fit: number | null }} ModelChoice */

/**
 * The models the person can switch to, across their signed-in accounts, and which one answers now. An id is `provider|account|model`.
 * @param {any} providerRows providers.list's answer @param {{ provider?: string | null, account?: string | null, model?: string | null }} current
 * @returns {{ models: ModelChoice[], model: string | undefined }}
 */
export function modelChoices(providerRows, current = {}) {
  const rows = answerRows(providerRows, { provider: current.provider ?? null, account: current.account ?? null });
  const many = rows.length > 1;
  const names = new Map((Array.isArray(providerRows) ? providerRows : []).map((/** @type {any} */ r) => [String(r?.id ?? "").toLowerCase(), String(r?.label ?? r?.id ?? "")]));
  const perProvider = (/** @type {string} */ p) => rows.filter((r) => r.provider === p).length;
  /** @type {ModelChoice[]} */ const models = [];
  /** @type {string | undefined} */ let now;
  for (const r of rows) {
    for (const m of r.models) {
      const id = `${r.provider}|${r.account ?? ""}|${m.id}`;
      const who = `${names.get(r.provider) || r.label}${perProvider(r.provider) > 1 ? ` (${r.label})` : ""}`;
      models.push({ id, label: many ? `${who} · ${m.label}` : m.label, fit: null });
      if (r.now && current.model && String(current.model).toLowerCase().includes(String(m.id).toLowerCase())) now = id;
    }
  }
  return { models, model: now };
}

/**
 * What switching one slot's model asks the box (CONTRACT-one-chat.md): chats.switch { chat, slot, provider, model, account? }.
 * @param {string} chat @param {string} id @param {any} providerRows @param {{ provider?: string | null, account?: string | null }} [current] @param {string} [slot]
 * @returns {{ tool: string, input: Record<string, unknown> } | null}
 */
export function switchCall(chat, id, providerRows, current = {}, slot) {
  const [provider, account, model] = String(id).split("|");
  if (!provider || !model) return null;
  return { tool: "chats.switch", input: { chat, ...(slot ? { slot } : {}), provider, model, ...(account ? { account } : {}) } };
}

/** The people and assistants to @mention: this chat's own first, then the space's actors and the person's agents, each once, never the viewer. @param {{ actors?: any, agents?: any, viewer?: string | null, here?: { name: string, family: string }[] }} o */
export function peopleFor({ actors, agents, viewer, here = [] }) {
  /** @type {Map<string, { name: string, id: string, family: "person" | "assistant" }>} */ const out = new Map();
  const add = (/** @type {string} */ name, /** @type {string} */ family, /** @type {string} */ id = "") => { const n = String(name || "").trim(); if (n && !out.has(n.toLowerCase())) out.set(n.toLowerCase(), { name: n, id: String(id || n), family: family === "assistant" || family === "agent" ? "assistant" : "person" }); };
  for (const p of here) add(p.name, p.family);
  for (const a of Array.isArray(actors?.actors) ? actors.actors : Array.isArray(actors) ? actors : []) if (a && a.id !== viewer && a.name !== viewer) add(a.name || a.id, a.family, a.id);
  for (const a of Array.isArray(agents) ? agents : []) add(a?.name, "assistant");
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
