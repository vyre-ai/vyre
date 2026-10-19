// @ts-check
// Pure helpers for chat capability UI: rewind points from the live store, /later titles, second-opinion targets.

import { laterInput } from "../../../../lib/thread-composer-route.js";
import { answerRows } from "./core/answer-with.js";

/**
 * @typedef {{ uuid: string, text: string, at: number | null }} RewindPoint
 */

/**
 * Person messages that can be rewound to, newest first.
 * @param {{ rows: () => readonly { key: string }[], item: (k: string) => { kind?: string, text?: string, command?: boolean, at?: number } | null }} store
 * @returns {RewindPoint[]}
 */
export function rewindPointsFromStore(store) {
  const out = [];
  for (const row of store.rows()) {
    const it = store.item(row.key);
    if (!it || it.kind !== "user" || it.command || !row.key.startsWith("u:")) continue;
    const uuid = row.key.slice(2);
    out.push({ uuid, text: String(it.text ?? ""), at: typeof it.at === "number" ? it.at : null });
  }
  return out.reverse();
}

/** @param {string} line */
export function laterNoteFromLine(line) {
  const m = /^\/later(?:\s+([\s\S]*))?$/i.exec(String(line || "").trim());
  if (!m) return null;
  const body = (m[1] || "").trim();
  const input = laterInput(body);
  const title = String(input.title || "Follow up in this chat");
  const when = typeof input.at === "string" && input.at ? input.at : undefined;
  return { title, when };
}

/** The providers a model the chat does not have yet can join as (core/stream/group.js secondOpinion). */
const JOINS = ["claude", "codex", "grok", "openrouter", "openai-compatible"];
/** A model slot's provider: "model:codex/default#12" is codex. @param {string} id */
const providerOf = (id) => /^model:([a-z][a-z0-9-]*)\//.exec(String(id).toLowerCase())?.[1] ?? null;

/**
 * Assistants and models to ask for a second opinion, excluding the author of the answer; then one per connected account's provider the chat does not
 * have yet (its default model joins in the same step), from providers.list. A provider is offered once: the box picks the model, not the account.
 * @param {readonly { id: string, name: string, family?: string }[]} faces
 * @param {string} authorId
 * @param {any} [providerRows] providers.list's answer
 */
export function secondOpinionTargets(faces, authorId, providerRows = []) {
  const skip = authorId.toLowerCase();
  const here = faces
    .filter((f) => (f.family === "assistant" || f.family === "model") && f.id.toLowerCase() !== skip && !f.id.endsWith(`:${skip.split(":").pop()}`))
    .map((f) => ({ id: f.id, label: f.name, sub: f.family === "model" ? "Model" : "Assistant" }));
  const taken = new Set([providerOf(authorId), ...faces.map((f) => providerOf(f.id))].filter(Boolean));
  const names = new Map((Array.isArray(providerRows) ? providerRows : []).map((/** @type {any} */ r) => [String(r?.id ?? "").toLowerCase(), String(r?.label || r?.id || "")]));
  /** @type {{ id: string, label: string, sub: string }[]} */ const join = [];
  for (const r of answerRows(providerRows)) {
    if (!JOINS.includes(r.provider) || taken.has(r.provider)) continue;
    taken.add(r.provider);
    join.push({ id: r.provider, label: names.get(r.provider) || r.label, sub: "Joins this chat" });
  }
  return [...here, ...join];
}
