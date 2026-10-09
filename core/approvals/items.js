// @ts-check
// approvals items: the other things that wait on the person, in the same queue as the cards a yes opens (DESIGN-one-yes: one queue; inventory item 4, step C).
//
// The Gate's held drafts, a session's asks and the vault's pending grants, passes and requests used to be three queues, each read by its own surface and joined only for display by core/waiting.
// Each is now an ITEM CARD in this queue: it appears the moment its owner holds it, carries the owner's tool that settles it (`answer`), and is closed with the outcome when the owner
// settles it. The owner still holds the content and still decides (its detail screen, its edit, its own answer tool); this module holds the one list, so a surface reads one place.
// A card is rebuilt from the owner's list on start and after the owner's own events, so a restart or a missed event never leaves one behind. Nothing here sends, grants or answers.
import { clean, at, opt, cap, one, DETAIL_MAX } from "../../lib/waiting-text.js";

export const ITEM_KINDS = /** @type {const} */ (["approval", "ask", "draft", "access", "run", "task", "eval", "health"]);
const DEBOUNCE_MS = 200;
/** How long a settled card stays readable (its outcome), and how many. */
const RECENT_MS = 10 * 60_000, RECENT_MAX = 50;

/**
 * What a surface needs beyond a card's title, taken from the owner's own row: who asked and where (agent, thread and its name, project), what a draft is (kind, via, where it goes, its summary), the
 * questions and their choices, and what answering takes. A NAMED list, not the row: the agent's reasons, a draft's words and an ask's anchors never ride on a card (test/waiting). The same
 * fields the same surfaces already get from gate.held and threads.asks. Dropped when settled.
 */
const pick = (/** @type {any} */ row, /** @type {string[]} */ keys) => Object.fromEntries(keys.filter(k => row && row[k] !== undefined && row[k] !== null).map(k => [k, row[k]]));
const questionsOf = (/** @type {any} */ qs) => (Array.isArray(qs) ? qs.slice(0, 8).map(q => ({ question: clean(q && q.question, 300), header: clean(q && q.header, 60), multiSelect: Boolean(q && q.multiSelect),
  options: (Array.isArray(q && q.options) ? q.options : []).slice(0, 12).map((/** @type {any} */ o) => ({ label: clean(o && (o.label ?? o), 120), ...opt("description", clean(o && o.description, 200)) })) })) : undefined);
const ASK_FACTS = ["id", "kind", "tool", "summary", "destination", "thread", "thread_name", "agent", "project", "at", "presence", "state", "decision", "source", "machine", "always", "always_project"];
const GATE_FACTS = ["id", "kind", "via", "to", "summary", "agent", "thread", "project", "at", "presence", "error"];
/** @param {any} row @param {"ask"|"gate"} kind */
const factsOf = (row, kind) => {
  try {
    const f = pick(row, kind === "ask" ? ASK_FACTS : GATE_FACTS);
    if (kind === "ask" && Array.isArray(row.questions)) f.questions = questionsOf(row.questions);
    for (const k of ["summary", "destination", "thread_name", "agent", "error"]) if (typeof f[k] === "string") f[k] = clean(f[k], 300);
    return { facts: f };
  } catch { return {}; }
};

/** threads.asks rows. A question is answered with a decision and its answers; a permission with a decision. */
export const fromAsks = rows => rows.map(a => {
  const question = a.kind === "question";
  const first = question && Array.isArray(a.questions) && a.questions[0] ? a.questions[0].question : "";
  const title = clean(a.summary) || clean(first) || (question ? "A question from a session" : `Allow ${clean(a.tool, 40) || "a tool"}?`);
  const who = [clean(a.agent, 40), clean(a.thread_name, 80)].filter(Boolean).join(" in ");
  // An ask from a session on the paired Mac is answered on that Mac: the box cannot forward an answer yet (threads.answer {machine} arrives with federation). Until then the row names the machine
  // and its answer has no tool, so a surface says "Answer it on <mac>".
  const mac = a.source === "mac";
  const machine = mac && a.machine ? clean(a.machine, 80) : "";
  return { id: `threads:${a.id}`, kind: "ask", title, ...opt("detail", cap(who, DETAIL_MAX)), ...opt("project", a.project), ...opt("thread", a.thread),
    ...(mac ? { machine: machine || "your Mac" } : {}), at: at(a.at), source: "threads", ...factsOf(a, "ask"),
    answer: mac ? { tool: null, input: null, fill: [], on: machine || "your Mac" }
      : { tool: "threads.answer", input: { ask: a.id }, fill: question ? ["decision", "answers"] : ["decision"] } };
});

