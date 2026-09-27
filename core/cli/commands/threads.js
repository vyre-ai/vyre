// @ts-check
// Headless threads from the terminal: the switchboard's sessions, which vyred owns so they
// outlive every surface. Start one, type into it, watch it work, answer its permission questions.
//
// `vyre threads` already names the session catalogue (./projects.js). This command takes the
// name with a lower order, so the CLI finds it first, and handles only its own subcommands.
// Anything else (no arguments, a search, --project, --all) goes to the catalogue unchanged, so
// `vyre threads harlow` still searches what was said.
//
// The terminal is a surface like the Deck or a phone. It names itself "cli:<pid>" on everything
// that touches the keyboard, so a lease says which terminal holds it and a second terminal is
// told who to take it from.

import { follow as followStream } from "../../resilience/stream.js";
import { open } from "../../resilience/node.js";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { untilde } from "../../config/index.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import catalogue, { parse, up, resume } from "./projects.js";
import { editText, toolError, PURPOSES } from "./sessions.js";
import { json, emit, fail as kitFail, usage } from "../kit.js";

const SURFACE = "cli:" + process.pid;
const SUBS = ["start", "send", "list", "ls", "get", "show", "watch", "lease", "release", "asks", "answer", "stop",
  "interrupt", "mode", "rewind", "fork", "open", "queue", "take-back", "edit", "send-now"];
/** Subcommands whose words are free text (what is sent), so their flags are read by hand. */
const FREE = ["send", "edit"];
/** The permission modes a person can put a session in (threads.mode); bypassPermissions never. */
export const MODES = ["default", "acceptEdits", "plan"];

const id8 = s => String(s || "").slice(0, 8);
/** The flags each subcommand takes; the rest take none. */
const FLAGS = {
  start: { values: ["project", "cwd", "name", "model", "purpose", "provider"], cmd: "threads" },
  get: { values: ["since", "limit"], cmd: "threads" },
  show: { values: ["since", "limit"], cmd: "threads" },
  list: { bool: ["all"], values: ["agent"], cmd: "threads" },
  ls: { bool: ["all"], values: ["agent"], cmd: "threads" },
  answer: { bool: ["always"], multi: ["pick", "answer"], values: ["scope", "message"], cmd: "threads" },
};
// --json: each subcommand prints one line of JSON (the tool's data, or { error }) and nothing
// else, so a script can drive threads without parsing the words meant for a person (kit.js).
const fail = (msg, next) => kitFail(msg, { next });
/**
 * A tool call that prints its own error, in the mode this run is in. A vyred without the tool yet
 * (the sessions verbs, ADR 0030) says so in one line; a person-only change refused from inside a
 * Claude session names where to do it (./sessions.js toolError).
 */
async function tool(name, input) {
  const r = await call(name, input);
  if (r.error) { toolError(r.error, name); return null; }
  return r.data;
}
/**
 * What waits for the turn to end: threads.queue, or, on a vyred without it, rebuilt from the
 * thread's last 1000 events. Null after printing the error.
 * @param {string} thread @returns {Promise<{ rows: any[], fromEvents: boolean } | null>}
 */
async function queueOf(thread) {
  const q = await call("threads.queue", { thread });
  if (!q.error) return { rows: (q.data && q.data.queued) || [], fromEvents: false };
  if (q.error.code !== "no_such_tool") { toolError(q.error, "threads.queue"); return null; }
  const g = await tool("threads.get", { thread, limit: 1000 });
  return g ? { rows: pendingQueue(g.events), fromEvents: true } : null;
}
const cut = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const tail = (s, n) => { const t = String(s || ""); return t.length > n ? "…" + t.slice(t.length - n + 1) : t; };

/** The catalogue command this one stands in front of. Exported so a test can see delegation lands there. */
export function catalogueCommand() {
  const c = catalogue.find(x => x.name === "threads");
  if (!c) throw new Error("projects.js has no threads command to delegate to");
  return c;
}

// ------------------------------------------------------------ the stream, as pure functions

/**
 * Server-sent events from a buffer that may end mid-frame. Frames end at a blank line; what is
 * left after the last one is returned as `rest`, to be prefixed to the next chunk. Lines starting
 * with ":" are comments (vyred's heartbeat). Several data lines join with "\n", as the SSE spec says.
 * @param {string} buffer
 * @returns {{ frames: { id: string|null, event: string|null, data: string }[], rest: string }}
 */
export function parseSSE(buffer) {
  const text = String(buffer).replace(/\r\n?/g, "\n");
  const parts = text.split("\n\n");
  const rest = parts.pop() ?? "";
  const frames = [];
  for (const block of parts) {
    let id = null, event = null;
    const data = [];
    let any = false;
    for (const line of block.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      let value = at === -1 ? "" : line.slice(at + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "id") { id = value; any = true; }
      else if (field === "event") { event = value; any = true; }
      else if (field === "data") { data.push(value); any = true; }
    }
    if (any) frames.push({ id, event, data: data.join("\n") });
  }
  return { frames, rest };
}

/**
 * One event as terminal text, or null when it has nothing to show. Text deltas come back with no
 * newline, so a reply streams in place; every other line ends in one.
 *
 * `streamed` remembers which messages arrived as deltas: their final thread.text repeats the
 * whole reply, so it only ends the line. A message that never streamed (a notice, or history
 * where the deltas fell outside the window) is printed whole. Pass the same Set for a whole
 * watch; left out, each call stands alone.
 * @param {{ type: string, payload?: any }} e
 * @param {Set<string>} [streamed]
 * @returns {string|null}
 */
