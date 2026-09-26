// @ts-check
// route — what the words in the Capsule mean: who `@` is completing, and where Enter will send.
//
// Pure, so every rule here is tested without a window. The Capsule shows the destination before
// anything is sent (floor rule 2), which means this file decides what the user reads in the
// "Sends to" row, and the send path must use exactly the destination it returned. There is no
// second decision after Enter: the prototype had one, and the same sentence came to mean one
// thing on screen and another in the daemon.

/**
 * @typedef {{ name: string, kind?: string, doing?: string|null }} Agent
 * @typedef {{ slug: string, name: string, org?: string|null, home?: string, threads?: number, last?: number|null,
 *   people?: { name: string, email?: string }[] }} Project
 * @typedef {{ id: string, label: string, cwd?: string|null, last?: number|null, project?: string|null, projectName?: string|null, agent?: string|null }} Thread
 * @typedef {{ agents: Agent[]|null, projects: Project[], threads: Thread[] }} Catalog
 * @typedef {{ kind: "agent"|"project"|"thread", id: string, label: string, sub: string, last: number }} Candidate
 * @typedef {{ kind: "assistant"|"agent"|"recall"|"thread"|"new-thread"|"quick", agent?: string, project?: string|null,
 *   projectName?: string|null, thread?: string, threadLabel?: string, cwd?: string|null, model?: string, deep?: boolean,
 *   meta: string }} Destination
 */

import { match } from "./local.js";

const KIND_ORDER = { agent: 0, project: 1, thread: 2 };

/** "4 days", "18 min". What the boards show beside a thread or a held item. */
export function age(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 14) return d === 1 ? "1 day" : `${d} days`;
  const w = Math.round(d / 7);
  return w < 9 ? `${w} weeks` : `${Math.round(d / 30)} months`;
}

/**
 * Split what is in the box. A chosen destination is a chip, held by the renderer, not text; so
 * this only has to find an `@` being typed right now, at the start or after a space, with the
 * caret still inside it.
 * @param {string} text @param {number} [caret]
 * @returns {{ completing: string|null, start: number, end: number }}
 */
export function mention(text, caret = text.length) {
  const before = text.slice(0, caret);
  const m = /(^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return { completing: null, start: -1, end: -1 };
  const start = before.length - m[2].length - 1;
  return { completing: m[2], start, end: caret };
}

/** Everything `@` can name, as rows. */
export function candidates(cat) {
  /** @type {Candidate[]} */
  const out = [];
  for (const a of cat.agents || []) out.push({ kind: "agent", id: a.name, label: a.name, last: Infinity,
    sub: a.kind === "assistant" ? "your assistant" : a.doing ? String(a.doing) : "agent" });
  for (const p of cat.projects || []) out.push({ kind: "project", id: p.slug, label: p.name, last: p.last || 0,
    sub: [p.org && p.org !== p.name ? p.org : null, `${p.threads ?? 0} threads`, p.last ? age(p.last) : null].filter(Boolean).join(" · ") });
  for (const t of cat.threads || []) out.push({ kind: "thread", id: t.id, label: t.label || t.id.slice(0, 8), last: t.last || 0,
    sub: [t.projectName || folder(t.cwd), t.last ? age(t.last) : null].filter(Boolean).join(" · ") });
  return out;
}

const folder = cwd => (cwd ? String(cwd).split("/").filter(Boolean).pop() || null : null);

/**
 * Rank what `@query` could mean. An empty query lists agents first, then projects and threads by
 * recent activity, because right after `@` the likeliest wish is "the one I was just in".
 * @param {string} query @param {Catalog} cat @returns {Candidate[]}
 */
export function complete(query, cat, limit = 7) {
  const q = String(query || "").toLowerCase();
  const all = candidates(cat);
  const score = c => {
    if (!q) return 1;
    const label = c.label.toLowerCase();
    if (label === q || c.id.toLowerCase() === q) return 5;
    if (label.startsWith(q)) return 4;
    if (label.split(/[^a-z0-9]+/).some(w => w.startsWith(q))) return 3;
    if (c.kind === "thread" && c.id.toLowerCase().startsWith(q)) return 2;
    if (label.includes(q)) return 1;
    return 0;
  };
  return all.map(c => ({ c, s: score(c) })).filter(x => x.s > 0)
    .sort((a, b) => b.s - a.s || KIND_ORDER[a.c.kind] - KIND_ORDER[b.c.kind] || b.c.last - a.c.last)
    .slice(0, limit).map(x => x.c);
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "what", "when", "where", "which", "who",
  "does", "did", "has", "have", "had", "can", "could", "would", "should", "our", "your", "their", "them", "they", "you",
  "are", "was", "were", "been", "being", "about", "need", "needs", "please", "make", "just", "some", "any", "all", "new", "now"]);