/** gate.held rows. Only the sender's own summary and where it goes, never the draft. */
export const fromHeld = rows => rows.map(h => {
  const to = (Array.isArray(h.to) ? h.to : [h.to]).map(x => one(x)).filter(Boolean).join(", ");
  const via = clean(h.via, 40);
  const title = clean(h.summary) || `A ${clean(h.kind, 20) || "draft"}${via ? ` via ${via}` : ""}`;
  const detail = clean([via, to && `to ${to}`].filter(Boolean).join(" "), DETAIL_MAX);
  return { id: `gate:${h.id}`, kind: "draft", title, ...opt("detail", detail), ...opt("project", h.project), ...opt("thread", h.thread),
    at: at(h.at), source: "gate", ...factsOf(h, "gate"), answer: { tool: "gate.approve", input: { id: h.id }, fill: [] } };
});

const names = (/** @type {any} */ xs) => (Array.isArray(xs) ? xs : []).slice(0, 4).map(x => clean(x && typeof x === "object" ? x.name : x, 60)).filter(Boolean).join(", ");
/** vault.pending: what an agent asked the vault for and a person has not settled (grants, passes, agent logins, people to trust, passes to accept). Names only, never a value. */
export const fromVault = (/** @type {any} */ p) => {
  const row = (/** @type {string} */ id, /** @type {string} */ title, /** @type {string} */ detail, /** @type {any} */ when) =>
    ({ id: `vault:${id}`, kind: "access", title: clean(title) || "The vault is asked for access", ...opt("detail", clean(detail, DETAIL_MAX)), at: at(when), source: "vault",
      answer: { tool: "vault.approve", input: { id }, fill: [] } });
  const list = (/** @type {any} */ x) => (Array.isArray(x) ? x.filter(y => y && typeof y === "object" && y.id) : []);
  return [
    ...list(p && p.grants).map(g => row(g.id, `Let ${clean(g.module, 40)}${g.watcher ? `/${clean(g.watcher, 40)}` : ""} use "${clean(g.name, 60)}"`, clean(g.by, 40) && `asked by ${clean(g.by, 40)}`, g.at)),
    ...list(p && p.agentGrants).map(g => row(g.id, `Let agent ${clean(g.agent, 40)} use "${clean(g.item ?? g.name, 60)}"${g.origin ? ` at ${clean(g.origin, 60)}` : ""}`, clean(g.by, 40) && `asked by ${clean(g.by, 40)}`, g.at)),
    ...list(p && p.passes).map(s => row(s.id, `Share ${names(s.items)} with ${clean(s.holder, 60)}`, [s.mode, clean(s.by, 40) && `asked by ${clean(s.by, 40)}`].filter(Boolean).join(", "), s.created)),
    ...list(p && p.people).map(x => row(x.id, `Trust the card for ${clean(x.name, 60)}`, x.fingerprint ? `fingerprint ${clean(x.fingerprint, 40)}` : "", x.at)),
    // the Vault MCP's reveal ask: the pass's agent asked to see one item once. Two answers: Allow once (a yes: vault.mcp.reveal.allow is a vault moment) and Decline.
    ...list(p && p.mcpReveals).map(x => ({ id: `vault:${x.id}`, kind: "access", title: clean(`Let ${clean(x.pass, 40)}'s agent see "${clean(x.item, 60)}" once?`) || "An agent asks to see a vault item", ...opt("detail", clean(x.why, DETAIL_MAX)), at: at(x.at), source: "vault",
      answer: { tool: "vault.mcp.reveal.allow", input: { id: x.id }, fill: [] },
      answers: [{ label: "Allow once", tool: "vault.mcp.reveal.allow", input: { id: x.id }, fill: [] }, { label: "Decline", tool: "vault.mcp.reveal.clear", input: { id: x.id }, fill: [] }] })),
    ...list(p && p.accepts).map(x => row(x.id, `Accept a pass from ${clean(x.owner, 60)}`, x.items ? names(x.items) : "", x.at)),
  ];
};

