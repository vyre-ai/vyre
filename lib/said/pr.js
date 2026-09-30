// @ts-check
// pr: the person's own words "open a PR", "merge it", "review this PR" as act_out intents (P17).
//
// Deterministic, no model: the words are a small closed set, and the destination comes from
// github's own registry tool (github.act.target), never from the words. The intent's one `to` is
// exactly the key github answers with, for example
// "github.project.pr.merge:alex/app#7", which is what the registry's said-match asks the Gate
// about. So "merge it" said about alex/app#7 covers that PR and nothing else.
//
// Records nothing when in doubt: the clause must be a real ask (not a question, a conditional, a
// draft, a negation or a standing permission), the PR must be named once (by number in the words,
// or as the thread's current PR with "it / this / that / the PR"), and github must resolve it.
// Dropping is always safe: the call is then held for the person, as without P17.
//
// Only the person's own unquoted words count. The caller passes the turn as typed; quote.js takes
// out anything pasted or forwarded first.

import { unquoted } from "./quote.js";
import { clauses, asks, MAX_BYTES, DEFAULT_WINDOW } from "./extract.js";

const V = s => new RegExp(`\\b(?:${s})\\b`, "gi");
const MERGE = V("merge|merging");
const OPEN = V("open|raise|create|make|file|start|submit");
const REVIEW = V("review|approve");
const PR_NOUN = /\b(prs?|pull[\s-]+requests?)\b/i;
const PR_NUMBER = /(?:\b(?:prs?|pull[\s-]+requests?)\s*#?\s*|#)(\d{1,7})\b/gi;
const CURRENT = /\b(it|this|that|the\s+(?:pr|pull[\s-]+request)|this\s+(?:pr|pull[\s-]+request)|that\s+(?:pr|pull[\s-]+request))\b/i;
const STANDING = /\b(from\s+now\s+on|going\s+forward|always|whenever|every|each\s+time|any\s*time|auto(matically)?|without\s+(asking|checking)|don'?t\s+(need\s+to\s+)?ask|standing|until|recurring)\b/i;

/**
 * @typedef {{ project: string, pr?: number, session?: string, head?: string }} Where
 *   what the thread is about: its project, the PR it is on (if any), and for an open the session
 *   or branch the PR would come from
 */

/**
 * @param {string} text the turn as the person typed it
 * @param {Where|null|undefined} where
 * @param {(tool: string, input: any) => Promise<string[]|null>} target github.act.target for this
 *   tool and input: resolves to its `to` array, or null/throws when github cannot say
 * @returns {Promise<{ intents: any[], skipped: { reason: string, tool?: string }[] }>}
 */
export async function prIntents(text, where, target) {
  const intents = [];
  const skipped = [];
  if (!where || typeof where.project !== "string" || !where.project) return { intents, skipped };
  let s = String(text ?? "");
  const bytes = Buffer.from(s, "utf8");
  if (bytes.length > MAX_BYTES) s = bytes.subarray(0, MAX_BYTES).toString("utf8").replace(/�+$/, "");
  const words = unquoted(s).text;
  const seen = new Set();

  for (const c of clauses(words)) {
    if (!c.ok || STANDING.test(c.sentence)) continue;
    for (const [tool, verbs] of /** @type {[string, RegExp][]} */ ([
      ["github.project.pr.merge", MERGE], ["github.project.pr.open", OPEN], ["github.project.pr.review", REVIEW],
    ])) {
      if (!asks(c.clause, verbs)) continue;
      const named = [...new Set([...c.clause.matchAll(PR_NUMBER)].map(m => Number(m[1])))];
      const noun = PR_NOUN.test(c.clause);
      let input;
      if (tool === "github.project.pr.open") {
        // "open" alone is too common: a PR noun is required, and a number means an existing PR.
        if (!noun || named.length) continue;
        if (!where.session && !where.head) { skipped.push({ reason: "no_branch", tool }); continue; }
        input = { project: where.project, ...(where.session ? { session: where.session } : { head: where.head }) };
      } else {
        // merge: "merge it" is enough; review needs the PR noun ("review it" may mean code).
        if (tool === "github.project.pr.review" && !noun) continue;
        if (named.length > 1) { skipped.push({ reason: "ambiguous_pr", tool }); continue; }
        const pr = named.length ? named[0] : (CURRENT.test(c.clause) ? where.pr : undefined);
        if (!Number.isInteger(pr) || /** @type {number} */ (pr) < 1) { skipped.push({ reason: "no_pr", tool }); continue; }
        input = { project: where.project, pr };
      }
      let to;
      try { to = await target(tool, input); } catch { to = null; }
      if (!Array.isArray(to) || to.length !== 1 || typeof to[0] !== "string" || !to[0].startsWith(`${tool}:`)) { skipped.push({ reason: "target_unresolved", tool }); continue; }
      if (seen.has(to[0])) continue;
      seen.add(to[0]);
      intents.push({
        kind: "act_out", channel: "github", to: [to[0]], to_ids: [to[0]], unresolved: [],
        what: tool === "github.project.pr.open" ? "open a pull request" : tool === "github.project.pr.merge" ? "merge a pull request" : "review a pull request",
        when: { at: null, window_minutes: DEFAULT_WINDOW }, standing: false,
        limits: { amount_max: null, currency: null, count: 1, until: null }, reply_to_current: false,
      });
    }
  }
  return { intents, skipped };
}
