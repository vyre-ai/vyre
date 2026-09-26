// @ts-check
// What needs the user: drafts held at the Gate (gate.held) and open permission questions from
// sessions (threads.asks). Both lists become one shape, newest last, so Now, the header pill,
// the rail count and the phone views agree on the same number. Beacon marks only these.

import { attempt, call } from "./api.js";

/**
 * @typedef {{ label: string, decision: string, primary?: boolean, input?: any }} Option
 * @typedef {{ id: string, kind: "draft"|"ask", at: number, agent: string|null, project: string|null, projectName: string|null,
 *   thread: string|null, threadName: string|null, title: string, why: string, command?: string,
 *   draft?: { to: string, toName?: string, subject?: string, body: string, recalled?: string,
 *     segments?: { text: string, source?: number }[] | null, sources: { text: string, from?: string }[] },
 *   rule?: string, intent?: string, details?: { label: string, value: string }[], options: Option[] }} Need
 */

/** @type {Need[]} */
let cache = [];
const listeners = new Set();

/** Load both lists. Missing tools count as nothing held; errors are kept for the views. */
export async function load() {
  const [held, asks] = await Promise.all([attempt("gate.held"), attempt("threads.asks")]);
  /** @type {Need[]} */
  const out = [];
  for (const d of held.data || []) {
    out.push({ id: d.id, kind: "draft", at: d.at, agent: d.agent || null, project: d.project || null, projectName: d.projectName || null,
      thread: d.thread || null, threadName: d.threadName || null,
      title: d.title || `${d.agent || "An agent"} wrote to ${d.to}. The draft is held at the Gate.`,
      why: d.why || "", draft: { to: d.to, toName: d.toName, subject: d.subject, body: d.body || "", recalled: d.recalled,
        segments: d.segments || null, sources: d.sources || [] },
      options: [{ label: "Send as drafted", decision: "approve", primary: true }, { label: "Edit draft", decision: "edit" }, { label: "Discard", decision: "reject" }] });
  }
  for (const a of asks.data || []) {
    out.push({ id: a.id, kind: "ask", at: a.at, agent: a.agent || null, project: a.project || null, projectName: a.projectName || null,
      thread: a.thread || null, threadName: a.threadName || null,
      title: a.title || `May ${a.agent || "this session"} run ${a.tool}?`, command: a.command || a.summary || a.tool,
      why: a.why || (a.rule ? `Caught by your rule “${a.rule}”.` : ""), rule: a.rule, intent: a.intent || "", details: a.details || [],
      options: a.options?.length ? a.options : [{ label: "Allow once", decision: "allow" }, { label: "Deny", decision: "deny" }] });
  }
  out.sort((x, y) => x.at - y.at);
  cache = out;
  for (const fn of listeners) fn(cache);
  return { items: out, errors: { gate: held.error || null, threads: asks.error || null } };
}

export const current = () => cache;

/** Hear every reload of the list. Returns an unsubscribe. */
export function watch(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/**
 * Answer one: approve, reject or edit a draft (text is the edited body), or answer an ask.
 * @param {Need} n @param {Option} opt @param {string} [text]
 */
export async function answer(n, opt, text) {
  if (n.kind === "draft") {
    if (opt.decision === "reject") await call("gate.reject", { id: n.id });
    else await call("gate.approve", text !== undefined ? { id: n.id, body: text } : { id: n.id });
  } else {
    await call("threads.answer", { ask: n.id, decision: opt.decision, ...(opt.input ? { input: opt.input } : {}) });
  }
  cache = cache.filter(x => x.id !== n.id);
  for (const fn of listeners) fn(cache);
}