/**
 * flows.attention rows (f3): a run that stopped, is stuck, or a stage held back. Retry, Skip and Stop are one answer (`flows.settle`), a gate's is to move it on (`advance`, with a reason). Plain words only:
 * the reason is the run's own message, already redacted by the owner; no step data. A quiet row (a person simply has not answered yet) is marked so a surface does not push for it.
 */
export const fromAttention = rows => rows.map(r => {
  const gate = Boolean(r.gate);
  return { id: `flows:${r.run}`, kind: "run", title: gate ? `${clean(r.label, 80)} is held` : `${clean(r.label, 80)} ${r.kind === "stuck" ? "is stuck at" : r.kind === "paused" ? "paused at" : r.kind === "stale" ? "is waiting at" : "stopped at"} ${clean(r.step_label || r.step, 60) || "a step"}`,
    ...opt("detail", cap(clean(r.message), DETAIL_MAX)), at: at(r.since), source: "flows", ...(r.loud === false ? { quiet: true } : {}),
    answer: gate ? { tool: "flows.settle", input: { run: r.run, action: "advance" }, fill: ["reason"] }
      : r.kind === "stale" ? { tool: "flows.settle", input: { run: r.run }, fill: ["action"], choices: ["stop"] }
      : { tool: "flows.settle", input: { run: r.run }, fill: ["action"], choices: ["retry", "skip", "stop"] } };
});

/**
 * flows.attention's stuck tasks (R031-45): a task someone flagged stuck waits on a person to unblock or skip it. One `task` card each, the reason in the detail, answered by `tasks.move`.
 */
export const fromStuckTasks = rows => rows.map(t => ({ id: `tasks:${t.task}`, kind: "task", title: `${clean(t.label, 100) || "A task"} is stuck`, ...opt("detail", cap(clean(t.reason), DETAIL_MAX)), at: at(t.since), source: "flows",
  answer: { tool: "tasks.move", input: { id: t.task }, fill: ["to", "reason"], choices: ["ready", "skipped"] } }));

/**
 * vault.health.summary (R031-80s): the vault's Watchtower findings as ONE calm row, never a row per item: how many need to be rotated and how many to be fixed, counts only. Dismissing it is vault.health.dismiss;
 * the row opens the Vault, where each item is named.
 */
export const fromHealth = (/** @type {any} */ h) => {
  const total = h && Number.isFinite(h.total) ? Number(h.total) : 0;
  if (!total) return [];
  const rotate = Number(h.rotate) || 0, fix = Number(h.fix) || 0;
  const bits = [rotate ? `${rotate} to rotate` : "", fix ? `${fix} to fix` : ""].filter(Boolean).join(", ");
  return [{ id: "vault:health", kind: "health", title: `${total} vault item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention`, detail: bits, at: 0, source: "vault-health",
    facts: { rotate, fix }, answer: { tool: "vault.health.dismiss", input: { days: 7 }, fill: [] },
    answers: [...(rotate ? [{ label: "Rotate", open: "/u/vault" }] : []), ...(fix ? [{ label: "Fix", open: "/u/vault" }] : []), { label: "Dismiss", tool: "vault.health.dismiss", input: { days: 7 }, fill: [] }] }];
};

