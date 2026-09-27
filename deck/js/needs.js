// @ts-check
// What needs the user: items held at the Gate (gate.held, then gate.get for the content) and open
// permission questions from sessions (threads.asks). Both lists become one shape, oldest first,
// so Now, the header pill, the rail count and the phone views agree on the same number. Beacon
// marks only these.
//
// A held item is edited in place (js/editable.js) and answered with Send or Discard. Send is
// gate.approve {id, edited?}, where edited holds only the fields the user changed; Discard is
// gate.reject. An ask is answered allow, deny or always (with scope "project" when the ask names
// always_project): threads.answer takes no edited input. A question (threads.asks kind
// "question") is its own kind here, answered allow with `answers`, or deny to decline.
// Only Send proves presence; every answer is the owner's own act (the no-nag rule).

import { attempt, call } from "./api.js";

/**
 * @typedef {{ label: string, decision: string, primary?: boolean }} Option
 * @typedef {{ kind: "send"|"spend"|"delete", via: string, to: string[], summary: string, draft: Record<string, any> | null,
 *   error: any, sources: { text: string, from?: string }[], recalled?: string, toName?: string }} Held
 * @typedef {{ label: string, decision: string, primary?: boolean, answers?: Record<string, string> }} Answer
 * @typedef {{ id: string, kind: "draft"|"ask"|"question", at: number, agent: string|null, project: string|null, projectName: string|null,
 *   thread: string|null, threadName: string|null, title: string, why: string, command?: string,
 *   gate?: Held, rule?: string, intent?: string, details?: { label: string, value: string }[], options: Option[],
 *   tool?: string, detail?: any, questions?: any[], destination?: string|null, anchor?: any, always_project?: string|null }} Need
 */

/** @type {Need[]} */
let cache = [];
const listeners = new Set();
/** gate.get answers, by id: the content of a held item does not change while it is held. */
const got = new Map();

/** Load both lists. Missing tools count as nothing held; errors are kept for the views. */
export async function load() {
  const [held, asks, threads, projects] = await Promise.all([attempt("gate.held"), attempt("threads.asks"), attempt("threads.list"), attempt("projects.list")]);
  const thread = new Map((threads.data || []).map(t => [t.id, t]));
  const project = new Map((projects.data?.projects || []).map(p => [p.slug, p]));
  const names = (/** @type {any} */ x) => {
    const t = x.thread ? thread.get(x.thread) : null;
    const slug = x.project || t?.project || null;
    return { project: slug, projectName: x.projectName || (slug && project.get(slug)?.name) || null,
      threadName: x.threadName || t?.name || null, agent: x.agent || t?.agent || null };
  };
  await Promise.all((held.data || []).filter(d => !got.has(d.id)).map(async d => { got.set(d.id, await attempt("gate.get", { id: d.id })); }));
  /** @type {Need[]} */
  const out = [];
  for (const d of held.data || []) {
    const full = got.get(d.id) || {};
    // gate.get gives the original draft and, once a revision exists, `final`: the last words the
    // user (or another surface) settled on. That is what every surface shows and Send sends.
    const current = full.data?.final || full.data?.draft || null;
    const n = names(d);
    const to = [d.to].flat().filter(Boolean).map(String);
    const who = full.data?.toName || to.join(", ");
    const verb = d.kind === "send" ? `wrote to ${who}` : d.kind === "spend" ? `wants to spend through ${d.via}` : `wants to delete through ${d.via}`;
    out.push({ id: d.id, kind: "draft", at: d.at, ...n, thread: d.thread || null, anchor: d.anchor || null,
      title: `${n.agent || "An agent"} ${verb}. It is held at the Gate.`, why: d.why || "",
      // full.data?.error is the item's own stored error (a previous Send was approved and the
      // sender failed); full.error is a failure to read the item at all (gate.get itself refused).
      gate: { kind: d.kind || "send", via: d.via || "", to, summary: d.summary || "", draft: current, error: full.data?.error || full.error || null,
        sources: full.data?.sources || [], recalled: full.data?.recalled, toName: full.data?.toName },
      options: [{ label: d.kind === "send" ? "Send" : "Approve", decision: "approve", primary: true }, { label: "Discard", decision: "reject" }] });
  }
  for (const id of got.keys()) if (!(held.data || []).some(d => d.id === id)) got.delete(id);
  for (const a of asks.data || []) {
    const n = names({ ...a, threadName: a.threadName || a.thread_name });
    const base = { id: a.id, at: a.at, ...n, thread: a.thread || null, anchor: a.anchor || null, tool: a.tool || "",
      why: a.why || a.reason || (a.rule ? `Caught by your rule “${a.rule}”.` : ""), rule: a.rule, intent: a.intent || "" };
    if (a.kind === "question") {
      out.push({ ...base, kind: "question", title: `${n.agent || "A session"} has a question`, questions: Array.isArray(a.questions) ? a.questions : [],
        command: a.summary || "", options: [{ label: "Answer", decision: "allow", primary: true }, { label: "Decline", decision: "deny" }] });
      continue;
    }
    out.push({ ...base, kind: "ask",
      title: a.title || `May ${n.agent || "this session"} run ${a.tool}?`, command: a.command || a.summary || a.tool,
      detail: a.detail || null, destination: a.destination ?? null, always_project: a.always_project || null,
      details: a.details || (a.destination ? [{ label: "Where", value: a.destination }] : []),
      options: [{ label: "Allow once", decision: "allow", primary: true }, { label: "Deny", decision: "deny" }] });
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
 * Answer one. For a held item, approve sends what is shown: `edited` carries the changed fields
 * (from editable.js), or is left out when nothing changed. For an ask, allow, deny or always
 * ("Always in <project>": scope project, only when the ask names always_project). For a
 * question, allow with opt.answers, or deny to decline.
 * @param {Need} n @param {Answer} opt @param {Record<string, any> | null} [edited]
 */
export async function answer(n, opt, edited) {
  if (n.kind === "draft") {
    // Sending goes outside as the person, so it proves presence; discarding is the owner's own act.
    if (opt.decision === "reject") await call("gate.reject", { id: n.id }, { presence: "asked" });
    else {
      const r = await call("gate.approve", edited ? { id: n.id, edited } : { id: n.id }, { presence: true });
      // Approved, but the sender failed: the item stays held and can be sent again. gate.js keeps
      // the edit as `final` even on failure, so the next gate.get must be re-read, not reused.
      if (r && r.state === "failed") { got.delete(n.id); throw Object.assign(new Error(r.error || "the sender failed; it is still held"), { failed: true }); }
    }
  } else {
    await call("threads.answer", answerInput(n, opt), { presence: "asked" });
  }
  cache = cache.filter(x => x.id !== n.id);
  got.delete(n.id);
  for (const fn of listeners) fn(cache);
}

/**
 * threads.answer's input for one answer (section 15 contracts).
 * @param {Pick<Need, "id"|"kind"|"always_project">} n @param {Pick<Answer, "decision"|"answers">} opt
 */
export function answerInput(n, opt) {
  /** @type {Record<string, any>} */
  const input = { ask: n.id, decision: opt.decision, surface: "deck" };
  if (opt.decision === "always") {
    // "Always in <project>" writes the rule to that project only; with no project on offer the
    // switchboard's own "always" is what Claude Code suggested.
    if (n.always_project) input.scope = "project";
  }
  if (n.kind === "question" && opt.decision === "allow") input.answers = opt.answers || {};
  return input;
}
