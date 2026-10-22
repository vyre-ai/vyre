// @ts-check
// Which chats are one agent's threads, and what such a thread is called.
// A thread is a chat of one person and one agent. The assistant's pinned chat lists nobody (it acts as the person), and a chat may store the agent under its name, its id or its model. Those still count.

const PLACEHOLDER = /^(new chat|new thread|new site|chat|untitled|assistant)$/i;

/** The ids one agents.list row is stored under. @param {any} row */
export function keysOf(row) {
  /** @type {Set<string>} */ const keys = new Set();
  if (!row || typeof row !== "object") return keys;
  for (const k of [row.name, row.uid, row.id, row.model, row.fallback_model]) if (k) keys.add(String(k));
  if (row.kind === "assistant") keys.add("assistant");
  return keys;
}

/** The roster row a query names: its name, id, model, or "assistant" for the assistant. @param {readonly any[]} roster @param {string} query */
export function rowFor(roster, query) {
  const q = String(query || "");
  const ql = q.toLowerCase();
  const list = Array.isArray(roster) ? roster : [];
  const hit = (/** @type {any} */ a) => a && (String(a.name) === q || String(a.name).toLowerCase() === ql || (a.uid && String(a.uid) === q) || (a.id && String(a.id) === q) || (a.model && String(a.model) === q) || (a.fallback_model && String(a.fallback_model) === q));
  return list.find(hit) || (ql === "assistant" ? list.find((/** @type {any} */ a) => a && a.kind === "assistant") || null : null);
}

/** Every id a query may be stored under, including the query itself. @param {readonly any[]} roster @param {string} query */
export function keysFor(roster, query) {
  const keys = new Set([String(query)]);
  const row = rowFor(roster, query);
  if (row) for (const k of keysOf(row)) keys.add(k);
  return keys;
}

/**
 * A chat of exactly this person is a thread with the agent these keys name.
 * The assistant's pinned chat counts even when it lists no assistant. A group, or a chat with someone else, does not.
 * @param {{ people: readonly string[], agents: readonly string[], me: string, keys: Set<string>, pinned: string | null, assistant: boolean }} o
 */
export function isAgentThread(o) {
  if (!o.people || o.people.length !== 1 || String(o.people[0]) !== String(o.me)) return false;
  if (o.agents.length === 1 && o.keys.has(String(o.agents[0]))) return true;
  // the pinned assistant chat is created with nobody listed: it acts as the person, and it is still that agent's thread
  return o.assistant === true && o.pinned === "assistant" && o.agents.length === 0;
}

/**
 * The agent's name a one-person chat belongs to, or null when it is not one agent's thread.
 * Chats stored under an id or a model alias share the agent's name, so the summary has one row.
 * @param {{ people: readonly string[], agents: readonly string[], pinned: string | null, roster: readonly any[] }} o
 */
export function canonicalAgent(o) {
  if (!o.people || o.people.length !== 1) return null;
  if (o.agents.length === 1) {
    const row = rowFor(o.roster, String(o.agents[0]));
    return row && row.name ? String(row.name) : String(o.agents[0]);
  }
  if (o.agents.length === 0 && o.pinned === "assistant") {
    const asst = (Array.isArray(o.roster) ? o.roster : []).find((/** @type {any} */ a) => a && a.kind === "assistant");
    return asst && asst.name ? String(asst.name) : "assistant";
  }
  return null;
}

/** The agents.list rows, or none when the list cannot be read. A call from this module sees the whole row (id and model included). @param {any} ctx */
export async function rosterOf(ctx) {
  const known = await ctx.call("agents.list", {}).then((/** @type {any} */ r) => (r && r.data) || []).catch(() => []);
  return Array.isArray(known) ? known : [];
}

/** The first thing the person typed in a chat, from the stream, trimmed to 60 characters, or "". @param {any} db @param {string} chat */
export function firstUserLine(db, chat) {
  if (!db || !chat) return "";
  try {
    const rows = /** @type {any[]} */ (db.prepare("SELECT json_extract(json, '$.data.text') AS text FROM stream_frames WHERE session = ? AND json_extract(json, '$.type') = 'chat.user-message' AND json_extract(json, '$.data.text') IS NOT NULL ORDER BY cur ASC LIMIT 8").all(chat));
    for (const r of rows) {
      const t = String(r && r.text || "").replace(/\s+/g, " ").trim();
      if (!t || t.startsWith("/") || t.startsWith("<")) continue;
      return t.length > 60 ? t.slice(0, 60).trimEnd() : t;
    }
    return "";
  } catch { return ""; }
}

/**
 * What a one-agent thread is called: a title the person gave it, else the first thing they typed (trimmed, 60 characters), else "New thread". Never the agent's reply.
 * @param {unknown} stored @param {unknown} userText @param {unknown} [reply]
 */
export function threadTitle(stored, userText, reply) {
  const t = String(stored ?? "").replace(/\s+/g, " ").trim();
  const user = String(userText ?? "").replace(/\s+/g, " ").trim();
  const cut = user.length > 60 ? user.slice(0, 60).trimEnd() : user;
  const line = String(reply ?? "").replace(/\s+/g, " ").trim();
  if (t && !PLACEHOLDER.test(t) && t !== line) return t;
  return cut || "New thread";
}