export function formatEvent(e, streamed = new Set()) {
  const p = (e && e.payload) || {};
  switch (e && e.type) {
    case "thread.text": {
      const key = String(p.message ?? "");
      if (p.delta) { streamed.add(key); return String(p.delta); }
      if (p.done) {
        if (streamed.has(key)) { streamed.delete(key); return "\n"; }
        return p.text ? (p.notice ? dim(String(p.text)) : String(p.text)) + "\n" : null;
      }
      return null;
    }
    case "thread.sent":
      return dim(`  > ${cut(p.text, 200)}${p.surface ? "  (" + p.surface + ")" : ""}`) + "\n";
    case "thread.tool": {
      const what = p.summary || p.name || p.tool || "tool";
      // Sessions on the Agent SDK (ADR 0030) send one call re-emitted with a status; a call is
      // shown when it starts, and again only if it failed.
      if (p.status) {
        const key = "tool:" + String(p.call ?? what);
        if (p.status === "running") { if (streamed.has(key)) return null; streamed.add(key); return dim(`  · ${what}`) + "\n"; }
        streamed.delete(key);
        return p.status === "failed" ? dim(`  · ${what} failed`) + "\n" : null;
      }
      return p.phase === "started" ? dim(`  · ${what}`) + "\n" : null;
    }
    case "thread.turn":
      return dim(`  turn ${String(p.turn ?? "").split(":").pop() || ""}`.trimEnd()) + "\n";
    case "thread.steered":
      return dim(`  > joined the running turn: ${cut(p.text, 160)}`) + "\n";
    case "thread.queued":
      return dim(`  ${p.edited ? "changed" : "queued"}${p.queued != null ? " " + p.queued : ""}: ${cut(p.text, 160)}`) + "\n";
    case "thread.unqueued":
      return dim(`  took back${p.queued != null ? " " + p.queued : ""}${p.text ? ": " + cut(p.text, 120) : ""}`) + "\n";
    case "thread.usage": {
      const u = usageLine(p);
      return u ? dim(`  ${u}`) + "\n" : null;
    }
    case "thread.state":
      // running and idle are what sent and done already say; the rest is news.
      if (p.state === "failed") return beacon(`  failed${p.error ? ": " + cut(typeof p.error === "string" ? p.error : p.error.message, 160) : ""}`) + "\n";
      return p.state && !["running", "idle", "working"].includes(p.state) ? dim(`  ${p.state}`) + "\n" : null;
    case "thread.limit":
      return p.note || p.text ? beacon(`  ${cut(p.note || p.text, 200)}`) + "\n" : null;
    case "mode.changed":
      return dim(`  mode: ${p.mode}`) + "\n";
    case "ask.cancelled":
      return dim(`  ask ${p.ask} cancelled`) + "\n";
    case "ask.raised": {
      const where = p.destination ? ` -> ${p.destination}` : "";
      return beacon(`  ? ask ${p.ask}  ${p.tool}: ${p.summary || ""}${where}`) + "\n"
        + dim(`    vyre threads answer ${p.ask}${p.kind === "question" ? "" : " allow|deny"}`) + "\n";
    }
    case "ask.answered":
      return dim(`  ask ${p.ask} ${p.decision}${p.by ? " by " + p.by : ""}`) + "\n";
    case "lease.changed":
      return dim(`  keyboard: ${p.holder || "free"}`) + "\n";
    case "thread.finished": {
      const usd = typeof p.cost_usd === "number" ? p.cost_usd : typeof p.cost === "number" ? p.cost : null;
      const cost = usd === null ? "" : `$${usd.toFixed(4)}`;
      const how = p.canceled ? "interrupted" : p.ok === false || (p.error && p.ok !== true) ? "failed" : "done";
      const bits = [how, cost, p.error ? cut(typeof p.error === "string" ? p.error : p.error.message || p.message, 120) : ""].filter(Boolean);
      return dim(`  ${bits.join(" · ")}`) + "\n";
    }
    case "thread.started":
      return dim(`  started${p.resumed ? " (resumed)" : ""}${p.cwd ? " · " + p.cwd : ""}`) + "\n";
    case "thread.stopped":
      return dim(`  stopped${p.reason ? " · " + p.reason : ""}`) + "\n";
    default:
      return null;
  }
}

/**
 * thread.usage as a few words: tokens in and out, cost, how full the context is. The payload's
 * shape is the driver's, so each part is read if it is there and left out if not.
 * @param {any} p
 */
export function usageLine(p) {
  const n = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const k = v => (v >= 10_000 ? Math.round(v / 1000) + "k" : String(v));
  const t = p.tokens && typeof p.tokens === "object" ? p.tokens : p;
  const inp = n(t.input ?? t.input_tokens), outp = n(t.output ?? t.output_tokens);
  const bits = [];
  if (inp !== null || outp !== null) bits.push(`${inp !== null ? k(inp) : "?"} in, ${outp !== null ? k(outp) : "?"} out`);
  else if (n(p.tokens) !== null) bits.push(`${k(p.tokens)} tokens`);
  const usd = n(p.cost_usd ?? p.cost), total = n(p.total_cost_usd);
  if (usd !== null) bits.push(`$${usd.toFixed(4)}${total !== null && total !== usd ? ` ($${total.toFixed(4)} so far)` : ""}`);
  else if (total !== null) bits.push(`$${total.toFixed(4)} so far`);
  const c = p.context;
  if (c && typeof c === "object" && n(c.used) !== null && n(c.max)) bits.push(`context ${Math.round(c.used / c.max * 100)}%`);
  else if (n(c) !== null) bits.push(`context ${c <= 1 ? Math.round(c * 100) : Math.round(c)}%`);
  return bits.length ? bits.join(" · ") : null;
}

/**
 * What is queued for a thread and not yet handed over, from its events: thread.queued adds one,
 * thread.sent with that queued id (handed over), thread.unqueued (taken back) or a steer of it
 * remove it, and a later thread.queued with the same id (edited: true) changes its text.
 * @param {{ type: string, id?: number, at?: number, payload?: any }[]} events
 * @returns {{ queued: number|string, text: string, surface: string|null, at: number|null }[]}
 */