/**
 * models.evals (R031-87): a new model whose evals the owner has not yet answered. One `eval` card each: what it would cost (from the model's own price, or "cost unknown"), answered by
 * models.eval-approve (all the proposed types; the owner may name fewer) or declined. Nothing runs from the card; approving only queues.
 */
export const fromEvals = rows => rows.filter(r => r && r.state === "pending").map(r => ({
  id: `models:${r.model}`, kind: "eval", title: `New model ${clean(r.label, 60) || clean(r.model, 60)}: run evals?`,
  ...opt("detail", cap(r.price_known && typeof r.total_usd === "number" ? `${(r.types || []).length} evals, about $${r.total_usd.toFixed(2)} in all` : `${(r.types || []).length} evals; the cost is unknown (no price for this model yet)`, DETAIL_MAX)),
  at: at(r.at), source: "models", answer: { tool: "models.eval-approve", input: { model: r.model }, fill: ["evals"] }, decline: { tool: "models.eval-decline", input: { model: r.model } } }));

/**
 * The owners' queues, one row each: the tool that lists what is held, how to read it, and which of the owner's events change it (and what each says happened to which item).
 * @type {{ name: string, tool: string, map: (data: any) => any[], watch: [string, (type: string, payload: any) => ([string, string] | null) | null][] }[]}
 */
export const OWNERS = [
  { name: "threads", tool: "threads.asks", map: d => fromAsks(Array.isArray(d) ? d : []), watch: [
    ["ask.*", (t, p) => (t === "ask.answered" ? [`threads:${p && p.ask}`, one(p && p.decision) || "answered"] : t === "ask.cancelled" ? [`threads:${p && p.ask}`, "cancelled"] : null)]] },
  { name: "gate", tool: "gate.held", map: d => fromHeld(Array.isArray(d) ? d : []), watch: [
    ["gate.*", (t, p) => (t === "gate.released" ? [`gate:${p && p.id}`, "sent"] : t === "gate.rejected" ? [`gate:${p && p.id}`, "refused"] : t === "gate.settled" ? [`gate:${p && p.id}`, one(p && p.outcome) || "sent"] : t === "gate.failed" ? [`gate:${p && p.id}`, "failed"] : null)]] },
  { name: "flows", tool: "flows.attention", map: d => [...fromAttention(d && Array.isArray(d.runs) ? d.runs : []), ...fromStuckTasks(d && Array.isArray(d.tasks) ? d.tasks : [])], watch: [
    ["flow.*", (t, p) => (p && p.run && (t === "flow.finished" || t === "flow.cancelled" || t === "flow.retried") ? [`flows:${p.run}`, t === "flow.cancelled" ? "stopped" : t === "flow.retried" ? "retried" : (p.state === "done" ? "done" : "failed")] : null)],
    ["task.*", (t, p) => (p && p.task ? [`tasks:${p.task}`, t === "task.skipped" ? "skipped" : t === "task.stuck" ? "stuck" : "unblocked"] : null)],
    ["stage.*", (t, p) => (p && p.run && t === "stage.gate-closed" ? [`flows:${p.run}`, "moved on"] : null)]] },
  { name: "vault-health", tool: "vault.health.summary", map: fromHealth, quiet: true, watch: [["vault.item-changed", null], ["vault.item-added", null]] },
  { name: "models", tool: "models.evals", map: d => fromEvals(d && Array.isArray(d.evals) ? d.evals : []), watch: [
    ["models.*", (t, p) => (t === "models.evals-changed" && p && p.model ? [`models:${p.model}`, p.state === "approved" ? "approved" : p.state === "declined" ? "declined" : p.state || "settled"] : null)]] },
  { name: "vault", tool: "vault.pending", map: fromVault, watch: [
    ["vault.granted", null], ["vault.revoked", null], ["vault.reveal-asked", null], ["vault.revealed-to-pass", null], ["vault.agent-granted", null], ["vault.agent-revoked", null], ["grant.*", null], ["pass.*", null], ["person.*", null]] },
];

