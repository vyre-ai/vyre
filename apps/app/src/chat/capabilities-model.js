// @ts-check
// Pure helpers for chat capability UI: rewind points from the live store, /later titles, second-opinion targets.

import { laterInput } from "../../../../lib/thread-composer-route.js";

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

/**
 * Assistants and models to ask for a second opinion, excluding the author of the answer.
 * @param {readonly { id: string, name: string, family?: string }[]} faces
 * @param {string} authorId
 */
export function secondOpinionTargets(faces, authorId) {
  const skip = authorId.toLowerCase();
  return faces
    .filter((f) => (f.family === "assistant" || f.family === "model") && f.id.toLowerCase() !== skip && !f.id.endsWith(`:${skip.split(":").pop()}`))
    .map((f) => ({ id: f.id, label: f.name, sub: f.family === "model" ? "Model" : "Assistant" }));
}