export const words = s => String(s || "").toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g)?.filter(w => !STOP.has(w)) || [];
/** Two words agree when one starts with the other's first five letters: deck/decks, rebuild/rebuilding. */
const agree = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

/**
 * The thread whose name shares the most words with what the user typed, and which words did it.
 * Nothing on a tie of zero: guessing a thread from no evidence would send the message somewhere
 * the user did not choose.
 * @param {string} text @param {Thread[]} threads
 * @returns {{ thread: Thread, matched: string[] }|null}
 */
export function bestThread(text, threads) {
  const said = words(text);
  let best = null;
  for (const t of threads) {
    const label = words(t.label);
    const matched = said.filter(w => label.some(l => agree(w, l)));
    if (!matched.length) continue;
    if (!best || matched.length > best.matched.length || (matched.length === best.matched.length && (t.last || 0) > (best.thread.last || 0))) best = { thread: t, matched };
  }
  return best;
}

/**
 * Where Enter sends, and the alternative ↓ offers. `target` is the chip (or null for the
 * default), `agentThreads` the threads of that agent when the switchboard can list them.
 * @param {Candidate|null} target @param {string} text @param {Catalog} cat
 * `quick` says the switchboard can start a thread, so a question can go straight to a model.
 * @param {{ agentThreads?: Thread[], now?: number, quick?: boolean }} [opts]
 * @returns {{ options: Destination[], why: string|null }}
 */
export function destinations(target, text, cat, { agentThreads = [], now = Date.now(), quick = false } = {}) {
  const projectOf = slug => (cat.projects || []).find(p => p.slug === slug) || null;
  const threadDest = (t, agent) => /** @type {Destination} */ ({ kind: "thread", agent: agent || t.agent || undefined, thread: t.id, threadLabel: t.label,
    project: t.project || null, projectName: t.projectName || null, cwd: t.cwd || null, meta: `thread · ${age(t.last || 0, now) || "new"}` });
  const why = (hit, where) => hit ? `"${hit.matched.join(" ")}" matched ${hit.thread.label}${where ? `, ${where}` : ""}.` : null;

  if (!target) {
    const assistant = (cat.agents || []).find(a => a.kind === "assistant");
    const mine = assistant ? /** @type {Destination} */ ({ kind: "assistant", agent: assistant.name, meta: "your assistant" }) : null;
    // A question goes to a model. One about the user's own work goes to the assistant first, which
    // has their memory; any other goes to a fast model, which has none and answers sooner.
    if (quick && asksQuestion(text)) {
      const fast = /** @type {Destination} */ ({ kind: "quick", model: "haiku", meta: "fast model · haiku" });
      const deep = /** @type {Destination} */ ({ kind: "quick", model: "sonnet", deep: true, meta: "deeper · sonnet" });
      if (!mine) return { options: [fast, deep], why: null };
      const own = ownThings(text, cat);
      return own ? { options: [mine, fast, deep], why: `${own}, so ${mine.agent} answers with your memory.` } : { options: [fast, mine, deep], why: null };
    }
    if (mine) return { options: [mine], why: null };
    // No switchboard yet, or no assistant made: memory still answers, on this Mac, with no model.
    return { options: [{ kind: "recall", meta: "memory · no model" }], why: null };
  }
  if (target.kind === "agent") {
    const hit = bestThread(text, agentThreads);
    const current = /** @type {Destination} */ ({ kind: "agent", agent: target.id, meta: "its current thread" });
    if (!hit) return { options: [current], why: null };
    // agents.ask always goes to the agent's current thread; there is no asking for a new one. So
    // the other choice is that current thread, unless the words already matched it.
    const currentId = ((cat.agents || []).find(a => a.name === target.id) || {}).thread;
    const options = [threadDest(hit.thread, target.id)];
    if (hit.thread.id !== currentId) options.push({ ...current, meta: "" });
    return { options, why: why(hit, `where ${target.id} works on it`) };
  }
  if (target.kind === "project") {
    const p = projectOf(target.id);
    const inIt = (cat.threads || []).filter(t => t.project === target.id).sort((a, b) => (b.last || 0) - (a.last || 0));
    const fresh = /** @type {Destination} */ ({ kind: "new-thread", project: target.id, projectName: p ? p.name : target.label, cwd: p ? p.home || null : null, meta: "" });
    const hit = bestThread(text, inIt);
    if (hit) return { options: [threadDest(hit.thread), fresh], why: why(hit, null) };
    return { options: inIt.length ? [fresh, threadDest(inIt[0])] : [fresh], why: null };
  }
  const t = (cat.threads || []).find(x => x.id === target.id) || { id: target.id, label: target.label };
  const options = [threadDest(t)];
  if (t.project) { const p = projectOf(t.project); options.push({ kind: "new-thread", project: t.project, projectName: p ? p.name : t.projectName, cwd: p ? p.home || null : null, meta: "" }); }
  return { options, why: null };
}