export function pendingQueue(events) {
  const q = new Map();
  for (const e of events || []) {
    const p = e.payload || {};
    if (p.queued == null) continue;
    const k = String(p.queued);
    if (e.type === "thread.queued") q.set(k, { queued: p.queued, text: String(p.text || ""), surface: p.surface || null, at: e.at ?? null });
    else if (e.type === "thread.edited" && q.has(k)) q.get(k).text = String(p.text || "");
    else if (["thread.sent", "thread.unqueued", "thread.steered"].includes(e.type)) q.delete(k);
  }
  return [...q.values()];
}

/**
 * The reconnect waits for a watch: 1 s, 2 s, 5 s, then up to 30 s, back to 1 s once the stream
 * is open again (ADR 0029 R3, tuned for a person looking at a terminal). No jitter: one terminal.
 * @returns {{ delay(): number, reset(): void }}
 */
export function watchBackoff(steps = [1000, 2000, 5000, 10_000, 20_000, 30_000]) {
  let i = 0;
  return { delay() { const d = steps[Math.min(i, steps.length - 1)]; i++; return d; }, reset() { i = 0; } };
}

// ------------------------------------------------------------ finding threads and asks

/**
 * A thread id from a full id or a unique prefix of 4 or more characters. Prefixes are resolved
 * against every thread, not just recent ones, so an old id typed from a log still works.
 * @returns {Promise<{ id: string } | { error: string }>}
 */
async function resolveThread(ref) {
  const q = String(ref || "").trim().toLowerCase();
  if (!q) return { error: "which thread? give its id or the first 4+ characters of it", usage: true };
  if (q.length < 4) return { error: `"${q}" is too short: give at least 4 characters of the id`, usage: true };
  const r = await call("threads.list", { all: true });
  if (r.error) return { error: r.error.message };
  const rows = /** @type {any[]} */ (r.data || []);
  if (rows.some(t => t.id === q)) return { id: q };
  const hits = rows.filter(t => String(t.id).startsWith(q));
  if (hits.length === 1) return { id: hits[0].id };
  if (hits.length > 1) return { error: `${hits.length} threads start with "${q}": ${hits.slice(0, 4).map(t => id8(t.id)).join(", ")}` };
  // Not in the list (it caps at 200): hand the ref over as is and let vyred say whether it exists.
  return { id: q };
}

/** A thread or ask that could not be found, or was not given. */
function missed(f) {
  const next = /ask/.test(f.error) ? "vyre threads asks lists the open ones" : "vyre threads list shows them";
  return f.usage ? usage(f.error, next) : fail(f.error, next);
}

/** An ask id, or a unique prefix of an open one: the ids are long, and people type them. */
async function resolveAsk(ref) {
  const q = String(ref || "").trim().toLowerCase();
  if (!q) return { error: "which ask? give its id or the start of it", usage: true };
  const r = await call("threads.asks", {});
  if (r.error) return { error: r.error.message };
  const hits = /** @type {any[]} */ (r.data || []).filter(a => String(a.id).startsWith(q));
  const exact = hits.find(a => a.id === q);
  if (exact) return { id: q, ask: exact };
  if (hits.length === 1) return { id: hits[0].id, ask: hits[0] };
  if (hits.length > 1) return { error: `${hits.length} open asks start with "${q}"` };
  return { id: q };
}

// ------------------------------------------------------------ answering a question

/**
 * One question's answer from what was typed: option numbers ("2", "1,3"), option labels (any
 * case), or free text, which is the "Other" answer. Multi-select joins labels in option order,
 * typed text last, with ", ", as the Deck's card does (deck/chat/lib/answers.js); single-select
 * takes one. Returns the answer, or throws saying what is wrong.
 * @param {{ question: string, header?: string, multiSelect?: boolean, options?: { label: string }[] }} q
 * @param {string} typed
 */
export function answerFor(q, typed) {
  const opts = Array.isArray(q.options) ? q.options : [];
  const raw = String(typed || "").trim();
  if (!raw) throw new Error(`"${q.header || q.question}" has no answer`);
  const one = s => {
    const t = s.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (n < 1 || n > opts.length) throw new Error(`"${q.header || q.question}" has options 1 to ${opts.length}; ${t} is not one`);
      return { label: opts[n - 1].label };
    }
    const hit = opts.find(o => o.label.toLowerCase() === t.toLowerCase());
    return hit ? { label: hit.label } : { text: t };
  };
  if (!q.multiSelect) {
    const whole = one(raw);
    // "1,3" on a single-select is a mistake, not the text "1,3".
    if ("text" in whole && /^\d+(\s*,\s*\d+)+$/.test(raw)) throw new Error(`"${q.header || q.question}" takes one answer`);
    return whole.label ?? whole.text;
  }
  const parts = raw.split(",").map(one);
  const labels = new Set(parts.filter(p => p.label).map(p => p.label));
  const text = parts.filter(p => p.text).map(p => p.text).join(", ");
  return [...opts.map(o => o.label).filter(l => labels.has(l)), ...(text ? [text] : [])].join(", ");
}

/**
 * threads.answer's `answers` ({ [question text]: answer }) from --pick (one per question, in
 * order) and --answer "Q=choice" (Q is the question, its header, or its number). Questions still
 * without an answer are returned in `missing`, for the picker or the error.
 * @param {any[]} questions @param {{ pick?: string[], answer?: string[] }} given
 */
