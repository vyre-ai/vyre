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
//
// waiting (cohesion, ADR 0036 decision 4): where the box has it, waiting.list says what waits and
// waiting.count, kept fresh by waiting.changed, is the one number every surface shows (the rail,
// the top bar, the phone's Now label, the app icon). The owners' reads above still give each
// draft's words and each question's options, which a waiting row only titles; the list is then
// exactly the rows waiting names, and a row not read yet shows from its title. Reminders and
// pairings count but draw where they do today (Planner, the pairing row on Now). An older box
// without waiting: the merge above, and the count is the list's length.

import { attempt, queue, snapshot } from "./api.js";

/**
 * @typedef {{ label: string, decision: string, primary?: boolean }} Option
 * @typedef {{ kind: "send"|"spend"|"delete", via: string, to: string[], summary: string, draft: Record<string, any> | null,
 *   error: any, sources: { text: string, from?: string }[], recalled?: string, toName?: string }} Held
 * @typedef {{ label: string, decision: string, primary?: boolean, answers?: Record<string, string> }} Answer
 * @typedef {{ id: string, kind: "draft"|"ask"|"question", at: number, agent: string|null, project: string|null, projectName: string|null,
 *   thread: string|null, threadName: string|null, title: string, why: string, command?: string,
 *   gate?: Held, rule?: string, intent?: string, details?: { label: string, value: string }[], options: Option[],
 *   tool?: string, detail?: any, questions?: any[], destination?: string|null, anchor?: any, always_project?: string|null,
 *   presence?: { required?: boolean, covered?: boolean } | null }} Need
 */

/** @type {Need[]} */
let cache = [];
const listeners = new Set();
/** gate.get answers, by id: the content of a held item does not change while it is held. */
const got = new Map();

/** waiting's count, once it has said one; null: this box has no waiting (or has not answered). */
let waitingCount = /** @type {number | null} */ (null);
/** False once this box said it has no waiting.list: it is not asked again this page. */
let hasWaiting = true;

/** The one number: waiting's count where the box has it, else the list's length. */
export const count = () => waitingCount ?? cache.length;

/** waiting.changed {count, by_kind} (app.js passes it on): the count moves at once, the rows on the next load. @param {any} e */
export function heardWaiting(e) {
  const n = e?.payload?.count;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return;
  waitingCount = n;
  tell();
}

/** waiting.list's ids for the rows the Deck draws here: an owner's id for each ask and draft.
 * @param {any[]} rows @returns {Map<string, any>} owner id to its row */
export function waitingIds(rows) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.id !== "string" || (r.kind !== "ask" && r.kind !== "draft")) continue;
    const at = r.id.indexOf(":");
    out.set(at >= 0 ? r.id.slice(at + 1) : r.id, r);
  }
  return out;
}

/** An ask waiting names that threads.asks did not give (yet), from its title alone. @param {any} r @param {string} id @returns {Need} */
export function fromWaiting(r, id) {
  const question = r.kind === "ask" && Array.isArray(r.answer?.fill) && r.answer.fill.includes("answers");
  const kind = question ? "question" : "ask";
  return { id, kind, at: typeof r.at === "number" ? r.at : 0, agent: null, project: r.project || null, projectName: null,
    thread: r.thread || null, threadName: null, title: String(r.title || ""), why: String(r.detail || ""), command: kind === "ask" ? String(r.detail || "") : "",
    options: question ? [{ label: "Answer", decision: "allow", primary: true }, { label: "Decline", decision: "deny" }]
      : [{ label: "Allow once", decision: "allow", primary: true }, { label: "Deny", decision: "deny" }], };
}

/** Has a load from the box finished? Then a snapshot never replaces what it said. */
let fresh = false;

/**
 * The list as this device last saw it (api.js snapshot), at once, before the box answers, so the
 * phone's Now opens offline (ADR 0029 R3). Asks and questions only: what is held at the Gate is
 * never kept on the device (the service worker's rule for gate.* reads), so drafts appear when
 * the box answers. Resolves true when it drew something.
 */
export async function restore() {
  const s = await snapshot.get("needs");
  if (fresh || cache.length || !s || !Array.isArray(s.value) || !s.value.length) return false;
  cache = s.value;
  tell();
  return true;
}
const keep = () => { void snapshot.set("needs", cache.filter(n => n.kind !== "draft")); };