/** The destination as the "Sends to" row reads: who, then project › thread. */
export function describe(d) {
  if (d.kind === "recall") return { who: "memory", where: [] };
  if (d.kind === "quick") return { who: d.deep ? "Claude · deeper" : "Claude", where: [], meta: d.meta };
  if (d.kind === "assistant") return { who: d.agent || "assistant", where: [] };
  if (d.kind === "agent") return { who: d.agent || "agent", where: ["current thread"] };
  if (d.kind === "new-thread") return { who: d.projectName || d.project || "project", where: ["new thread"] };
  return { who: d.agent || d.projectName || "thread", where: d.agent && d.projectName ? [d.projectName, d.threadLabel || ""] : [d.threadLabel || ""] };
}

// ------------------------------------------------------------------ one list for a bare query

/**
 * @typedef {{ kind: string, id: string, label: string, sub: string, last?: number, target?: string, score?: number,
 *   copy?: string }} Result
 */

// Ties only, after name length. A higher score always wins, so an app opened ten times a day can
// outrank a project visited once (proposal section 4).
const RESULT_ORDER = { calc: 0, app: 1, setting: 2, agent: 3, project: 4, thread: 5, contact: 6, folder: 7, file: 8, define: 9 };

/**
 * Local results and Vyre's own, ranked as one list. Local results arrive scored by local.js (match
 * plus frecency); Vyre candidates and files are scored here the same way. A calculator answer is
 * always first: it only exists when the box is clearly arithmetic or a conversion.
 * @param {string} query @param {{ local?: Result[], files?: Result[], extra?: Result[], cat?: Catalog|null,
 *   boost?: (id: string, query: string) => number, limit?: number }} src
 * @returns {Result[]}
 */
const FILES_WITH_OTHERS = 4;

