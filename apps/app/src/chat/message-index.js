// @ts-check
// The on-device message index: words over the chat messages this app has already opened and decrypted, so Find can search person and group chats without the server ever reading them.
// It lives in memory only: nothing is written to storage or sent anywhere. A chat's messages leave it when the person leaves that chat, and all of it is cleared when the account locks.

/** @typedef {{ id: string, who: string, text: string }} Msg */
/** @typedef {{ chat: string, id: string, who: string, snippet: string, score: number }} Hit */

const WORD = /[\p{L}\p{N}]+/gu;
/** @param {string} s @returns {string[]} */
const words = (s) => Array.from(String(s || "").toLowerCase().matchAll(WORD), (m) => m[0]);

/** A short piece of the text around the first match, with the matched words wrapped in « ». @param {string} text @param {string[]} ws */
export function snippetOf(text, ws) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const low = t.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const from = Math.max(0, at < 0 ? 0 : at - 40), to = Math.min(t.length, from + 140);
  let out = t.slice(from, to);
  for (const w of [...new Set(ws)].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `«${m}»`);
  return `${from > 0 ? "…" : ""}${out}${to < t.length ? "…" : ""}`;
}

export function createMessageIndex() {
  /** @type {Map<string, { at: number, msgs: Msg[] }>} */ const chats = new Map();
  let tick = 0;
  return {
    /** Replace one chat's messages with what the app now holds (idempotent: the same call twice changes nothing). @param {string} chat @param {Msg[]} msgs */
    index(chat, msgs) {
      const clean = (msgs || []).filter(m => m && m.id && typeof m.text === "string" && m.text.trim());
      const prev = chats.get(chat);
      if (!clean.length) { if (prev) chats.delete(chat); return; }
      chats.set(chat, { at: prev && prev.msgs.length === clean.length && prev.msgs.every((m, i) => m.id === clean[i].id && m.text === clean[i].text) ? prev.at : ++tick, msgs: clean.map(m => ({ id: String(m.id), who: String(m.who || ""), text: m.text })) });
    },
    /** The person left the chat: its messages go. @param {string} chat */
    drop(chat) { chats.delete(chat); },
    /** The account locked: everything goes. */
    clear() { chats.clear(); tick = 0; },
    size() { let n = 0; for (const c of chats.values()) n += c.msgs.length; return n; },
    /**
     * Messages that hold every word of the query (a word may be a start of a longer one), best first: more of the words as whole words, then the exact phrase, then the newer chat and the later message.
     * @param {string} q @param {{ limit?: number, chat?: string, from?: string }} [o] @returns {Hit[]}
     */
    search(q, o = {}) {
      const ws = words(q);
      if (!ws.length) return [];
      const phrase = ws.join(" ");
      /** @type {Hit[]} */ const hits = [];
      for (const [chat, c] of chats) {
        if (o.chat && chat !== o.chat) continue;
        c.msgs.forEach((m, i) => {
          if (o.from && !m.who.toLowerCase().includes(o.from.toLowerCase())) return;
          const mw = words(m.text);
          if (!ws.every(w => mw.some(x => x.startsWith(w)))) return;
          const whole = ws.filter(w => mw.includes(w)).length;
          const score = whole * 10 + (mw.join(" ").includes(phrase) ? 20 : 0) + c.at * 0.01 + i * 0.0001;
          hits.push({ chat, id: m.id, who: m.who, snippet: snippetOf(m.text, ws), score });
        });
      }
      return hits.sort((a, b) => b.score - a.score).slice(0, o.limit ?? 20);
    },
  };
}

/** The app's one index. */
export const messageIndex = createMessageIndex();
