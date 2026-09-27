// @ts-check
// `vyre needs`: everything waiting on the person, in one list. The same two sources as the Deck's
// Needs (deck/js/needs.js): drafts held at the Gate (gate.held) and open asks from sessions
// (threads.asks), a permission or a question. Newest first here, since a terminal reads from the
// bottom of what it just printed up; each row ends with the exact command that acts on it.
//
// Ids are shown as their first 8 characters. `vyre gate` and `vyre threads answer` take any
// unique start of an id, so the short one is enough to type.

import { call } from "../../daemon/client.js";
import { out, dim, bold, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";
import { up } from "./projects.js";

export const id8 = s => String(s || "").slice(0, 8);
export const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
/** How long ago, short: 4m, 2h, 3d. */
export const age = (t, now = Date.now()) => {
  if (!t) return "";
  const s = Math.max(0, (now - t) / 1000);
  return s < 3600 ? Math.max(1, Math.round(s / 60)) + "m" : s < 86400 ? Math.round(s / 3600) + "h" : Math.round(s / 86400) + "d";
};

/**
 * @typedef {{ id: string, short: string, kind: "draft"|"permission"|"question", at: number, age: string,
 *   project: string|null, thread: string|null, thread_name: string|null, agent: string|null, source: string,
 *   summary: string, next: string }} Need
 */

/** Where a need comes from, as one short phrase: the agent, then the thread, then the project. */
export function sourceOf(/** @type {any} */ x) {
  const bits = [x.agent, x.thread_name || (x.thread ? "thread " + id8(x.thread) : null), x.project].filter(Boolean);
  return bits.length ? bits.join(" · ") : "you";
}

/** The command that acts on one need, typed exactly as it works. */
export function nextFor(/** @type {{ kind: string, id: string }} */ n) {
  const s = id8(n.id);
  if (n.kind === "draft") return `vyre gate show ${s} · vyre gate approve ${s}`;
  if (n.kind === "question") return `vyre threads answer ${s}`;
  return `vyre threads answer ${s} allow|deny`;
}

/**
 * Both lists as one, newest first. Thread names for held drafts come from threads.list, asked
 * only when a draft names a thread (asks carry their own thread_name).
 * @param {{ held: any[], asks: any[], threads?: any[] }} lists
 * @param {number} [now]
 * @returns {Need[]}
 */
export function merge({ held, asks, threads = [] }, now = Date.now()) {
  const names = new Map(threads.map(t => [t.id, t]));
  /** @type {Need[]} */
  const rows = [];
  for (const d of held) {
    const t = d.thread ? names.get(d.thread) : null;
    const to = [d.to].flat().filter(Boolean).join(", ");
    const x = { id: d.id, kind: /** @type {const} */ ("draft"), at: Number(d.at) || 0, project: d.project || (t && t.project) || null, thread: d.thread || null,
      thread_name: (t && t.name) || null, agent: d.agent || (t && t.agent) || null,
      summary: `${d.kind === "send" ? "send" : d.kind} via ${d.via}${to ? " to " + to : ""}${d.summary ? ": " + d.summary : ""}` };
    rows.push({ ...x, short: id8(x.id), age: age(x.at, now), source: sourceOf(x), next: nextFor(x) });
  }
  for (const a of asks) {
    const kind = a.kind === "question" ? "question" : "permission";
    const q = kind === "question" && Array.isArray(a.questions) && a.questions[0] ? a.questions[0].question : "";
    const x = { id: a.id, kind: /** @type {"permission"|"question"} */ (kind), at: Number(a.at) || 0, project: a.project || null, thread: a.thread || null,
      thread_name: a.thread_name || null, agent: a.agent || null,
      summary: kind === "question" ? (q || a.summary || "a question") + (a.questions && a.questions.length > 1 ? ` (+${a.questions.length - 1} more)` : "")
        : `${a.tool}: ${a.summary || ""}${a.destination ? " -> " + a.destination : ""}` };
    rows.push({ ...x, short: id8(x.id), age: age(x.at, now), source: sourceOf(x), next: nextFor(x) });
  }
  return rows.sort((a, b) => b.at - a.at);
}

/** Read both lists from vyred. Returns the rows, or null after printing the error. */
export async function load() {
  const [held, asks] = await Promise.all([call("gate.held", {}), call("threads.asks", {})]);
  // A vyred without one of the modules has nothing held there; any other error is shown.
  const bad = [held, asks].find(r => r.error && r.error.code !== "no_such_tool");
  if (bad) { failTool(bad.error); return null; }
  const h = held.data || [], a = asks.data || [];
  const threads = h.some(d => d.thread) ? (await call("threads.list", { all: true })).data || [] : [];
  return merge({ held: h, asks: a, threads });
}

const LABEL = { draft: "draft", permission: "ask", question: "question" };

/** One need as two lines: what and from where, then the command. */
export function show(/** @type {Need} */ n) {
  out(`  ${beacon(n.short)}  ${String(LABEL[n.kind]).padEnd(8)} ${dim(n.age.padStart(3))}  ${cut(n.summary, 70)}`);
  out(dim(`            ${cut(n.source, 40)} · ${n.next}`));
}

export default {
  name: "needs", order: 10, usage: "vyre needs [--json]",
  summary: "everything waiting on you: held drafts and open asks, newest first, each with the command that answers it",
  help: [
    "One list of what waits on you: drafts held at the Gate and the asks (permissions and questions)",
    "your sessions raised. Each row has a short id, what it is, how long it has waited, where it came",
    "from, and the command to act on it.",
    "",
    "  vyre gate show <id>             a held draft in full",
    "  vyre gate approve|reject <id>   send it, or discard it",
    "  vyre threads answer <id> allow|deny, or --pick N for a question",
  ].join("\n"),
  /** @param {string[]} args */
  async run(args) {
    const extra = args.filter(a => a !== "--json");
    if (extra.length) return usage(`vyre needs takes no arguments (got ${extra[0]})`, "vyre needs, or vyre needs --json");
    if (!(await up())) return 5;
    const rows = await load();
    if (!rows) return 1;
    if (json()) return emit(rows);
    if (!rows.length) { out(dim("  nothing is waiting on you")); return 0; }
    out(`  ${bold(String(rows.length))} waiting on you`);
    rows.forEach(show);
    return 0;
  },
};