export function rank(query, { local = [], files = [], extra = [], cat = null, boost = () => 0, limit = 8 }) {
  const q = String(query || "").trim();
  if (!q) return [];
  /** @type {Result[]} */
  const all = [...local];
  const score = (r, label = r.label) => { const m = match(q, label); return m > 0 ? m + boost(r.id, q) : 0; };
  // A file only on scattered letters is noise in a launcher; it needs at least a substring.
  // Files count a little less than the same match on an app or a pane: "calcu" is the Calculator
  // before a file named Calcutta. And a few of them at most, when anything else matched.
  const fileRows = [];
  for (const r of files) { const s = score(r); if (s >= 0.5) fileRows.push({ ...r, score: s * 0.9 }); }
  fileRows.sort((a, b) => b.score - a.score);
  all.push(...fileRows.slice(0, all.length ? FILES_WITH_OTHERS : limit));
  if (cat) for (const c of candidates(cat)) {
    // A thread named only by its id is not something anyone types.
    const s = score(c);
    if (s >= 0.5) all.push({ ...c, target: "", score: s });
  }
  for (const r of extra) all.push(r);
  const seen = new Set();
  return all.filter(r => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    // On a tie the shorter name wins ("Bluetooth" the pane over "Bluetooth File Exchange"), then the kind.
    .sort((a, b) => (b.score || 0) - (a.score || 0) || a.label.length - b.label.length
      || (RESULT_ORDER[a.kind] ?? 99) - (RESULT_ORDER[b.kind] ?? 99) || (b.last || 0) - (a.last || 0))
    .slice(0, limit);
}

const QUESTION = /^(what|whats|what's|who|whos|why|how|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|tell|explain|summarize|summarise|draft|write|find out|remind|ask|help|make|send|check|show me)\b/i;

/** Reads as a sentence for someone, not a name to open. */
export function questionLike(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  if (QUESTION.test(t)) return true;
  return t.split(/\s+/).length >= 5;
}

const WORK = "projects?|threads?|clients?|customers?|emails?|mail|inbox|messages?|meetings?|calls?|calendar|schedule|tasks?|todos?|to-dos?|repos?|"
  + "invoices?|deadlines?|notes?|files?|docs?|documents?|decks?|reports?|drafts?|agents?|team|contacts?|week|day|today|tomorrow|yesterday|work|leads?";
const MINE = new RegExp(`\\b(my|our)\\s+(\\S+\\s+){0,2}(${WORK})\\b`, "i");
const ME = /\b(i|me|we|us)\b/i;
const NOUN = new RegExp(`\\b(${WORK})\\b`, "i");
// Questions that can only be about the user's own record, whatever nouns they use.
const THEIRS = /\b(what did (i|we)|did (i|we)|have (i|we)|remind me|what's left|what is left|who (emailed|called|wrote|messaged) me|where did (i|we))\b/i;

const wordIn = (text, name) => {
  const n = String(name || "").trim().toLowerCase();
  if (n.length < 3) return false;
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}('s)?([^a-z0-9]|$)`, "i").test(text);
};

/**
 * Whether a question is about the user's own things, and what said so: it names one of their
 * projects, threads, agents or people, says my/our (or I/me) with a work noun, or asks about what
 * they did. Null when it reads as a general question.
 * @param {string} text @param {Catalog} cat @returns {string|null}
 */
export function ownThings(text, cat) {
  const t = String(text || "");
  for (const p of cat.projects || []) {
    if (wordIn(t, p.name) || wordIn(t, p.slug)) return `it names ${p.name}`;
    for (const person of p.people || []) {
      const full = String(person.name || "");
      if (wordIn(t, full) || wordIn(t, full.split(/\s+/)[0])) return `${full.split(/\s+/)[0]} is in ${p.name}`;
    }
  }
  for (const a of cat.agents || []) if (wordIn(t, a.name)) return `it names ${a.name}`;
  // A thread is named only by its whole label: one shared word ("planning") is not naming it.
  for (const th of cat.threads || []) if (th.label && words(th.label).length && wordIn(t, th.label)) return `it names ${th.label}`;
  if (MINE.test(t) || (ME.test(t) && NOUN.test(t)) || THEIRS.test(t)) return "it asks about your own work";
  return null;
}

const ASKS = /^(what|whats|what's|who|whos|who's|why|how|hows|how's|when|where|which|is|are|was|were|do|does|did|can|could|should|would|will|explain|tell me|define)\b/i;

/**
 * A question for a model, narrower than questionLike: a sentence ending in "?" or opening with a
 * question word. A command ("send the invoice", "draft a reply") is work for the assistant, which
 * can act, so it keeps going there even though it reads as a sentence.
 */
export function asksQuestion(text) {
  const t = String(text || "").trim();
  return Boolean(t) && (/\?\s*$/.test(t) || ASKS.test(t));
}

/**
 * What Enter does with a bare query: open the top result, or send the words on. Only a strong
 * local match (a prefix or better, or a calculation) on something that does not read as a
 * question opens; everything else goes to the destination the "Sends to" row shows, so a
 * sentence never quietly becomes a file search and a name never quietly leaves the Mac.
 * @param {string} text @param {Result[]} results @returns {"open"|"ask"}
 */
export function intent(text, results) {
  const top = results[0];
  if (!top) return "ask";
  // A sum, and the rows that exist only because the words named them ("watch the intake thread",
  // "tell the site thread to run the tests"), are what the user meant even when it reads as a sentence.
  if (top.kind === "calc" || top.kind === "drive" || top.kind === "watch") return "open";
  if (questionLike(text)) return "ask";
  return (top.score || 0) >= 0.8 ? "open" : "ask";
}