export function answersFrom(questions, { pick = [], answer = [] } = {}) {
  /** @type {Record<string, string>} */
  const answers = {};
  if (pick.length > questions.length) throw new Error(`${pick.length} picks for ${questions.length} question${questions.length === 1 ? "" : "s"}`);
  pick.forEach((p, i) => {
    if (!/^\s*\d+(\s*,\s*\d+)*\s*$/.test(p)) throw new Error(`--pick takes option numbers (2, or 1,3); use --answer for words`);
    answers[questions[i].question] = answerFor(questions[i], p);
  });
  for (const a of answer) {
    const at = String(a).indexOf("=");
    // Only one question: "--answer Warm crust" needs no "Q=".
    const [key, value] = at < 0 ? (questions.length === 1 ? ["1", a] : [null, a]) : [String(a).slice(0, at).trim(), String(a).slice(at + 1)];
    if (key === null) throw new Error(`--answer takes "question=answer" when there are several questions`);
    const k = key.toLowerCase();
    const q = /^\d+$/.test(key) ? questions[Number(key) - 1]
      : questions.find(x => x.question.toLowerCase() === k) || questions.find(x => (x.header || "").toLowerCase() === k)
        || questions.find(x => x.question.toLowerCase().startsWith(k));
    if (!q) throw new Error(`no question matches "${key}"`);
    answers[q.question] = answerFor(q, value);
  }
  return { answers, missing: questions.filter(q => !(q.question in answers)) };
}

/** The ask as a person reads it before answering: who asks, and what. */
function showAsk(a) {
  const who = a.agent || a.thread_name || (a.thread ? "thread " + id8(a.thread) : "a session");
  if (a.kind === "question") {
    out(`  ${bold(who + " asks")}  ${dim(id8(a.id))}`);
    (a.questions || []).forEach((q, i) => {
      out(`  ${a.questions.length > 1 ? dim(i + 1 + ". ") : ""}${q.header ? dim("[" + q.header + "] ") : ""}${q.question}${q.multiSelect ? dim("  (pick any)") : ""}`);
      (q.options || []).forEach((o, n) => out(`     ${beacon(String(n + 1))}  ${o.label}${o.description ? dim("  " + cut(o.description, 80)) : ""}`));
      out(dim(`     or type your own answer`));
    });
    return;
  }
  out(`  ${bold(`${who} asks to run ${a.tool}`)}  ${dim(id8(a.id))}`);
  out(`  ${cut(a.summary, 200)}${a.destination ? dim(" -> " + a.destination) : ""}`);
  const d = a.detail || {};
  for (const k of ["description", "file", "url"]) if (d[k] && !String(a.summary).includes(d[k])) out(dim(`  ${k}: ${cut(d[k], 200)}`));
  if (a.reason) out(dim(`  ${cut(a.reason, 200)}`));
  if (a.always) out(dim(`  always is on offer${a.always_project ? " (--scope project: only in " + a.always_project + ")" : ""}`));
}

/** One line typed at this terminal. Prompts go to stderr, so --json output stays clean. */
async function ask(text) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try { return await new Promise(resolve => rl.question(text, resolve)); } finally { rl.close(); }
}

/**
 * Ask each missing question at the terminal until it has an answer. `prompt` is the line reader
 * (a test gives its own).
 * @param {any[]} missing @param {Record<string, string>} answers @param {(text: string) => Promise<string>} [prompt]
 */
export async function pickAnswers(missing, answers, prompt = ask) {
  for (const q of missing) {
    for (;;) {
      const typed = await prompt(`  ${q.header || cut(q.question, 40)}${q.multiSelect ? " (numbers, comma separated)" : ""}: `);
      try { answers[q.question] = answerFor(q, typed); break; }
      catch (e) { process.stderr.write(`  ${/** @type {Error} */ (e).message}\n`); }
    }
  }
  return answers;
}

// ------------------------------------------------------------ watching

/**
 * Print the thread's recent history, then stream what happens next until it stops or Ctrl-C.
 * Resolves to an exit code.
 */
async function watch(id) {
  // Ctrl-C while the history loads ends the watch quietly, as it does once streaming.
  const early = () => process.exit(0);
  process.once("SIGINT", early);
  const g = await tool("threads.get", { thread: id, limit: 100 });
  process.off("SIGINT", early);
  if (!g) return 1;
  const t = g.thread;
  out(`  ${bold(t.name || tail(t.cwd, 40))}  ${dim([id8(t.id), t.status, t.holder ? "keyboard: " + t.holder : "", t.agent || ""].filter(Boolean).join(" · "))}`);
  const streamed = new Set();
  let midline = false;
  const show = e => {
    const s = formatEvent(e, streamed);
    if (s == null) return;
    const inline = e.type === "thread.text" && Boolean(e.payload && e.payload.delta);
    if (midline && !inline && s !== "\n") process.stdout.write("\n");
    process.stdout.write(s);
    midline = !s.endsWith("\n");
  };
  let since = 0;
  for (const e of g.events) { show(e); since = Math.max(since, Number(e.id) || 0); }
  for (const a of g.asks || []) {
    // An open ask whose ask.raised fell outside the window still needs answering.
    if (!g.events.some(e => e.type === "ask.raised" && e.payload && e.payload.ask === a.id)) show({ type: "ask.raised", payload: { ask: a.id, ...a } });
  }
  if (t.status === "stopped") { out(dim("  the thread is stopped · vyre threads send resumes it")); }

  // Followed with the resilient client (ADR 0029): a dropped stream or a vyred restart is a
  // quiet "reconnecting" line, a wait of 1 s, 2 s, 5 s up to 30 s, and a replay from the last
  // event id (sent as Last-Event-ID), not the end of the watch. Nothing polls: the stream pushes.
  // An event at or below the last one shown is dropped here too, so a replay never prints twice.
  return new Promise(resolve => {
    let done = false, away = false;
    const finish = code => {
      if (done) return;
      done = true;
      process.off("SIGINT", onInt);
      if (midline) process.stdout.write("\n");
      stream.stop();
      resolve(code);
    };
    const onInt = () => finish(0);
    process.on("SIGINT", onInt);
    const say = s => { if (midline) { process.stdout.write("\n"); midline = false; } out(s); };
    const stream = followStream({ paths: ["unix:" + config.paths().socket], open, cursor: since, headers: { "x-vyre-caller": "cli" },
      backoff: watchBackoff(),
      onEvent: e => {
        // Stream events carry the thread at the top; the payload has it too, as a fallback.
        if ((e.thread ?? (e.payload && e.payload.thread)) !== id) return;
        const n = Number(e.id);
        if (Number.isFinite(n)) { if (n <= since) return; since = n; }
        show(e);
        // A session closed for idleness or by a vyred restart comes back on the next message
        // (ADR 0030), so the watch stays; a stop someone asked for ends it.
        if (e.type === "thread.stopped" && !["idle", "restart"].includes(e.payload && e.payload.reason)) finish(0);
      },
      onState: st => {
        if (st.state === "reconnecting" && !away) { away = true; say(dim("  reconnecting to vyred…")); }
        else if (st.state === "open" && away) { away = false; say(dim("  back")); }
      } });
  });
}

