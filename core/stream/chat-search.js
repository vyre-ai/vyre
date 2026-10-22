// @ts-check
// Words in the chats and threads a person can already read. The on-device index only has chats
// this app has opened; this reads the server's own logs for the rest. A private message (enc) is
// skipped, the same way the stream keeps it out of memory and export.

import { isEncrypted } from "./protocol.js";

const WORD = /[\p{L}\p{N}]+/gu;
/** @param {string} s */
const words = s => Array.from(String(s || "").toLowerCase().matchAll(WORD), m => m[0]);

/** A short piece around the first match. @param {string} text @param {string[]} ws */
function snippet(text, ws) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  const low = t.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const from = Math.max(0, at < 0 ? 0 : at - 40), to = Math.min(t.length, from + 140);
  let out = t.slice(from, to);
  for (const w of [...new Set(ws)].sort((a, b) => b.length - a.length)) out = out.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), m => `«${m}»`);
  return `${from > 0 ? "…" : ""}${out}${to < t.length ? "…" : ""}`;
}

/** The words of one frame, or "" when it is private, expired, or not a message. @param {any} f */
export function textOfFrame(f) {
  if (!f || isEncrypted(f)) return "";
  const d = f.data;
  if (!d || typeof d !== "object" || d.enc !== undefined || d.expired) return "";
  const k = String(f.type || "").replace(/^chat\./, "");
  if (k !== "text-delta" && k !== "user-message") return "";
  return typeof d.text === "string" ? d.text : "";
}

/**
 * Messages in one session's frames that hold every word of the query.
 * @param {string} session @param {any[]} frames @param {string} q
 * @returns {{ chat: string, id: string, who: string, snippet: string }[]}
 */
export function searchFrames(session, frames, q) {
  const ws = words(q);
  if (!ws.length) return [];
  /** @type {Map<string, { id: string, who: string, text: string }>} */ const msgs = new Map();
  for (const f of frames || []) {
    const text = textOfFrame(f);
    if (!text) continue;
    const id = String((f.data && f.data.message) || f.message || f.cur);
    const prev = msgs.get(id) || { id, who: "", text: "" };
    prev.text += text;
    if (typeof f.author === "string" && f.author) prev.who = f.author;
    msgs.set(id, prev);
  }
  /** @type {{ chat: string, id: string, who: string, snippet: string }[]} */ const hits = [];
  for (const m of msgs.values()) {
    const mw = words(m.text);
    if (!ws.every(w => mw.some(x => x.startsWith(w)))) continue;
    hits.push({ chat: session, id: m.id, who: m.who, snippet: snippet(m.text, ws) });
  }
  return hits;
}

/** Frames in the ring, plus any stored frame the ring does not hold (a row written beside it). @param {any} log */
function allFrames(log) {
  const ring = log.read(0);
  /** @type {Set<number>} */ const have = new Set(ring.map((/** @type {any} */ f) => f.cur));
  /** @type {any[]} */ const extra = [];
  if (log.db) {
    try {
      log.flush();
      for (const r of log.db.prepare("SELECT json FROM stream_frames WHERE session = ?").all(log.session)) {
        const f = JSON.parse(String(r.json));
        if (f && !have.has(f.cur)) extra.push(f);
      }
    } catch { /* the table is not there yet */ }
  }
  return [...ring, ...extra];
}

/**
 * Search the logs the caller may read. A session they may not read is skipped, never listed.
 * @param {{ logs: any, access: any, q: unknown, limit?: number, meta: any, input?: any }} o
 */
export async function searchChats(o) {
  const query = String(o.q || "").trim();
  if (!words(query).length) return { hits: [] };
  const cap = Math.max(1, Math.min(20, Number(o.limit) || 20));
  /** @type {{ chat: string, id: string, who: string, snippet: string }[]} */ const hits = [];
  const ids = typeof o.logs.ids === "function" ? o.logs.ids() : [];
  for (const session of ids.slice(0, 80)) {
    try { await o.access.read(session, o.meta, o.input || {}); }
    catch { continue; }
    for (const h of searchFrames(session, allFrames(o.logs.get(session)), query)) {
      hits.push(h);
      if (hits.length >= cap) return { hits };
    }
  }
  return { hits };
}
