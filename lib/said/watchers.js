// @ts-check
// watchers: the person's own words "turn on the inbox watcher" as an act_out intent for
// watchers.create, which runs for a model only when the person asked, after they saw the card.
//
// The key is built from the card the person saw, never from the words: its name and the folder's
// hash at that moment, exactly what the watchers module's target tool answers with:
//   watchers.create:<name>@<hash>
// so a yes for the watcher as shown cannot be spent on one whose files changed since (the hash
// moves), or on another watcher.
//
// THE CALLER'S RULE: the hash is the one in the card the person was SHOWN, taken from the card
// results already in this thread (the watchers.card or watchers.preset tool results, newest per
// watcher), never from a fresh watchers.card or watchers.list made when the turn is heard. An
// agent could otherwise show card A, edit the folder, and have the person's "turn it on" record
// the new hash, licensing code they never saw. Nothing here computes or fetches a hash.
//
// Same rules as the other recorders: only the person's own unquoted plain asks, 15 minutes, one
// use, and nothing recorded when no watcher, or more than one, matches the words.

import { asks } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const ON = V("turn\\s+on|enable|activate|switch\\s+on|start|turn|switch");
const NOT_ON = /\b(turn\s+off|pause|stop|disable|cancel|delete|remove)\b/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}_@-])${esc(word)}($|[^\\p{L}\\p{N}_@-])`, "iu").test(text);

/**
 * @typedef {{ name: string, hash: string, title?: string }} Card a watcher whose card was shown in this thread, with the hash that card carried
 * @param {string} text the turn as typed
 * @param {{ watchers?: Card[] }} [where]
 * @returns {{ intents: any[], skipped: { reason: string }[] }}
 */
export function watchersIntents(text, where = {}) {
  const intents = [], skipped = [];
  const cards = (where.watchers || []).filter(c => c && typeof c.name === "string" && c.name && typeof c.hash === "string" && c.hash);
  if (!cards.length) return { intents, skipped };
  const seen = new Set();
  for (const { clause } of askClauses(text)) {
    if (!/\bwatchers?\b/i.test(clause) || !asks(clause, ON) || NOT_ON.test(clause)) continue;
    const named = /\b(?:turn\s+on|enable|activate|switch\s+on|start)\s+(?:the|my)\s+([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}?)\s+watcher\b/iu.exec(clause)
      || /\b(?:turn|switch)\s+(?:the|my)\s+([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}?)\s+watcher\s+on\b/iu.exec(clause);
    const words = named ? named[1].toLowerCase().split(/\s+/).filter(w => w.length >= 3) : [];
    const label = c => `${c.title || ""} ${c.name}`.toLowerCase().replace(/[-_]+/g, " ");
    const hit = words.length ? cards.filter(c => words.every(w => has(label(c), w))) : [];
    if (hit.length !== 1) { skipped.push({ reason: hit.length ? "ambiguous_watcher" : "no_watcher" }); continue; }
    const key = `watchers.create:${hit[0].name}@${hit[0].hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    intents.push(actIntent(key, "turn on a watcher", "watchers"));
  }
  return { intents, skipped };
}