/** Load both lists. Missing tools count as nothing held; errors are kept for the views. */
export async function load() {
  const [held, asks, threads, projects, waiting] = await Promise.all([attempt("gate.held"), attempt("threads.asks"), attempt("threads.list"), attempt("projects.list"),
    hasWaiting ? attempt("waiting.list", {}) : Promise.resolve({ data: null, error: null })]);
  if (waiting.error?.code === "no_such_tool" || waiting.error?.code === "unknown_tool") { hasWaiting = false; waitingCount = null; }
  // The box is out of reach: the list keeps what it last showed, never goes empty (R3).
  if (held.error?.code === "offline" && asks.error?.code === "offline") return { items: cache, errors: { gate: held.error, threads: asks.error } };
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
      // What answering takes, as the box says it (gate.held, gate.get): {required, covered}.
      presence: d.presence || full.data?.presence || null,
      title: `${n.agent || "An agent"} ${verb}. It is held at the Gate.`, why: d.why || "",
      // full.data?.error is the item's own stored error (a previous Send was approved and the
      // sender failed); full.error is a failure to read the item at all (gate.get itself refused).
      gate: { kind: d.kind || "send", via: d.via || "", to, summary: d.summary || "", draft: current, error: full.data?.error || full.error || null,
        sources: full.data?.sources || [], recalled: full.data?.recalled, toName: full.data?.toName },
      options: [{ label: d.kind === "send" ? "Send" : "Approve", decision: "approve", primary: true }, { label: "Discard", decision: "reject" }] });
  }
  for (const id of got.keys()) if (!(held.data || []).some(d => d.id === id)) got.delete(id);
  for (const a of asks.data || []) out.push(askNeed(a, names({ ...a, threadName: a.threadName || a.thread_name })));
  /** @type {Need[]} */
  let list = out;
  const w = /** @type {any} */ (waiting.data);
  if (w && Array.isArray(w.rows)) {
    // waiting is the one list: what it names, from the owners' reads where they have it.
    const want = waitingIds(w.rows);
    list = out.filter(n => want.has(n.id));
    // An ask not read yet is answerable from its id; a draft is not shown before its words are read
    // (Send sends what was seen), and the next gate.held load brings it.
    for (const [id, r] of want) if (r.kind === "ask" && !r.answer?.fill?.includes("answers") && !list.some(n => n.id === id)) list.push(fromWaiting(r, id));
    if (typeof w.count === "number") waitingCount = w.count;
  }
  list.sort((x, y) => x.at - y.at);
  cache = list;
  fresh = true;
  if (!held.error && !asks.error) keep();
  tell();
  return { items: list, errors: { gate: held.error || null, threads: asks.error || null, ...(w?.partial?.length ? { partial: w.partial } : {}) } };
}

export const current = () => cache;

/**
 * One ask or question as a Need.
 * @param {any} a a threads.asks row, or an ask.raised payload @param {{ project: string|null, projectName: string|null, threadName: string|null, agent: string|null }} n
 * @returns {Need}
 */
function askNeed(a, n) {
  const base = { id: a.id, at: a.at, ...n, thread: a.thread || null, anchor: a.anchor || null, tool: a.tool || "", presence: a.presence || null,
    why: a.why || a.reason || (a.rule ? `Caught by your rule “${a.rule}”.` : ""), rule: a.rule, intent: a.intent || "" };
  if (a.kind === "question") {
    return { ...base, kind: "question", title: `${n.agent || "A session"} has a question`, questions: Array.isArray(a.questions) ? a.questions : [],
      command: a.summary || "", options: [{ label: "Answer", decision: "allow", primary: true }, { label: "Decline", decision: "deny" }] };
  }
  return { ...base, kind: "ask",
    title: a.title || `May ${n.agent || "this session"} run ${a.tool}?`, command: a.command || a.summary || a.tool,
    detail: a.detail || null, destination: a.destination ?? null, always_project: a.always_project || null,
    details: a.details || (a.destination ? [{ label: "Where", value: a.destination }] : []),
    options: [{ label: "Allow once", decision: "allow", primary: true }, { label: "Deny", decision: "deny" }] };
}

/** Asks raised while this page was open, by id, until answered: a push can land before the list has them. */
const raised = new Map();

/**
 * Hear an ask.* event (app.js passes each one on): an ask.raised is kept, so find() can open it by
 * id when the list does not have it (yet); ask.answered and ask.cancelled drop it.
 * @param {{ type: string, at?: number, thread?: string|null, project?: string|null, payload?: any }} e
 */
export function hear(e) {
  const p = e?.payload || {};
  const id = typeof p.ask === "string" ? p.ask : p.ask?.id || p.id;
  if (!id) return;
  if (e.type !== "ask.raised") { raised.delete(id); return; }
  raised.set(id, askNeed({ ...p, id, thread: p.thread || e.thread || null, at: p.at || e.at || Date.now() },
    { project: p.project || e.project || null, projectName: null, threadName: p.threadName || p.thread_name || null, agent: p.agent || null }));
}

/** One item by id: the list's, else an ask raised this session and not answered. @param {string} id @returns {Need|null} */
export function find(id) {
  return cache.find(x => x.id === id) || raised.get(id) || null;
}

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
    if (opt.decision === "reject") await queue("gate.reject", { id: n.id }, { presence: "asked" });
    else {
      const r = await queue("gate.approve", edited ? { id: n.id, edited } : { id: n.id }, { presence: true });
      // Approved, but the sender failed: the item stays held and can be sent again. gate.js keeps
      // the edit as `final` even on failure, so the next gate.get must be re-read, not reused.
      if (r && r.state === "failed") { got.delete(n.id); throw Object.assign(new Error(r.error || "the sender failed; it is still held"), { failed: true }); }
    }
  } else {
    await queue("threads.answer", answerInput(n, opt), { presence: "asked" });
  }
  cache = cache.filter(x => x.id !== n.id);
  // One fewer at once; waiting.changed confirms it (or corrects it) from the box.
  if (waitingCount != null && waitingCount > 0) waitingCount--;
  got.delete(n.id);
  keep();
  tell();
}

/** Every watcher hears the list, and the installed app's icon shows the count. */
function tell() {
  badge(count());
  for (const fn of listeners) fn(cache);
}

let badged = -1;
/**
 * The count on the home-screen icon, only in the installed app (a browser tab has no icon of its
 * own), only when it changes, and quietly nothing where the browser has no badge.
 * @param {number} n
 */
export function badge(n) {
  if (n === badged) return;
  const nav = /** @type {any} */ (typeof navigator !== "undefined" ? navigator : null);
  if (!nav || typeof nav.setAppBadge !== "function") return;
  let installed = false;
  try { installed = nav.standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches); } catch {}
  if (!installed) return;
  badged = n;
  try { const p = n > 0 ? nav.setAppBadge(n) : nav.clearAppBadge?.(); p?.catch?.(() => {}); } catch {}
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