/**
 * @param {{ call: (tool: string, input?: any) => Promise<any>, on: (pattern: string, fn: (e: any) => void) => (() => void), now: () => number, log?: (m: string) => void, emit?: (type: string, payload: any) => void, extra?: () => any[] }} deps `extra`: the cards this queue holds itself (a yes waiting on the phone), which need no owner
 */
export function createItems({ call, on, now, log = () => {}, emit = () => {}, extra = () => [] }) {
  /** @type {Map<string, any>} */ const open = new Map();
  /** @type {Map<string, any>} */ const recent = new Map();
  /** Outcomes the owners' events told us, until the card they belong to closes. @type {Map<string, string>} */ const hints = new Map();
  /** Owners whose list could not be read now: their cards are left as they were, and named. @type {Set<string>} */ const partial = new Set();
  let said = "", timer = /** @type {any} */ (null), running = /** @type {Promise<void> | null} */ (null), again = false, stopped = false;

  const read = async (/** @type {typeof OWNERS[number]} */ o) => {
    try {
      const r = await call(o.tool, {});
      if (!r || r.error || r.data === undefined || r.data === null) return null;
      return o.map(r.data);
    } catch { return null; }
  };
  const reconcile = async () => {
    const got = await Promise.all(OWNERS.map(read));
    const t = now();
    for (let i = 0; i < OWNERS.length; i++) {
      const o = OWNERS[i], rows = got[i];
      if (rows === null) { if (!(/** @type {any} */ (o)).quiet) partial.add(o.name); continue; }
      partial.delete(o.name);
      const live = new Set(rows.map(r => r.id));
      for (const [id, card] of open) if (card.source === o.name && !live.has(id)) {
        open.delete(id);
        const { facts: _f, ...bare } = card;
        recent.set(id, { ...bare, state: "settled", outcome: hints.get(id) || "settled", settled_at: t });
        hints.delete(id);
      }
      for (const r of rows) open.set(r.id, { ...(open.get(r.id) || {}), ...r, state: "waiting" });
    }
    for (const [id, c] of recent) if (t - c.settled_at > RECENT_MS) recent.delete(id);
    while (recent.size > RECENT_MAX) recent.delete(/** @type {string} */ (recent.keys().next().value));
    for (const id of hints.keys()) if (!open.has(id) && !recent.has(id)) hints.delete(id);
    const own = extra();
    const key = JSON.stringify([...open.keys(), ...own.map(r => r.id)].sort());
    if (key !== said) { said = key; try { emit("approvals.changed", { count: open.size + own.length }); } catch (e) { log(`approvals: could not say approvals.changed: ${/** @type {Error} */ (e).message}`); } }
  };
  const refresh = async () => {
    if (running) { again = true; return running; }
    running = (async () => { do { again = false; await reconcile(); } while (again && !stopped); })();
    try { await running; } finally { running = null; }
  };
  const schedule = () => { if (stopped || timer) return; timer = setTimeout(() => { timer = null; refresh().catch(() => {}); }, DEBOUNCE_MS); timer.unref?.(); };

  const offs = [];
  for (const o of OWNERS) for (const [pattern, hint] of o.watch) offs.push(on(pattern, e => {
    const h = hint ? hint(e.type, e.payload) : null;
    if (h) hints.set(h[0], h[1]);
    schedule();
  }));

  return {
    /** Everything waiting now, oldest owner first as the owners hold it; `recent` the settled ones with what became of them. */
    async list() {
      if (timer) { clearTimeout(timer); timer = null; }
      await refresh();
      return { items: [...extra(), ...open.values()], recent: [...recent.values()], ...(partial.size ? { partial: [...partial] } : {}) };
    },
    start() { schedule(); },
    /** Something this queue holds itself changed (a card was held, answered or ended): say so after the owners' own changes are read too. */
    touch() { schedule(); },
    async stop() { stopped = true; for (const off of offs) off(); if (timer) clearTimeout(timer); try { if (running) await running; } catch { /* stopping */ } },
  };
}
