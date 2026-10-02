// @ts-check
// watchers: the person's own words "watch my inbox" and "turn it on" as act_out intents for the two
// watcher acts that run for a model only when the person asked (core/watchers' watchers.preset and
// watchers.create, reach "asked"). Same rules as team.js and pr.js: deterministic, only plain asks from
// the person's unquoted words (no question, condition or standing wording), one recorded use, 15 minutes.
//
// The keys are the ones core/watchers builds, character for character:
//   watchers.preset:<project>/<kind>             kind is mail, calendar, repo, slack, feed or pr (a session's PR review comments)
//   watchers.create:<project>/<name>@<hash>      the hash is the code the person saw on the card
// "Turn it on" means the one watcher whose card is waiting; a name means that one. The watchers, with
// their hashes, come from the caller, never from the words, so a word that is not one of them
// records nothing.
//
// THE CALLER'S RULE (reviewer-2): the hash is the one in the card the person was SHOWN, taken from
// the card results already in this thread (watchers.card or watchers.preset tool results, newest per
// watcher), never from a fresh watchers.card or watchers.list made when the turn is heard. An agent
// could otherwise show card A, edit the folder, and have the person's "turn it on" record the new
// hash, licensing code they never saw. Nothing here computes or fetches a hash.
//
// "Turn it on" (a pronoun) binds only to a card shown in the assistant's last turn or the one before
// (shownTurnsAgo 0 or 1), and only when exactly one such draft exists: a person who says "turn it on"
// about something else several turns later records nothing, and names the watcher instead. A watcher
// the person names is not limited by age.

import { asks } from "./extract.js";
import { askClauses, actIntent } from "./pr.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const WATCH = V("watch|monitor|keep\\s+an\\s+eye\\s+on");
const ON = V("turn\\s+on|switch\\s+on|enable|activate|start|turn|switch");
const NOT_ON = /\b(turn\s+off|switch\s+off|pause|stop|disable|cancel|delete|remove|don'?t|do\s+not)\b/i;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const has = (text, word) => new RegExp(`(^|[^\\p{L}\\p{N}_@-])${esc(word)}($|[^\\p{L}\\p{N}_@-])`, "iu").test(text);

/** What a request for each kind of watcher sounds like. */
const KIND = {
  mail: /\b(?:my\s+)?(?:inbox|e-?mail|emails|mail|gmail)\b/i,
  calendar: /\b(?:my\s+|the\s+)?calendar\b/i,
  repo: /\b(?:the\s+)?(?:github\s+)?repo(?:sitory)?\b|\bgithub\b/i,
  slack: /\bslack\b/i,
  feed: /\b(?:rss|atom|feed)\b/i,
  // A pull request's review comments: more specific than the repo they are in, so it wins over "repo" in the same clause.
  pr: /\b(?:(?:pr|pull\s+request)s?\s+(?:review\s+)?comments?|review\s+comments?)\b/i,
};

/**
 * @typedef {{ project: string, kinds?: string[], watchers?: { name: string, hash: string, title?: string, state?: string, shownTurnsAgo?: number }[] }} WatchersWhere
 *   kinds: the preset kinds this install offers; watchers: the project's watchers whose card was shown in
 *   this thread, each with the hash that card carried and shownTurnsAgo (assistant turns since it was
 *   shown: 0 is the last one). Only a watcher in state "draft" can be turned on.
 */

/**
 * @param {string} text the turn as typed
 * @param {WatchersWhere|null|undefined} where
 * @returns {{ intents: any[], skipped: { reason: string, act?: string }[] }}
 */
export function watchersIntents(text, where) {
  const intents = [];
  const skipped = [];
  if (!where || typeof where.project !== "string" || !where.project) return { intents, skipped };
  const project = where.project;
  const kinds = new Set((where.kinds || []).map(String));
  const drafts = (where.watchers || []).filter(w => w && w.name && w.hash && (w.state === undefined || w.state === "draft"));
  // A pronoun reaches only a card shown just now; a caller that cannot say how long ago gets no pronoun.
  const recent = drafts.filter(w => Number.isInteger(w.shownTurnsAgo) && w.shownTurnsAgo >= 0 && w.shownTurnsAgo <= 1);
  const seen = new Set();
  const add = (key, what) => { if (!seen.has(key)) { seen.add(key); intents.push(actIntent(key, what, "watchers")); } };

  for (const { clause } of askClauses(text)) {
    if (NOT_ON.test(clause)) continue;
    if (asks(clause, ON)) {
      // "turn it on": the one watcher waiting. "turn on the invoices watcher": the one named.
      const named = /\b(?:turn\s+on|switch\s+on|enable|activate|start)\s+(?:the|my)\s+([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}?)\s+watcher\b/iu.exec(clause)
        || /\b(?:turn|switch)\s+(?:the|my)\s+([\p{L}\p{N}'-]+(?:\s+[\p{L}\p{N}'-]+){0,3}?)\s+watcher\s+on\b/iu.exec(clause);
      const pronoun = /\b(?:turn|switch)\s+(?:it|that|this|them)\s+on\b|\b(?:turn\s+on|switch\s+on|enable|activate|start)\s+(?:it|that|this)\b/i.test(clause);
      if (named) {
        const words = named[1].toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        const hit = words.length ? drafts.filter(d => words.every(w => has(`${d.name} ${d.title || ""}`.toLowerCase().replace(/[-_]+/g, " "), w))) : [];
        if (hit.length === 1) add(`watchers.create:${project}/${hit[0].name}@${hit[0].hash}`, "turn on a watcher");
        else skipped.push({ reason: hit.length > 1 ? "ambiguous_watcher" : "no_watcher", act: "turn_on" });
      } else if (pronoun) {
        if (recent.length === 1) add(`watchers.create:${project}/${recent[0].name}@${recent[0].hash}`, "turn on a watcher");
        else skipped.push({ reason: recent.length > 1 ? "ambiguous_watcher" : "no_watcher", act: "turn_on" });
      }
      continue;
    }
    if (asks(clause, WATCH)) {
      let hit = Object.keys(KIND).filter(k => KIND[k].test(clause) && kinds.has(k));
      if (hit.includes("pr")) hit = hit.filter(k => k !== "repo");
      // The kind must be exactly one and offered here; an ambiguous clause records nothing.
      if (hit.length === 1) add(`watchers.preset:${project}/${hit[0]}`, `set up a ${hit[0]} watcher`);
      else skipped.push({ reason: hit.length > 1 ? "ambiguous_kind" : "no_kind", act: "preset" });
    }
  }
  return { intents, skipped };
}
