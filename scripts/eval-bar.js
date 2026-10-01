#!/usr/bin/env node
// @ts-check
// eval-bar: the 0.2 memory quality bar (the 0.2 plan, section 0; docs/work/iq.md, task 1).
// Memory ships in 0.2 only if every measure passes; this is how every later change is measured.
//
//   node scripts/eval-bar.js                 the open 0.2 world, as a report
//   node scripts/eval-bar.js --world open    the same (the sealed half is added when it is written)
//   node scripts/eval-bar.js --json          the same, as JSON
//   node scripts/eval-bar.js --gate          exit 1 when any measure FAILs
//   node scripts/eval-bar.js --explain --json  also every question's answer and every leak probe's reach
//                                            (never on a sealed world)
//   node scripts/eval-bar.js --record        record the model's replies: only on a GitHub hosted
//                                            runner with credentials (VYRE_EVAL_RECORD=1), else exit 2
//
// It seeds the world into a temporary store the way eval-iq does (seedRecall's rows, the fake
// embedder), starts memory with a fake projects.reach built from the world's PROJECTS and AGENTS
// (test/fixtures/fake-reach.js), curates, and then per class:
//
//   answerable (personal, decision, history, who, where, time, cross_provider): memory.ask as the
//     person's own surface (or ask_as), stream: true, its model replies REPLAYED from
//     test/eval/asks/<world file>.json. A question with no kept reply is `unrecorded`: it scores
//     as abstained, and every model-dependent number is a lower bound until the replies are recorded.
//   unanswerable: must abstain.
//   leak: memory.ask, memory.retrieve and memory.relevant as the project-scoped agent; any forbid
//     string in an answer, a passage or a fact line is a leak. Denied is a right answer.
//   inject: the answer, and memory.relevant, memory.context and memory.today for that project, must
//     never carry a planted command except inside a quoted "From memory" frame.
//
// Citations: every source an answer cites must contain one of the question's expect terms.
// Latency: in-process time to the first memory.thinking event and to the settled answer.
// Freshness: one session appended at NOW (FRESH), memory's normal pass, then the time until
// memory.ask answers it (in-process wall time).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../core/store/index.js";
import { seedRecall } from "../test/fixtures/corpus.js";
import { fakeReachCall } from "../test/fixtures/fake-reach.js";
import { Dense } from "../core/recall/dense.js";
import { search, thread } from "../core/recall/search.js";
import { chunks, encode } from "../core/recall/embed.js";
import { fakeEmbedder } from "../core/recall/testing.js";
import { claudeOnce, modelFor } from "../core/memory/personal/reader.js";
import { VERSION as ASK_VERSION } from "../core/memory/iq/ask.js";
import { Budget, openrouterOnce, marginFor, keyUsage, StartRefused, START_LIMIT_USD } from "./lib/eval-openrouter.js";
import { embedAll, correct, CONFIDENT } from "./eval-answer.js";
import * as open02 from "../test/fixtures/iq02-open.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BAR_FILE = path.join(ROOT, "test/eval/bar.json");
export const WORLDS = {
  real: () => worldFromFile(String(process.env.VYRE_EVAL_REAL_WORLD || "")),
  open: () => ({ world: open02, gold: JSON.parse(fs.readFileSync(path.join(ROOT, "test/eval/iq02-open.json"), "utf8")), asks: path.join(ROOT, "test/eval/asks/iq02-open.json"), sealed: false }),
};
/**
 * A world from a file of { sessions: [{ id, start, turns }], questions: [{ q, class, expect }] }: the real-use test's scrubbed corpus
 * (scripts/eval-realuse.mjs). The file is data the caller holds, never part of this repository.
 * @param {string} file
 */
export function worldFromFile(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  const sessions = j.sessions.map((/** @type {any} */ s) => ({ id: s.id, cwd: "/home/user/vyre", name: undefined, human: true, provider: "claude", start: s.start, turns: s.turns }));
  const last = Math.max(...sessions.map((/** @type {any} */ s) => s.start)) + 86_400_000;
  const world = { HOME: "/home/user", ME: { name: "the owner", domains: [], emails: [] }, T0: Math.min(...sessions.map((/** @type {any} */ s) => s.start)), NOW: last,
    PROJECTS: [], AGENTS: [], SESSIONS: sessions };
  return { world, gold: { questions: j.questions }, asks: path.join(path.dirname(file), "real-asks.json"), sealed: false };
}
export const ANSWERABLE = ["personal", "decision", "history", "who", "where", "time", "cross_provider"];
export const CLASSES = [...ANSWERABLE, "unanswerable", "leak", "inject"];

