// @ts-check
// How many chats each project really has: the sessions Vyre has indexed for it plus the ones running now. projects.list's own `threads` counts only the
// threads picked into a project by hand, so a project with a chat started in it read "0 threads" (#44).
import { attempt as apiAttempt } from "./api.js";

/**
 * @param {typeof apiAttempt} [attempt]
 * @returns {Promise<Map<string, number>>} slug to the number of distinct chats
 */
export async function chatCounts(attempt = apiAttempt) {
  const [cat, live] = await Promise.all([
    attempt("projects.catalog", { limit: 500 }, { share: true }),
    attempt("threads.list", {}, { share: true }),
  ]);
  /** @type {Map<string, Set<string>>} */ const seen = new Map();
  const add = (/** @type {any} */ slug, /** @type {any} */ id) => { if (typeof slug !== "string" || !slug || typeof id !== "string" || !id) return; (seen.get(slug) || seen.set(slug, new Set()).get(slug))?.add(id); };
  for (const s of (cat.data?.sessions || [])) for (const p of (Array.isArray(s.projects) ? s.projects : [])) add(p, s.id);
  for (const t of (Array.isArray(live.data) ? live.data : [])) add(t.project, t.id);
  return new Map([...seen].map(([k, v]) => [k, v.size]));
}

/** "1 chat", "0 chats", "12 chats": the project's count of chats in words. @param {any} p a projects.list row @param {Map<string, number>} counts */
export function chatsWord(p, counts) {
  const n = counts.get(p.slug) ?? (Array.isArray(p.threads) ? p.threads.length : Number(p.threads) || 0);
  return `${n} ${n === 1 ? "chat" : "chats"}`;
}