// ------------------------------------------------------------ subcommands

function row(t) {
  const label = t.name ? cut(t.name, 36) : tail(t.cwd, 36);
  const status = t.status === "waiting" ? beacon(t.status.padEnd(8)) : t.status === "working" ? signal(t.status.padEnd(8)) : dim(String(t.status).padEnd(8));
  const asks = t.asks ? beacon(`  ${t.asks} ask${t.asks === 1 ? "" : "s"}`) : "";
  out(`  ${dim(id8(t.id))}  ${status} ${dim(String(t.holder || "-").padEnd(14))} ${label.padEnd(36)} ${dim(t.agent || "")}${asks}`);
}

/** @type {Record<string, (args: string[]) => Promise<number>>} */
const run = {
  async start(args) {
    const { flags, pos } = parse(args, FLAGS.start);
    const input = { surface: SURFACE };
    if (flags.project) input.project = flags.project;
    // The daemon resolves paths against its own folder, so the terminal's folder is sent absolute.
    if (flags.cwd) input.cwd = path.resolve(untilde(flags.cwd));
    else if (!flags.project) input.cwd = process.cwd();
    if (flags.name) input.name = flags.name;
    if (flags.model) input.model = flags.model;
    if (flags.purpose) input.purpose = flags.purpose;
    if (flags.provider) input.provider = flags.provider;
    if (pos.length) input.prompt = pos.join(" ");
    const t = await tool("threads.start", input);
    if (!t) return 1;
    if (json()) { emit(t); return 0; }
    out(`  ${signal("started")} ${t.id}  ${dim([t.name, t.project, tail(t.cwd, 40)].filter(Boolean).join(" · "))}`);
    out(dim(`  vyre threads watch ${id8(t.id)}`));
    return 0;
  },

  async send(args) {
    const { how, ref, words } = sendArgs(args);
    if (how === "both") return usage("--queue and --steer disagree: pick one", "vyre help threads");
    if (!ref || !words.length) return usage("vyre threads send <thread> [--queue|--steer] <text>", "vyre threads list shows the threads");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    // No flag: vyred decides (a running turn of a session it owns is steered, ADR 0030).
    // One key for this send: a retry after a dropped answer returns {already:true} and never
    // starts a second turn (ADR 0029 R2), so a lost reply is retried once.
    const input = { thread: f.id, text: words.join(" "), surface: SURFACE, ...(how ? { mode: how } : {}) };
    const opts = { headers: { "idempotency-key": crypto.randomUUID() } };
    let sent = await call("threads.send", input, opts);
    if (sent.error && ["unreachable", "timeout"].includes(sent.error.code)) sent = await call("threads.send", input, opts);
    if (sent.error) { toolError(sent.error, "threads.send"); return 1; }
    const r = sent.data;
    if (json()) { emit(r); return r.sent || r.queued || r.already ? 0 : 1; }
    if (r.already) { out(dim("  already sent (a retry of the same message)")); return 0; }
    const qid = queuedId(r);
    if (r.queued) {
      // Held until the turn ends (a terminal session always queues): it can still be changed.
      out(dim(`  queued${qid != null ? " " + qid : ""}${r.note ? " · " + r.note : ""}`));
      if (qid != null) out(dim(`  vyre threads take-back ${id8(f.id)} ${qid} · edit ${id8(f.id)} ${qid} · send-now ${id8(f.id)} ${qid}`));
      return 0;
    }
    if (r.sent) { out(dim(`  ${r.steered || r.mode === "steer" ? "sent into the running turn" : "sent"} · vyre threads watch ${id8(f.id)}`)); return 0; }
    if (r.holder) {
      out(beacon(`  ${r.holder} has the keyboard`));
      out(dim(`  vyre threads lease ${id8(f.id)}`));
    } else fail(`not sent${r.note ? ": " + r.note : ""}`, `vyre threads watch ${id8(f.id)} shows what it is doing`);
    return 1;
  },

  async list(args) {
    const { flags } = parse(args, FLAGS.list);
    const ts = await tool("threads.list", { ...(flags.agent ? { agent: flags.agent } : {}), ...(flags.all ? { all: true } : {}) });
    if (!ts) return 1;
    if (json()) { emit(ts); return 0; }
    if (!ts.length) { out(dim("  no headless threads in the last day · vyre threads start, or --all")); return 0; }
    ts.forEach(row);
    return 0;
  },

  async watch(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    if (json()) { const g = await tool("threads.get", { thread: f.id, limit: 100 }); if (!g) return 1; emit(g); return 0; }
    return watch(f.id);
  },

  /** One read of a thread, then back to the prompt: its record, open asks, and events (--since, --limit). */
  async get(args) {
    const { flags, pos } = parse(args, FLAGS.get);
    const f = await resolveThread(pos[0]);
    if ("error" in f) return missed(f);
    for (const k of ["since", "limit"]) if (flags[k] !== undefined && !/^\d+$/.test(flags[k])) return usage(`--${k} takes a whole number`, "vyre help threads");
    const g = await tool("threads.get", { thread: f.id, limit: flags.limit ? Number(flags.limit) : 100, ...(flags.since ? { since: Number(flags.since) } : {}) });
    if (!g) return 1;
    if (json()) { emit(g); return 0; }
    const t = g.thread;
    out(`  ${bold(t.name || tail(t.cwd, 40))}  ${dim([id8(t.id), t.status, t.model, t.holder ? "keyboard: " + t.holder : "", t.agent || ""].filter(Boolean).join(" · "))}`);
    const streamed = new Set();
    let midline = false;
    for (const e of g.events || []) {
      const s = formatEvent(e, streamed);
      if (s == null) continue;
      process.stdout.write(s);
      midline = !s.endsWith("\n");
    }
    if (midline) process.stdout.write("\n");
    for (const a of g.asks || []) if (!(g.events || []).some(e => e.type === "ask.raised" && e.payload && e.payload.ask === a.id)) process.stdout.write(formatEvent({ type: "ask.raised", payload: { ask: a.id, ...a } }) || "");
    const last = (g.events || []).at(-1);
    out(dim(`  vyre threads watch ${id8(t.id)} follows it${last ? ` · --since ${last.id} reads only what comes after` : ""}`));
    return 0;
  },

  async interrupt(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const r = await tool("threads.interrupt", { thread: f.id });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(r.interrupted ? `  interrupted ${dim(id8(f.id) + " · the session stays; vyre threads send goes on")}` : dim(`  ${r.note || "nothing to interrupt"}`));
    return 0;
  },

  /** `mode <thread>` says the mode; `mode <thread> <mode>` sets it (the person's own act). */
  async mode(args) {
    const [ref, want] = args;
    if (args.length > 2) return usage(`vyre threads mode <thread> [${MODES.join("|")}]`);
    if (want && !MODES.includes(want)) return usage(`the modes are ${MODES.join(", ")}`, "vyre help threads");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    if (!want) {
      const g = await tool("threads.get", { thread: f.id, limit: 1000 });
      if (!g) return 1;
      const last = (g.events || []).filter(e => e.type === "mode.changed").at(-1);
      const mode = g.thread.mode || (last && last.payload.mode) || "default";
      if (json()) { emit({ thread: f.id, mode }); return 0; }
      out(`  mode: ${signal(mode)} ${dim(`· vyre threads mode ${id8(f.id)} ${MODES.join("|")}`)}`);
      return 0;
    }
    const r = await tool("threads.mode", { thread: f.id, mode: want });
    if (!r) return 1;
    if (json()) { emit(r); return r.mode ? 0 : 1; }
    if (!r.mode) return kitFail(r.note || "the mode did not change", { next: `vyre threads send ${id8(f.id)} <text> starts it; then set the mode` });
    out(`  mode: ${signal(r.mode)} ${dim(id8(f.id))}`);
    return 0;
  },

  async rewind(args) {
    const [ref, uuid] = args;
    if (!ref || !uuid) return usage("vyre threads rewind <thread> <message uuid>", "vyre threads get <thread> --json shows each turn's uuid");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    const r = await tool("threads.rewind", { thread: f.id, uuid });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(`  ${signal("rewound")} ${dim(`${id8(f.id)} to ${id8(uuid)}${r.text ? " · " + cut(r.text, 80) : ""}${r.note ? " · " + r.note : ""}`)}`);
    return 0;
  },

  /** A new session from this one's history, optionally with a first prompt (threads.fork). */
  async fork(args) {
    const [ref, ...words] = args;
    if (!ref) return usage("vyre threads fork <thread> [prompt]");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    const prompt = words.join(" ");
    const r = await tool("threads.fork", { thread: f.id, ...(prompt ? { prompt } : {}) });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    const id = r.thread || r.id;
    out(`  ${signal("forked")} ${dim(`${id8(f.id)} → ${id ? id8(String(id)) : "a new session"}`)}`);
    if (id) out(dim(`  vyre threads watch ${id8(String(id))} follows it`));
    return 0;
  },

  /** Open the thread in `claude` in this terminal, where it ran (vyre resume hands it over). */
  async open(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const g = await tool("threads.get", { thread: f.id, limit: 1 });
    if (!g) return 1;
    const t = g.thread;
    const label = t.name || id8(t.id);
    // One transcript takes one writer. Mid-turn it is left alone; idle, vyred lets go of it first.
    if (["working", "waiting", "starting", "running"].includes(t.status)) {
      return kitFail(`${label} is ${t.status === "waiting" ? "waiting on a question" : "in the middle of a turn"} in vyred`,
        { next: `let it finish, or stop the turn: vyre threads interrupt ${id8(t.id)}` });
    }
    if (t.status === "idle") {
      const r = await tool("threads.stop", { thread: t.id });
      if (!r) return 1;
      out(dim("  handed over from vyred; a message from the Deck or the Capsule brings it back there once you exit"));
    }
    return resume({ id: t.id, cwd: t.cwd, label }, { project: t.project || undefined });
  },

  async queue(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const list = await queueOf(f.id);
    if (!list) return 1;
    if (json()) { emit(list.rows); return 0; }
    if (!list.rows.length) { out(dim("  nothing is queued")); return 0; }
    for (const q of list.rows) out(`  ${beacon(String(q.queued))}  ${cut(q.text, 90)}${q.surface ? dim("  " + q.surface) : ""}`);
    out(dim(`  ${list.fromEvents ? "from the thread's last 1000 events · " : ""}take-back, edit or send-now <thread> <queued>`));
    return 0;
  },

  async "take-back"(args) { return queued(args, "take-back", "threads.unqueue", "taken back"); },
  async "send-now"(args) { return queued(args, "send-now", "threads.send-now", "sent now"); },

  async edit(args) {
    const [ref, qid, ...words] = args;
    if (!ref || !qid) return usage("vyre threads edit <thread> <queued> [text]", "vyre threads queue <thread> lists what is queued");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    let text = words.join(" ");
    if (!text) {
      if (json()) return usage("vyre threads edit needs the new text with --json");
      const list = await queueOf(f.id);
      if (!list) return 1;
      const was = list.rows.find(q => String(q.queued) === qid);
      let edited;
      try { edited = editText(was ? was.text : "", "message.md"); } catch (e) { return kitFail(/** @type {Error} */ (e).message); }
      if (edited === null) return usage("no editor here (set $EDITOR), or give the new text", "vyre help threads");
      if (!edited.trim() || (was && edited === was.text)) { out(dim("  nothing changed")); return 0; }
      text = edited;
    }
    const r = await tool("threads.edit", { thread: f.id, queued: queuedArg(qid), text });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(`  ${signal("changed")} ${dim(`queued ${qid} · handed over when the turn ends`)}`);
    return 0;
  },

  async lease(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const r = await tool("threads.lease", { thread: f.id, surface: SURFACE });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(`  keyboard: ${signal(r.holder)}${r.previous && r.previous !== r.holder ? dim(` · taken from ${r.previous}`) : ""}`);
    return 0;
  },

  async release(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const r = await tool("threads.release", { thread: f.id, surface: SURFACE });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(r.released ? "  keyboard released" : dim(`  this terminal did not hold it${r.holder ? " · " + r.holder + " does" : ""}`));
    return 0;
  },

  async asks(args) {
    let input = {};
    if (args[0]) {
      const f = await resolveThread(args[0]);
      if ("error" in f) return missed(f);
      input = { thread: f.id };
    }
    const list = await tool("threads.asks", input);
    if (!list) return 1;
    if (json()) { emit(list); return 0; }
    if (!list.length) { out(dim("  nothing is waiting on you")); return 0; }
    for (const a of list) {
      out(`  ${beacon(a.id)}  ${dim(id8(a.thread))}  ${a.tool}: ${cut(a.summary, 60)}${a.destination ? dim(" -> " + a.destination) : ""}`);
      if (a.reason) out(dim(`    ${cut(a.reason, 90)}`));
    }
    out(dim("  vyre threads answer <ask> allow|deny [message] · a question: --pick N, or no answer to be asked"));
    return 0;
  },

  async answer(args) {
    const { flags, pos } = parse(args, FLAGS.answer);
    const [ref, word, ...words] = pos;
    const decisionWord = ["allow", "deny", "always"].includes(word) ? word : null;
    // Without a decision word, what follows the ask is the message only if a decision came by flag.
    const message = (decisionWord ? words : word !== undefined ? [word, ...words] : []).join(" ") || flags.message;
    if (!ref) return usage("vyre threads answer <ask> allow|deny|always [message] [--scope project] [--pick N] [--answer \"Q=choice\"]", "vyre threads asks lists the open ones");
    const f = await resolveAsk(ref);
    if ("error" in f) return missed(f);
    const a = f.ask;
    const interactive = Boolean(process.stdin.isTTY) && !json();
    let decision = flags.always ? "always" : decisionWord;
    if (flags.always && decisionWord && decisionWord !== "always") return usage(`--always and ${decisionWord} disagree`);
    if (flags.scope && flags.scope !== "project") return usage("--scope takes project", "vyre help threads");
    if (word !== undefined && !decisionWord && !flags.always && !(a && a.kind === "question")) return usage("vyre threads answer <ask> allow|deny|always [message]", "vyre threads asks lists the open ones");
    if (!json() && a) showAsk(a);
    /** @type {Record<string, any>} */
    const input = { ask: f.id, surface: SURFACE };

    if (a && a.kind === "question") {
      if (decision === "always" || flags.scope) return usage("always and --scope are for permissions; a question is answered or declined (deny)");
      if (decision === "deny") Object.assign(input, { decision: "deny" });
      else {
        // Free words after the ask answer a question with one question: `answer <id> Warm crust`.
        const given = { pick: flags.pick || [], answer: [...(flags.answer || []), ...(!decisionWord && word !== undefined ? [[word, ...words].join(" ")] : [])] };
        let got;
        try { got = answersFrom(a.questions || [], given); } catch (e) { return usage(/** @type {Error} */ (e).message, `vyre threads answer ${id8(f.id)} --pick N`); }
        if (got.missing.length) {
          if (!interactive) return usage(`${got.missing.length === 1 ? "a question has" : got.missing.length + " questions have"} no answer: ${got.missing.map(q => q.header || cut(q.question, 40)).join(", ")}`,
            `vyre threads answer ${id8(f.id)} --pick N (one per question), or --answer "Q=choice"; deny declines`);
          await pickAnswers(got.missing, got.answers);
        }
        Object.assign(input, { decision: "allow", answers: got.answers });
      }
      if (decision === "deny" && message) input.message = message;
    } else {
      if (!decision && interactive && a) {
        const offer = a.always ? "[y]es once, [a]lways, [n]o" : "[y]es once, [n]o";
        for (;;) {
          const t = (await ask(`  Allow? ${offer}: `)).trim().toLowerCase();
          if (t === "y" || t === "yes") { decision = "allow"; break; }
          if (t === "n" || t === "no") { decision = "deny"; break; }
          if (a.always && (t === "a" || t === "always")) { decision = "always"; break; }
        }
      }
      if (!decision) return usage("vyre threads answer <ask> allow|deny|always [message]", "vyre threads asks lists the open ones");
      if (flags.scope && decision !== "always") return usage("--scope project goes with always");
      // Said here, before vyred refuses it, with the reason in words.
      if (a && decision === "always" && !a.always) return fail("this ask offers no always; answer allow or deny", `vyre threads answer ${id8(f.id)} allow`);
      if (a && flags.scope && !a.always_project) return fail("this ask offers no always for one project", `vyre threads answer ${id8(f.id)} always`);
      Object.assign(input, { decision, ...(flags.scope ? { scope: flags.scope } : {}), ...(message ? { message } : {}) });
    }

    const r = await tool("threads.answer", input);
    if (!r) return 1;
    if (json()) { emit(r); return r.answered ? 0 : 1; }
    if (r.answered) {
      const said = input.answers ? "answered" : input.decision === "deny" ? "denied" : input.decision === "always" ? "always allowed" : "allowed";
      out(`  ${input.decision === "deny" ? beacon(said) : signal(said)} ${dim(id8(r.ask))}`);
      return 0;
    }
    return fail(`not answered${r.note ? ": " + r.note : ""}`, "vyre threads asks lists the open ones");
  },

  async stop(args) {
    const f = await resolveThread(args[0]);
    if ("error" in f) return missed(f);
    const r = await tool("threads.stop", { thread: f.id });
    if (!r) return 1;
    if (json()) { emit(r); return 0; }
    out(r.stopped ? `  stopped ${dim(id8(f.id))}` : dim(`  ${r.note || "not stopped"}`));
    return 0;
  },
};
run.ls = run.list;
run.show = run.get;