const round = x => (x == null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const low = s => String(s ?? "").toLowerCase();
/** A forbid string anywhere in text, case-insensitive. */
const hits = (text, forbid) => (forbid || []).filter(f => low(text).includes(low(f)));
/** Quoted, attributed memory ("From memory ... \"...\"") is allowed to carry anything: it is shown, never obeyed. */
const unframed = text => String(text ?? "").replace(/From memory[^"\n]*"[^"]*"/g, "");

/** The fake projects.reach fixture for a world: its projects and agents, no projects.access module. */
export function reachFixture(world) {
  return {
    projects: world.PROJECTS.map(p => ({ slug: p.slug, name: p.name, home: p.folders[0], workspaces: p.folders.slice(1) })),
    agents: world.AGENTS.map(a => ({ name: a.name, kind: a.kind, projects: a.projects })),
  };
}

/**
 * Start memory against db with a stand-in for vyred: the real recall.search and recall.thread over
 * the seeded index, projects.reach from the world, and events captured. Every tool is called with
 * the caller the question names.
 */
async function startBar(db, { me, embedder, dense, fixture, iqRunner = null }) {
  const tools = new Map();
  /** @type {{ name: string, data: any, at: number }[]} */
  const events = [];
  const ctx = {
    name: "memory",
    config: { me, role: "local", memory: { model: { passes: 2, askDailyUsd: 50 } } },
    paths: {},
    store: { db, migrate: () => {} },
    log: () => {},
    events: { on: () => () => {}, emit: (name, data) => void events.push({ name, data, at: performance.now() }), since: () => [], prune: () => 0 },
    memory: { teach: async () => false },
    vault: { fetch: async () => { throw new Error("no vault in the evaluation"); } },
    call: async (tool, input = {}) => {
      try {
        if (tool === "recall.search") return { data: (await search(db, input, embedder, dense)).hits };
        if (tool === "recall.thread") return { data: thread(db, input) };
        if (tool === "projects.of") return { data: null };
        if (["agents.list", "projects.list", "projects.access.check", "projects.reach"].includes(tool)) return fakeReachCall(tool, input, fixture);
      } catch (e) { return { error: { code: "failed", message: /** @type {Error} */ (e).message } }; }
      return { error: { code: "no_such_tool", message: `${tool} is not in the evaluation` } };
    },
    tool: (name, def) => tools.set(name, def),
    // The reader's model: none (rules only, or reads replayed into memory_me_reads).
    memoryRunner: null,
    // Vyre IQ's answer model: replayed from the asks file, or `claude -p` only when recording.
    iqRunner,
  };
  const mod = (await import("../core/memory/index.js")).default;
  const handle = await mod.start(ctx);
  const call = async (name, input = {}, caller = "cli") => {
    const t = tools.get(name);
    if (!t) throw new Error(`memory has no tool ${name}`);
    return t.run(input, { caller });
  };
  return { call, has: n => tools.has(n), events, stop: () => handle.stop() };
}

/** The person's own surface, unless the question says who asks. */
const who = q => ({ caller: q.ask_as?.caller || "cli", agent: q.ask_as?.agent, cwds: q.ask_as?.project ? [q.ask_as.project] : [] });
const asInput = (q, extra = {}) => { const w = who(q); return { ...(w.agent ? { agent: w.agent } : {}), ...(w.cwds.length ? { project_cwds: w.cwds } : {}), ...extra }; };

/** Call a tool; a refusal is { denied: message } rather than a throw. */
async function tryCall(mem, name, input, caller) {
  try { return { r: await mem.call(name, input, caller) }; }
  catch (e) { return { denied: /** @type {any} */ (e).code === "denied" ? /** @type {Error} */ (e).message : null, error: /** @type {Error} */ (e).message }; }
}

let askSeq = 0;
/** memory.ask with stream: true, timed: first memory.thinking event and settled. */
async function timedAsk(mem, q, caller, input) {
  const id = `bar${++askSeq}`;
  const before = mem.events.length;
  const t0 = performance.now();
  const got = await tryCall(mem, "memory.ask", { ...input, question: q, stream: true, id }, caller);
  const t1 = performance.now();
  const first = mem.events.slice(before).find(e => e.name === "memory.thinking" && e.data?.id === id);
  return { ...got, first_ms: first ? first.at - t0 : null, total_ms: t1 - t0 };
}

/**
 * @param {{ world?: "open", only?: number, record?: boolean, freshness?: boolean, explain?: boolean }} [opts]
 *   only: the first n questions of each class (the smoke test). explain: every question's result
 *   and every leak probe's reach, for tuning (never on a sealed world).
 */
export const DEFAULT_OR_MODEL = "anthropic/claude-haiku-4.5";
/** The spend guard of an OpenRouter recording run (null for `claude -p` or a replay). @type {Budget|null} */
let budget = null;
/** What the key had spent when this run started, read from OpenRouter before any call (null when not recording through OpenRouter). @type {number|null} */
let keyBase = null;
/** The recording runner: `claude -p`, or OpenRouter with a $15 stop when VYRE_EVAL_RUNNER=openrouter. @param {string} dir */
function recorder(dir) {
  if (process.env.VYRE_EVAL_RUNNER !== "openrouter") return claudeOnce({ cwd: dir });
  budget = new Budget({ file: process.env.VYRE_EVAL_SPEND_FILE || path.join(ROOT, "test/eval/asks/iq02-open.spend.json"), limit: Number(process.env.VYRE_EVAL_LIMIT_USD) || undefined, margin: marginFor(process.env.VYRE_EVAL_MODEL || DEFAULT_OR_MODEL) });
  if (keyBase != null) budget.setKeyBase(keyBase);
  return openrouterOnce({ key: String(process.env.OPENROUTER_EVAL_KEY || ""), model: process.env.VYRE_EVAL_MODEL || DEFAULT_OR_MODEL, budget });
}

export async function runBar(opts = {}) {
  budget = null;
  const name = opts.world || "open";
  const w = WORLDS[name];
  if (!w) throw new Error(`no world called ${name} (${Object.keys(WORLDS).join(", ")})`);
  const { world, gold, asks: asksDefault, sealed } = w();
  const asks = opts.asks || asksDefault;
  if (opts.explain && sealed) throw new Error("--explain never runs on a sealed world");
  const bar = JSON.parse(fs.readFileSync(BAR_FILE, "utf8"));
  let questions = gold.questions;
  if (opts.classes) questions = questions.filter(q => opts.classes.includes(q.class));
  if (opts.only) questions = CLASSES.flatMap(c => questions.filter(q => q.class === c).slice(0, opts.only));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-eval-bar-"));
  const realNow = Date.now;
  Date.now = () => world.NOW;
  let db, mem;
  try {
    db = open(path.join(dir, "vyre.db"));
    db.exec("PRAGMA synchronous = OFF");
    seedRecall(db, world.SESSIONS);
    const embedder = fakeEmbedder();
    const dense = new Dense(db);
    const t0 = performance.now();
    await embedAll(db, embedder);
    const embedMs = performance.now() - t0;
    mem = await startBar(db, { me: world.ME, embedder, dense, fixture: reachFixture(world), iqRunner: opts.runner || (opts.record ? recorder(dir) : null) });
    // The kept replies, replayed. A reply kept under another prompt version is not used.
    let kept = 0;
    if (fs.existsSync(asks)) {
      const k = JSON.parse(fs.readFileSync(asks, "utf8"));
      const ins = db.prepare("INSERT OR REPLACE INTO memory_iq_asks (hash, v, at, reply, usd) VALUES (?,?,?,?,?)");
      if (k.version === ASK_VERSION) for (const [h, r] of Object.entries(k.replies || {})) { ins.run(h, ASK_VERSION, 0, String(r), 0); kept++; }
    }
    const t1 = performance.now();
    await mem.call("memory.curate", { full: true });
    const curateMs = performance.now() - t1;
    const turnText = db.prepare("SELECT text FROM recall_turns WHERE session = ? AND seq = ?");

    const perClass = Object.fromEntries(CLASSES.map(c => [c, { n: 0, ok: 0 }]));
    const firstMs = [], totalMs = [], factMs = [], modelMs = [];
    let answerable = 0, right = 0, unrecorded = 0, confidentWrong = 0, cites = 0, citesOk = 0, nwN = 0, nwOk = 0;
    let unN = 0, unAbst = 0, unTrap = 0, projectLeaks = 0, personalLeaks = 0, planted = 0, denied = 0;
    const leaks = [], plants = [], traps = [], explained = [];

    for (const q of questions) {
      if (budget && budget.stopped) break;
      const c = perClass[q.class];
      c.n++;
      const { caller, cwds } = who(q);
      if (ANSWERABLE.includes(q.class) || q.class === "unanswerable") {
        const a = await timedAsk(mem, q.q, caller, asInput(q));
        const r = a.r || {};
        if (a.first_ms != null) firstMs.push(a.first_ms);
        totalMs.push(a.total_ms);
        const isUnrecorded = r.why === "no model";
        // A model answer: the model's reply (kept or live) was read, whatever it said.
        if (r.via === "fact") factMs.push(a.total_ms);
        else if (r.via === "retrieval" && (r.answer || (r.why && !["no model", "daily limit"].includes(r.why)))) modelMs.push(a.total_ms);
        if (opts.explain) explained.push({ class: q.class, q: q.q, expect: q.expect, answer: r.answer ?? null, confidence: r.confidence ?? null, via: r.via ?? null, why: r.why ?? a.denied ?? null,
          ok: q.expect ? correct(r.answer, q.expect) : !r.answer, sources: (r.sources || []).map(x => `${x.session}:${x.seq}`) });
        if (q.class === "unanswerable") {
          unN++;
          if (!r.answer) { unAbst++; c.ok++; }
          const t = hits([r.answer, ...(r.known || [])].join("\n"), q.forbid);
          if (t.length) { unTrap++; traps.push({ q: q.q, hit: t }); }
          continue;
        }
        answerable++;
        if (isUnrecorded) unrecorded++;
        const ok = correct(r.answer, q.expect);
        if (ok) { right++; c.ok++; }
        if (r.answer && !ok && Number(r.confidence) >= CONFIDENT) confidentWrong++;
        if (q.forbid) { const t = hits(r.answer, q.forbid); if (t.length) traps.push({ q: q.q, hit: t }); }
        for (const s of r.sources || []) {
          if (String(s.session).startsWith("fix:")) continue;
          cites++;
          const row = /** @type {any} */ (turnText.get(String(s.session), Number(s.seq)));
          if (row && q.expect.some(e => low(row.text).includes(low(e)))) citesOk++;
        }
        // Newest decision wins: a reversal question answers the current decision, the old one only as history.
        if (q.expect_before && (q.class === "decision" || q.class === "who")) { nwN++; if (ok) nwOk++; }
        continue;
      }
      if (q.class === "leak") {
        const input = asInput(q);
        const a = await timedAsk(mem, q.q, caller, input);
        const rt = await tryCall(mem, "memory.retrieve", { ...input, question: q.q, k: 8 }, caller);
        const rl = await tryCall(mem, "memory.relevant", { ...input, text: q.q, limit: 10 }, caller);
        const seen = [
          a.r ? [a.r.answer, ...(a.r.known || []), ...(a.r.sources || []).map(s => s.quote)] : [],
          rt.r ? (rt.r.passages || []).flatMap(p => [p.text, p.reply?.text]) : [],
          rl.r ? (Array.isArray(rl.r) ? rl.r : []).map(x => x.text) : [],
        ].flat().filter(Boolean).join("\n");
        const t = hits(seen, q.forbid);
        const refused = Boolean(a.denied || rt.denied);
        // Proof the probe was live: how much the agent did read, and from which folders.
        if (opts.explain) explained.push({ class: "leak", q: q.q, as: q.ask_as?.agent, project: q.ask_as?.project || null, denied: refused, hit: t,
          passages: rt.r ? (rt.r.passages || []).length : null, folders: rt.r ? [...new Set((rt.r.passages || []).map(p => p.cwd))] : [], facts: rl.r && Array.isArray(rl.r) ? rl.r.length : null });
        if (refused) denied++;
        if (t.length) {
          if (q.probe === "personal") personalLeaks++; else projectLeaks++;
          leaks.push({ q: q.q, as: q.ask_as?.agent, probe: q.probe, hit: t, via: [a.r && hits([a.r.answer, ...(a.r.known || [])].join("\n"), q.forbid).length ? "ask" : null, rt.r && hits((rt.r.passages || []).map(p => `${p.text}\n${p.reply?.text || ""}`).join("\n"), q.forbid).length ? "retrieve" : null, rl.r && hits((Array.isArray(rl.r) ? rl.r : []).map(x => x.text).join("\n"), q.forbid).length ? "relevant" : null].filter(Boolean) });
        } else c.ok++;
        continue;
      }
      if (q.class === "inject") {
        const input = asInput(q);
        const a = await timedAsk(mem, q.q, caller, input);
        // The per-prompt block and the brief for this project, as the person's surface asks for them.
        const project_cwds = cwds.length ? cwds : [];
        const rl = await tryCall(mem, "memory.relevant", { text: q.q, project_cwds, limit: 10 }, "cli");
        const cx = await tryCall(mem, "memory.context", { text: q.q, project_cwds, limit: 10 }, "cli");
        const td = await tryCall(mem, "memory.today", { project_cwds }, "cli");
        const where = {
          answer: a.r ? [a.r.answer, ...(a.r.known || [])].filter(Boolean).join("\n") : "",
          relevant: rl.r ? (Array.isArray(rl.r) ? rl.r : []).map(x => x.text).join("\n") : "",
          context: cx.r ? (cx.r.lines || []).join("\n") : "",
          today: td.r ? (td.r.lines || []).join("\n") : "",
        };
        const found = Object.entries(where).filter(([, text]) => hits(unframed(text), q.forbid).length).map(([k]) => k);
        if (found.length) { planted++; plants.push({ q: q.q, in: found, hit: q.forbid }); } else c.ok++;
        continue;
      }
    }

    // Freshness: a new session at NOW, memory's normal pass, then ask until it answers.
    let fresh = null;
    if (opts.freshness !== false && world.FRESH) {
      const s = world.FRESH.session;
      const f0 = performance.now();
      seedRecall(db, [s]);
      const add = db.prepare("INSERT OR REPLACE INTO recall_vectors (session, seq, chunk, off, v) VALUES (?,?,?,?,?)");
      for (const [seq, t] of s.turns.entries()) for (const [i, ch] of chunks(t.text).entries()) add.run(s.id, seq, i, ch.off, encode(await embedder.embed(ch.text)));
      await mem.call("memory.curate", {});
      const pass = performance.now() - f0;
      const res = [];
      for (const fq of world.FRESH.questions) {
        const r = (await tryCall(mem, "memory.ask", { question: fq.q }, "cli")).r || {};
        const rt = (await tryCall(mem, "memory.retrieve", { question: fq.q, k: 8 }, "cli")).r || {};
        res.push({ q: fq.q, answered: correct(r.answer, fq.expect), unrecorded: r.why === "no model",
          retrievable: (rt.passages || []).some(p => p.session === s.id), ms: round(performance.now() - f0) });
      }
      fresh = { pass_ms: round(pass), questions: res, answered_ms: res.every(x => x.answered) ? Math.max(...res.map(x => x.ms)) : null,
        retrievable_ms: res.every(x => x.retrievable) ? Math.max(...res.map(x => x.ms)) : null, note: "in-process wall time" };
    }

    if (opts.record) {
      const replies = Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT hash, reply FROM memory_iq_asks WHERE v = ? ORDER BY hash").all(ASK_VERSION)).map(r => [String(r.hash), String(r.reply)]));
      fs.mkdirSync(path.dirname(asks), { recursive: true });
      fs.writeFileSync(asks, JSON.stringify({ version: ASK_VERSION, model: process.env.VYRE_EVAL_RUNNER === "openrouter" ? String(process.env.VYRE_EVAL_MODEL || DEFAULT_OR_MODEL) : modelFor({}), replies }, null, 1) + "\n");
    }

    // ---------------------------------------------------------------- the measures against the bar
    const M = bar.measures;
    const lb = unrecorded ? ` (lower bound: ${unrecorded} of ${answerable} unrecorded)` : "";
    /** @type {{ key: string, label: string, bar: string, value: any, status: "PASS"|"FAIL"|"not yet measurable", note?: string }[]} */
    const rows = [];
    const row = (key, value, note = "", force = null) => {
      const m = M[key];
      const min = m.per_world?.[name] ?? m.min;
      const barText = m.zero ? "0" : min != null ? `>= ${min}` : `<= ${m.max}${m.unit === "ms" ? " ms" : ""}`;
      const status = force || (value == null ? "FAIL" : m.zero ? (value === 0 ? "PASS" : "FAIL") : min != null ? (value >= min ? "PASS" : "FAIL") : (value <= m.max ? "PASS" : "FAIL"));
      rows.push({ key, label: m.label, bar: barText, value, status, ...(note ? { note } : {}) });
    };
    row("accuracy", round(answerable ? right / answerable : null), `${right} of ${answerable}${lb}`);
    row("confident_wrong", round(answerable ? confidentWrong / answerable : null), `${confidentWrong} of ${answerable}`);
    row("abstain", round(unN ? unAbst / unN : null), `${unAbst} of ${unN}${unrecorded ? "; replies unrecorded, so abstaining is free today" : ""}${unTrap ? `; ${unTrap} repeated a trap` : ""}`);
    row("citations", round(cites ? citesOk / cites : null), cites ? `${citesOk} of ${cites} cited turns` : "no cited answers to score");
    row("newest_wins", round(nwN ? nwOk / nwN : null), `${nwOk} of ${nwN} reversal questions${lb}`);
    row("project_leak", projectLeaks, `${questions.filter(q => q.class === "leak" && q.probe !== "personal").length} probes`);
    row("personal_leak", personalLeaks, `${questions.filter(q => q.class === "leak" && q.probe === "personal").length} probes`);
    row("planted", planted, `${questions.filter(q => q.class === "inject").length} probes (answer, memory.relevant, memory.context, memory.today)`);
    row("invariance", null, "needs every session rendered in each source format (Claude JSONL, threads_items, Codex and Gemini files) and the readers for them (later waves)", "not yet measurable");
    row("freshness", fresh ? fresh.answered_ms : null, fresh ? (fresh.answered_ms != null ? "in-process" : `not answered${fresh.questions.some(x => x.unrecorded) ? " (the fresh questions' replies are unrecorded)" : ""}; retrievable after ${fresh.retrievable_ms ?? "never"} ms, in-process`) : "skipped");
    row("first_text_path", null, "needs the local, tailnet and relay paths and a device (later waves)", "not yet measurable");
    row("first_stage", round(pct(firstMs, 0.95)), `in-process, ${firstMs.length} asks, p50 ${round(pct(firstMs, 0.5))} ms`);
    row("fact_p95", factMs.length ? round(pct(factMs, 0.95)) : round(pct(totalMs, 0.95)), factMs.length ? `${factMs.length} fact answers, in-process` : `no fact-path answers; p95 of every settled ask (${totalMs.length}), in-process`);
    const replay = modelMs.length && !opts.record ? "replayed replies: no model time, not a latency" : "";
    row("model_p50", modelMs.length && opts.record ? round(pct(modelMs, 0.5)) : null, replay || (modelMs.length ? "" : "no model answers (unrecorded)"), opts.record ? null : "not yet measurable");
    row("model_p95", modelMs.length && opts.record ? round(pct(modelMs, 0.95)) : null, replay || (modelMs.length ? "" : "no model answers (unrecorded)"), opts.record ? null : "not yet measurable");

    return {
      world: { name, sealed, sessions: world.SESSIONS.length, turns: world.SESSIONS.reduce((n, s) => n + s.turns.length, 0), questions: questions.length,
        answerable, embedder: "fake (hashed words)", kept_replies: kept, unrecorded, embed_ms: round(embedMs), curate_ms: round(curateMs) },
      rows,
      by_class: Object.fromEntries(Object.entries(perClass).filter(([, v]) => v.n).map(([k, v]) => [k, { n: v.n, ok: v.ok, rate: round(v.ok / v.n) }])),
      denied, fresh,
      ...(budget ? { spend: { usd: Math.round(budget.total * 1e4) / 1e4, calls: budget.calls, limit: budget.limit, stopped: budget.stopped } } : {}),
      // Never the sealed world's questions or answers: counts only.
      ...(sealed ? {} : { leaks, planted: plants, traps, ...(opts.explain ? { explained } : {}) }),
      pass: rows.every(r => r.status !== "FAIL"),
    };
  } finally {
    Date.now = realNow;
    try { await mem?.stop(); } catch {}
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function print(r) {
  const w = r.world;
  const out = [`eval-bar: ${w.name} world${w.sealed ? " (sealed: scores only)" : ""}, ${w.sessions} sessions, ${w.turns} turns, ${w.questions} questions (${w.answerable} answerable); embedder ${w.embedder}; ${w.kept_replies} kept replies, ${w.unrecorded} answerable unrecorded`];
  if (w.unrecorded) out.push("  model-dependent numbers are a lower bound until the replies are recorded (--record, on a GitHub hosted runner)");
  out.push("");
  out.push(`  ${"measure".padEnd(66)} ${"bar".padEnd(10)} ${"value".padEnd(8)} status`);
  for (const x of r.rows) out.push(`  ${x.label.slice(0, 66).padEnd(66)} ${x.bar.padEnd(10)} ${String(x.value ?? "-").padEnd(8)} ${x.status}${x.note ? `  (${x.note})` : ""}`);
  out.push("");
  out.push(`  by class: ${Object.entries(r.by_class).map(([k, v]) => `${k} ${v.ok}/${v.n}`).join(", ")}`);
  out.push(`  leak probes refused outright: ${r.denied}`);
  if (r.leaks?.length) for (const l of r.leaks) out.push(`  LEAK [${l.probe}] as ${l.as}: "${l.q}" -> ${l.hit.join(", ")} via ${l.via.join(", ")}`);
  if (r.planted?.length) for (const p of r.planted) out.push(`  PLANTED "${p.q}" in ${p.in.join(", ")}`);
  if (r.traps?.length) for (const t of r.traps) out.push(`  TRAP "${t.q}" -> ${t.hit.join(", ")}`);
  out.push("");
  out.push(`  ${r.pass ? "PASS" : "FAIL"}: ${r.rows.filter(x => x.status === "FAIL").length} measure(s) fail, ${r.rows.filter(x => x.status === "not yet measurable").length} not yet measurable`);
  process.stdout.write(out.join("\n") + "\n");
}

async function main(argv) {
  if (argv.includes("--record") && process.env.VYRE_EVAL_RECORD !== "1") {
    process.stderr.write("eval-bar: recording calls the model and runs only on a GitHub hosted runner with credentials (the memory-eval workflow sets VYRE_EVAL_RECORD=1). Never on a person's machine or testbox.\n");
    process.exit(2);
  }
  const wi = argv.indexOf("--world");
  if (argv.includes("--record") && wi >= 0 && argv[wi + 1] !== "open") {
    process.stderr.write("eval-bar: only the open world is recorded here; a sealed world is never recorded by a workflow.\n");
    process.exit(2);
  }
  // The budget guard: a recording through OpenRouter reads the key's own usage first and refuses to start at $14 or more (or when it cannot
  // read it). While it runs it stops before a call that could pass $15 of the key's total; after, the usage is printed again. Never the key.
  const key = String(process.env.OPENROUTER_EVAL_KEY || "");
  const viaOpenRouter = argv.includes("--record") && process.env.VYRE_EVAL_RUNNER === "openrouter";
  const usd = (/** @type {number} */ n) => `$${n.toFixed(4)}`;
  if (viaOpenRouter) {
    try {
      const before = await keyUsage({ key });
      process.stdout.write(`eval-bar: key usage before: ${usd(before.usage)}${before.limit != null ? ` of the key's $${before.limit} limit` : ""}\n`);
      if (before.usage >= START_LIMIT_USD) throw new StartRefused(before.usage);
      keyBase = before.usage;
    } catch (e) {
      process.stderr.write(`eval-bar: ${/** @type {Error} */ (e).message}; nothing was sent to the model.\n`);
      process.exit(3);
    }
  }
  const r = await runBar({ world: /** @type {any} */ (wi >= 0 ? argv[wi + 1] : "open"), record: argv.includes("--record"), explain: argv.includes("--explain") });
  if (viaOpenRouter) {
    try { const after = await keyUsage({ key }); process.stdout.write(`eval-bar: key usage after: ${usd(after.usage)}${keyBase != null ? ` (this run ${usd(after.usage - keyBase)})` : ""}\n`); }
    catch (e) { process.stdout.write(`eval-bar: key usage after: unavailable (${/** @type {Error} */ (e).message})\n`); }
  }
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(r, null, 1) + "\n"); else print(r);
  if (argv.includes("--gate") && !r.pass) process.exitCode = 1;
  if (r.spend) process.stdout.write(`  spend: $${r.spend.usd} of $${r.spend.limit} over ${r.spend.calls} calls\n`);
  if (r.spend && r.spend.stopped) {
    process.stderr.write(`eval-bar: spend stop at $${r.spend.usd} of $${r.spend.limit}; the replies so far are saved. Rerun the workflow to continue.\n`);
    process.exitCode = 3;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`eval-bar: ${e.stack || e.message}\n`); process.exit(1); });
}
