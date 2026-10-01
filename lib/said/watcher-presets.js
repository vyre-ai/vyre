// @ts-check
// watcher-presets: the person's own words "watch my inbox" as an act_out intent for watchers.preset
// (reach "asked"): a model may set up a ready-made watcher only when the person asked for that kind.
// Same rules as the other recorders (plain ask, unquoted words, 15 minutes, one use). The key is
//   watchers.preset:<project>/<kind>      kind is mail, calendar, repo, slack or feed
// "Turning it on" is lib/said/watchers.js (the assistant's), pinned to the card's hash.

import { asks } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const WATCH = V("watch|monitor|keep\\s+an\\s+eye\\s+on");
const NOT = /\b(turn\s+off|switch\s+off|pause|stop|disable|cancel|delete|remove|don'?t|do\s+not)\b/i;

const KIND = {
  mail: /\b(?:my\s+)?(?:inbox|e-?mail|emails|mail|gmail)\b/i,
  calendar: /\b(?:my\s+|the\s+)?calendar\b/i,
  repo: /\b(?:the\s+)?(?:github\s+)?repo(?:sitory)?\b|\bgithub\b/i,
  slack: /\bslack\b/i,
  feed: /\b(?:rss|atom|feed)\b/i,
};

/**
 * @param {string} text the turn as typed
 * @param {{ project: string, kinds?: string[] }|null|undefined} where the project and the preset kinds this install offers
 * @returns {{ intents: any[], skipped: { reason: string, act?: string }[] }}
 */
export function presetIntents(text, where) {
  const intents = [], skipped = [];
  if (!where || typeof where.project !== "string" || !where.project) return { intents, skipped };
  const kinds = new Set((where.kinds || []).map(String));
  const seen = new Set();
  for (const { clause } of askClauses(text)) {
    if (NOT.test(clause) || !asks(clause, WATCH)) continue;
    const hit = Object.keys(KIND).filter(k => KIND[k].test(clause) && kinds.has(k));
    if (hit.length !== 1) { skipped.push({ reason: hit.length > 1 ? "ambiguous_kind" : "no_kind", act: "preset" }); continue; }
    const key = `watchers.preset:${where.project}/${hit[0]}`;
    if (!seen.has(key)) { seen.add(key); intents.push(actIntent(key, `set up a ${hit[0]} watcher`, "watchers")); }
  }
  return { intents, skipped };
}