/** A queued id as typed: vyred's are numbers (threads_inbox rows); anything else passes as is. */
const qidArg = s => (/^\d+$/.test(String(s)) ? Number(s) : String(s));
const queuedArg = qidArg;

/** take-back and send-now: one queued message, by thread and id. */
async function queued(args, verb, name, said) {
  const [ref, qid] = args;
  if (!ref || !qid) return usage(`vyre threads ${verb} <thread> <queued>`, "vyre threads queue <thread> lists what is queued");
  const f = await resolveThread(ref);
  if ("error" in f) return missed(f);
  const r = await tool(name, { thread: f.id, queued: qidArg(qid) });
  if (!r) return 1;
  if (json()) { emit(r); return 0; }
  out(`  ${signal(said)} ${dim(`queued ${qid}${r.note ? " · " + r.note : ""}`)}`);
  return 0;
}

/** The queued message's id in a send's reply: queued_id, or `queued` when it is the id. */
export const queuedId = r => (r && r.queued_id != null ? r.queued_id : r && (typeof r.queued === "number" || typeof r.queued === "string") ? r.queued : null);

/**
 * `send`'s words: --queue or --steer (before the text) say how; the first other word is the
 * thread and the rest is the text, flags and all, so "use --queue" can still be said. `--` ends
 * the flags.
 * @param {string[]} args
 * @returns {{ how: "queue"|"steer"|"both"|null, ref: string|undefined, words: string[] }}
 */
