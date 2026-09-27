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

import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { call } from "../../daemon/client.js";
import * as config from "../../config/index.js";
import { untilde } from "../../config/index.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import catalogue, { parse, up } from "./projects.js";
import { json, emit, fail as kitFail, failTool, usage } from "../kit.js";

const SURFACE = "cli:" + process.pid;
const SUBS = ["start", "send", "list", "ls", "get", "show", "watch", "lease", "release", "asks", "answer", "stop"];

const id8 = s => String(s || "").slice(0, 8);
/** The flags each subcommand takes; the rest take none. */
const FLAGS = {
  start: { values: ["project", "cwd", "name", "model"], cmd: "threads" },
  list: { bool: ["all"], values: ["agent"], cmd: "threads" },
  ls: { bool: ["all"], values: ["agent"], cmd: "threads" },
  answer: { bool: ["always"], multi: ["pick", "answer"], values: ["scope", "message"], cmd: "threads" },
};
// --json: each subcommand prints one line of JSON (the tool's data, or { error }) and nothing
// else, so a script can drive threads without parsing the words meant for a person (kit.js).
const fail = (msg, next) => kitFail(msg, { next });
/** A tool call that prints its own error, in the mode this run is in. */
async function tool(name, input) {
  const r = await call(name, input);
  if (r.error) { failTool(r.error); return null; }
  return r.data;
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
    case "thread.tool":
      return p.phase === "started" ? dim(`  · ${p.summary || p.tool || "tool"}`) + "\n" : null;
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
      const cost = typeof p.cost_usd === "number" ? `$${p.cost_usd.toFixed(4)}` : "";
      const bits = [p.ok === false ? "failed" : "done", cost, p.error ? cut(p.error, 120) : ""].filter(Boolean);
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

  return new Promise(resolve => {
    let done = false;
    const finish = code => {
      if (done) return;
      done = true;
      process.off("SIGINT", onInt);
      if (midline) process.stdout.write("\n");
      req.destroy();
      resolve(code);
    };
    const onInt = () => finish(0);
    process.on("SIGINT", onInt);
    const req = http.request({ socketPath: config.paths().socket, path: `/v1/events/stream?type=*&since=${since}`, method: "GET",
      headers: { accept: "text/event-stream", "x-vyre-caller": "cli" } }, res => {
      if (res.statusCode !== 200) { out(beacon(`  the event stream answered ${res.statusCode}`)); finish(1); return; }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", chunk => {
        const r = parseSSE(buf + chunk);
        buf = r.rest;
        for (const f of r.frames) {
          let e;
          try { e = JSON.parse(f.data); } catch { continue; }
          // Stream events carry the thread at the top; the payload has it too, as a fallback.
          if ((e.thread ?? (e.payload && e.payload.thread)) !== id) continue;
          show(e);
          if (e.type === "thread.stopped") { finish(0); return; }
        }
      });
      res.on("end", () => { if (!done) { out(dim("  vyred closed the stream")); finish(0); } });
    });
    req.on("error", err => { if (!done) { out(beacon(`  lost vyred: ${err.message}`)); finish(1); } });
    req.end();
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
    if (pos.length) input.prompt = pos.join(" ");
    const t = await tool("threads.start", input);
    if (!t) return 1;
    if (json()) { emit(t); return 0; }
    out(`  ${signal("started")} ${t.id}  ${dim([t.name, t.project, tail(t.cwd, 40)].filter(Boolean).join(" · "))}`);
    out(dim(`  vyre threads watch ${id8(t.id)}`));
    return 0;
  },

  async send(args) {
    const [ref, ...words] = args;
    if (!ref || !words.length) return usage("vyre threads send <thread> <text>", "vyre threads list shows the threads");
    const f = await resolveThread(ref);
    if ("error" in f) return missed(f);
    const r = await tool("threads.send", { thread: f.id, text: words.join(" "), surface: SURFACE });
    if (!r) return 1;
    if (json()) { emit(r); return r.sent ? 0 : 1; }
    if (r.sent) { out(dim(`  sent · vyre threads watch ${id8(f.id)}`)); return 0; }
    // Open in a terminal: queued, and handed over when its turn ends.
    if (r.queued) { out(dim(`  queued · ${r.note}`)); return 0; }
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
run.get = run.watch;
run.show = run.watch;

export default {
  name: "threads", order: 22, usage: "vyre threads start|send|watch|answer|stop … [--json]",
  summary: "headless threads vyred runs: start, send, list, watch, lease, release, asks, answer, stop (anything else searches sessions)",
  help: [
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
    if (sub !== "send") parse(rest, FLAGS[sub] || { values: [], cmd: "threads" });
    if (!(await up())) return 5;
    return run[sub](rest);
  },
};