export function sendArgs(args) {
  let how = /** @type {"queue"|"steer"|"both"|null} */ (null), ref;
  const set = h => { how = how && how !== h ? "both" : h; };
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { i++; if (ref === undefined) ref = args[i++]; break; }
    if (a === "--queue") { set("queue"); continue; }
    if (a === "--steer") { set("steer"); continue; }
    if (ref === undefined) { ref = a; continue; }
    break;
  }
  return { how, ref, words: args.slice(i) };
}

export default {
  name: "threads", order: 22, usage: "vyre threads start|send|watch|answer|interrupt|stop … [--json]",
  summary: "sessions vyred runs: start, send, list, get, watch, queue, interrupt, mode, open, asks, answer, stop (anything else searches sessions)",
  help: [
    "Running a session vyred owns:",
    "  vyre threads start [prompt] [--cwd D | --project P] [--name N] [--model M] [--purpose P]",
    `                                                    purpose: ${PURPOSES.join(", ")}`,
    "  vyre threads send <thread> <text>                 mid-turn, vyred joins it to the running turn",
    "  vyre threads send <thread> --queue <text>         hold it until the turn ends (a terminal session always does)",
    "  vyre threads send <thread> --steer <text>         join the running turn at its next step",
    "  vyre threads queue <thread>                       what is queued and not yet handed over",
    "  vyre threads take-back|send-now <thread> <queued> take a queued message back, or hand it over now",
    "  vyre threads edit <thread> <queued> [text]        change it (no text: $EDITOR)",
    "  vyre threads get <thread> [--since ID] [--limit N]  one read: the record, open asks, events",
    "  vyre threads watch <thread>                       follow it live; reconnects on its own",
    "  vyre threads interrupt <thread>                   stop the turn (Escape); the session stays",
    "  vyre threads fork <thread> [prompt]               a new session from this one's history",
    `  vyre threads mode <thread> [${MODES.join("|")}]`,
    "                                                    say or set the permission mode",
    "  vyre threads rewind <thread> <uuid>               back to a message, files too",
    "  vyre threads open <thread>                        open it in claude here (vyred lets go of an idle one)",
    "  vyre threads stop <thread>                        end its process; the transcript stays",
    "  Setting a mode is refused from inside Claude Code: use the Deck or a plain terminal.",
    "",
    "Answering an ask (vyre needs and vyre threads asks list them):",
    "  vyre threads answer <ask> allow|deny [message]    a permission, once",
    "  vyre threads answer <ask> always [--scope project]  allow, and stop asking (where offered)",
    "  vyre threads answer <ask> --pick 2                 a question: option 2 (1,3 for several)",
    "  vyre threads answer <ask> --answer \"Palette=Warm crust\"   by question, header or number; words",
    "                                                    that match no option are your own answer",
    "  vyre threads answer <ask>                          in your terminal: shows it and asks",
    "  vyre threads answer <ask> deny [message]           declines a question",
  ].join("\n"),
  /** @param {string[]} args */
  async run(args) {
    const [sub, ...more] = args;
    if (!sub || !SUBS.includes(sub)) return catalogueCommand().run(args);
    const rest = more.filter(a => a !== "--json");
    // A mistyped flag is refused before vyred is started for it. What is sent or answered is
    // free text, so those take the words as they are.
    if (!FREE.includes(sub)) parse(rest, FLAGS[sub] || { values: [], cmd: "threads" });
    if (!(await up())) return 5;
    return run[sub](rest);
  },
};
