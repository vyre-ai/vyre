#!/usr/bin/env node
// @ts-check
// eval-answer: does memory answer questions about the user's own life, and does it stay quiet
// when it does not know? (docs/work/memory-iq.md)
//
//   node scripts/eval-answer.js          the synthetic personal world, as a report
//   node scripts/eval-answer.js --json   the same, as JSON
//   node scripts/eval-answer.js --record  read the world's turns with the fast model (`claude -p`) into
//            test/eval/reads/<world>.json; by default the reads are replayed from there, no model
//   node scripts/eval-answer.js --no-model  the rules alone
//   node scripts/eval-answer.js --claims <text>  also list the claims that name it (not for sealed)
//   node scripts/eval-answer.js --facts  also list the personal facts the world left (not for sealed)
//   node scripts/eval-answer.js --keyword  without the dense index (keyword recall only)
//   node scripts/eval-answer.js --world heldout  the held-out world (test/fixtures/personal-heldout.js
//            and test/eval/answer-heldout.json), written before reading the rules
//   node scripts/eval-answer.js --world blind  the blind world (test/fixtures/personal-blind.js and
//            test/eval/answer-blind.json), written without seeing the rules or the other worlds
//   node scripts/eval-answer.js --world fresh  the fresh world (test/fixtures/personal-fresh.js and
//            test/eval/answer-fresh.json), sealed: written without the rules or any other world's
//            body, and not to be read by whoever tunes the rules
//   node scripts/eval-answer.js --world sealed  the second sealed world (test/fixtures/personal-sealed.js
//            and test/eval/answer-sealed.json), written the same way; no --facts, --claims or --ask
//   node scripts/eval-answer.js --world trust  source trust (test/fixtures/personal-trust.js): the
//            user's own words against dev sessions, subagents, injected blocks and Claude's words
//
// Exits non-zero when memory.answer misses the bar: overall 0.9 or more, no confident wrong
// answer, p95 under 150 ms.
//
// It builds a temporary store under os.tmpdir(), seeds test/fixtures/personal-world.js the way
// the tests seed Recall, embeds every turn with the fake embedder (core/recall/testing.js) into a
// dense index, starts the memory module with a stand-in for vyred whose ctx.call answers
// recall.search and recall.thread, curates, and then asks every question in
// test/eval/answer-gold.json of two answerers:
//
//   before   today's Capsule path (the Capsule's recall()): memory.relevant, then the
//            user's own words through recall.search, rankSaid and yourAnswer.
//   answer   the memory module's memory.answer tool. Reported as unsupported, never thrown, when
//            the module has no such tool yet.
//
// Metrics per answerer: precision@1 (right answers over questions that have one), no-answer
// accuracy (no answer over questions that have none), confident-wrong (an answer at confidence 0.5
// or more that is wrong, or given at all to a question that has none), overall (right over all,
// silence on an unknown counting as right), and latency p50/p95 in ms.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../core/store/index.js";
import { seedRecall } from "../test/fixtures/corpus.js";
import { PERSONAL_SESSIONS, ME, NOW, SCRATCH } from "../test/fixtures/personal-world.js";
import * as heldout from "../test/fixtures/personal-heldout.js";
import * as blind from "../test/fixtures/personal-blind.js";
import * as fresh from "../test/fixtures/personal-fresh.js";
import * as sealed from "../test/fixtures/personal-sealed.js";
import * as trust from "../test/fixtures/personal-trust.js";
import { search, thread } from "../core/recall/search.js";
import { chunks, encode } from "../core/recall/embed.js";
import { Dense } from "../core/recall/dense.js";
import { claudeOnce, modelFor, VERSION } from "../core/memory/personal/reader.js";
import { fakeEmbedder } from "../core/recall/testing.js";
import { rankSaid, yourAnswer, words } from "./lib/said.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GOLD_FILE = path.join(ROOT, "test/eval/answer-gold.json");
export const HELDOUT_GOLD_FILE = path.join(ROOT, "test/eval/answer-heldout.json");
export const BLIND_GOLD_FILE = path.join(ROOT, "test/eval/answer-blind.json");
export const FRESH_GOLD_FILE = path.join(ROOT, "test/eval/answer-fresh.json");
export const SEALED_GOLD_FILE = path.join(ROOT, "test/eval/answer-sealed.json");
export const TRUST_GOLD_FILE = path.join(ROOT, "test/eval/answer-trust.json");

/**
 * The worlds the evaluation knows: the one the rules were written against, and a held-out one.
 * @type {Record<string, () => { gold: any, sessions: any[], me: any, now: number, scratch: string }>}
 */
export const WORLDS = {
  personal: () => ({ gold: JSON.parse(fs.readFileSync(GOLD_FILE, "utf8")), sessions: PERSONAL_SESSIONS, me: ME, now: NOW, scratch: SCRATCH }),
  heldout: () => ({ gold: JSON.parse(fs.readFileSync(HELDOUT_GOLD_FILE, "utf8")), sessions: heldout.HELDOUT_SESSIONS, me: heldout.ME, now: heldout.NOW, scratch: heldout.SCRATCH }),
  blind: () => ({ gold: JSON.parse(fs.readFileSync(BLIND_GOLD_FILE, "utf8")), sessions: blind.BLIND_SESSIONS, me: blind.ME, now: blind.NOW, scratch: blind.SCRATCH }),
  fresh: () => ({ gold: JSON.parse(fs.readFileSync(FRESH_GOLD_FILE, "utf8")), sessions: fresh.FRESH_SESSIONS, me: fresh.ME, now: fresh.NOW, scratch: fresh.SCRATCH }),
  sealed: () => ({ gold: JSON.parse(fs.readFileSync(SEALED_GOLD_FILE, "utf8")), sessions: sealed.SEALED_SESSIONS, me: sealed.ME, now: sealed.NOW, scratch: sealed.SCRATCH }),
  // Source trust: only the user's own words teach personal facts (ADR 0034, the "Jordan" trap).
  trust: () => ({ gold: JSON.parse(fs.readFileSync(TRUST_GOLD_FILE, "utf8")), sessions: trust.TRUST_SESSIONS, me: trust.ME, now: trust.NOW, scratch: trust.SCRATCH }),
};
/** An answer at this confidence or more is one the user is told as a fact. */
export const CONFIDENT = 0.5;
/** What a said line (the user's own words turned to "you") is worth, as the Capsule treats it. */
export const SAID_CONFIDENCE = 0.6;

// ------------------------------------------------------------------ scoring

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Does an answer contain one of the expected strings? Case-insensitive, and as a whole word or
 * phrase, so "tea" is not found in "instead" nor "Sam" in "same".
 * @param {string|null} answer @param {string[]} expect
 */
export function correct(answer, expect) {
  if (!answer) return false;
  const a = String(answer).toLowerCase();
  return expect.some(e => new RegExp(`(^|[^\\p{L}\\p{N}])${esc(String(e).toLowerCase())}($|[^\\p{L}\\p{N}])`, "u").test(a));
}

const round = x => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x);
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

/**
 * Score one answerer's results against the gold questions.
 * @param {{ q: string, expect: string[]|null, kind: string }[]} questions
 * @param {{ answer: string|null, confidence: number|null, ms: number }[]} got
 */
/** What must not change between two asks of the same question: everything but the time taken. */
export const stable = r => JSON.stringify({ a: r.answer ?? null, c: r.confidence ?? null, f: (r.facts || []).map(x => x.id ?? null), s: (r.sources || []).map(x => `${x.session}:${x.seq}`) });

/** Grounded or abstain (ADR 0034): an answer told as a fact names the facts or turns it came from. */
const grounded = r => Boolean((r.facts && r.facts.length) || (r.sources && r.sources.length) || r.from === 0 && r.kind === "fact");

export function score(questions, got) {
  let known = 0, right = 0, unknown = 0, silent = 0, confidentWrong = 0, ungrounded = 0;
  const failures = [];
  questions.forEach((g, i) => {
    const r = got[i];
    const conf = typeof r.confidence === "number" ? r.confidence : 0;
    if (r.answer && conf >= CONFIDENT && !grounded(r)) ungrounded++;
    if (g.expect) {
      known++;
      const ok = correct(r.answer, g.expect);
      if (ok) right++;
      else {
        if (r.answer && conf >= CONFIDENT) confidentWrong++;
        failures.push({ q: g.q, kind: g.kind, expect: g.expect, answer: r.answer, confidence: r.confidence, why: r.answer ? (conf >= CONFIDENT ? "confident-wrong" : "wrong") : "no answer" });
      }
    } else {
      unknown++;
      if (!r.answer) silent++;
      else {
        if (conf >= CONFIDENT) confidentWrong++;
        failures.push({ q: g.q, kind: g.kind, expect: null, answer: r.answer, confidence: r.confidence, why: conf >= CONFIDENT ? "confident-wrong" : "answered an unknown" });
      }
    }
  });
  const ms = got.map(r => r.ms);
  return {
    questions: questions.length,
    precision_at_1: round(known ? right / known : null),
    no_answer_accuracy: round(unknown ? silent / unknown : null),
    confident_wrong: confidentWrong,
    ungrounded,
    overall: round(questions.length ? (right + silent) / questions.length : null),
    p50_ms: round(pct(ms, 0.5)),
    p95_ms: round(pct(ms, 0.95)),
    failures,
  };
}

// ------------------------------------------------------------------ the world, in-process

/**
 * Start the memory module against db with a stand-in for vyred: recall.search and recall.thread
 * are the real functions over the seeded index, there are no projects and no agents.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{ me: any, embedder: any, dense: any }} opts
 */
async function startMemory(db, { me, embedder, dense, runner = null }) {
  const tools = new Map();
  const ctx = {
    name: "memory",
    // VYRE_EVAL_PASSES: readings per batch when recording (config.memory.model.passes).
    config: { me, role: "local", memory: { model: { passes: Number(process.env.VYRE_EVAL_PASSES) || 2 } } },
    paths: {},
    store: { db, migrate: () => {} },
    log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    memory: { teach: async () => false },
    vault: { fetch: async () => { throw new Error("no vault in the evaluation"); } },
    call: async (tool, input = {}) => {
      try {
        if (tool === "recall.search") return { data: (await search(db, input, embedder, dense)).hits };
        if (tool === "recall.thread") return { data: thread(db, input) };
        if (tool === "projects.list") return { data: [] };
        if (tool === "projects.of") return { data: null };
        if (tool === "agents.list") return { data: [] };
      } catch (e) { return { error: { code: "failed", message: /** @type {Error} */ (e).message } }; }
      return { error: { code: "no_such_tool", message: `${tool} is not in the evaluation` } };
    },
    tool: (name, def) => tools.set(name, def),
    // The reader's model: `claude -p` when recording, none when replaying (reads come from the fixture).
    memoryRunner: runner,
  };
  const mod = (await import("../core/memory/index.js")).default;
  const handle = await mod.start(ctx);
  const has = name => tools.has(name);
  /** Call one of memory's tools as the CLI would. */
  const call = async (name, input = {}) => {
    const t = tools.get(name);
    if (!t) throw new Error(`memory has no tool ${name}`);
    return t.run(input, { caller: "cli" });
  };
  return { call, has, ctx, stop: () => handle.stop() };
}

/**
 * Every turn's vectors, as Recall's indexer writes them (chunks, then one row per chunk), but in
 * one transaction: the indexer commits turn by turn, which is right for a live index and makes a
 * throwaway one take seconds longer than it has to.
 */
async function embedAll(db, embedder) {
  const add = db.prepare("INSERT OR REPLACE INTO recall_vectors (session, seq, chunk, off, v) VALUES (?,?,?,?,?)");
  const rows = /** @type {any[]} */ (db.prepare("SELECT session, seq, text FROM recall_turns ORDER BY rowid").all());
  const made = [];
  for (const r of rows) {
    const cs = chunks(String(r.text));
    made.push({ r, cs, vs: await Promise.all(cs.map(c => embedder.embed(c.text))) });
  }
  db.exec("BEGIN");
  try {
    for (const { r, cs, vs } of made) {
      if (!cs.length) add.run(r.session, r.seq, 0, 0, Buffer.alloc(0));
      cs.forEach((c, i) => add.run(r.session, r.seq, i, c.off, encode(vs[i])));
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const confidenceOf = x => (typeof x.confidence === "number" && Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : null);
const now = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * The answerers. Each takes a question and returns { answer, confidence, ms }. `before` is the
 * Electron Capsule's recall() (bridge.js), step for step, minus the page.
 * @typedef {(q: string) => Promise<{ answer: string|null, confidence: number|null, ms: number, via?: string|null }>} Answerer
 */
function answerers(mem, scratch = SCRATCH) {
  /** @type {Record<string, Answerer | null>} */
  const out = {
    before: async q => {
      const t0 = now();
      const [facts, hits] = await Promise.all([
        mem.call("memory.relevant", { text: q, limit: 3 }).then(d => ({ data: d }), e => ({ error: e })),
        mem.ctx.call("recall.search", { q, limit: 10, per_session: 1 }),
      ]);
      const asked = words(q);
      const f = (facts.data || []).filter(x => (x.score ?? x.confidence ?? 0) >= 0.5)
        .map(x => ({ x, s: (x.score ?? x.confidence ?? 0) + 0.5 * words(x.text).filter(w => asked.includes(w) && !words(x.matched).includes(w)).length }))
        .sort((a, b) => b.s - a.s).map(({ x }) => x);
      const h = rankSaid(hits.data || [], q, { scratch });
      const said = f[0] ? null : yourAnswer(h[0], q);
      const answer = f[0] ? String(f[0].text) : said;
      const confidence = f[0] ? confidenceOf(f[0]) : said ? SAID_CONFIDENCE : null;
      return { answer, confidence, ms: now() - t0, via: f[0] ? "fact" : said ? "said" : null };
    },
    answer: null,
  };
  if (mem.has("memory.answer")) {
    out.answer = async q => {
      const t0 = now();
      let r;
      try { r = await mem.call("memory.answer", { q }); } catch (e) { return { answer: null, confidence: null, ms: now() - t0, via: null, error: /** @type {Error} */ (e).message }; }
      const d = r && typeof r === "object" && "data" in r ? r.data : r;
      // What an answer stood on, without its words: each fact's relation and the methods of the
      // claims behind it (rule, indirect, lower, model, assistant), for the sealed world's report.
      const db = mem.ctx.store.db;
      const basis = (d?.facts || []).map(f => ({ rel: f.rel, methods: [...new Set(/** @type {any[]} */ (db.prepare(`SELECT c.method FROM memory_me_evidence v
        JOIN memory_me_claims c ON c.session = v.session AND c.seq = v.seq AND c.rel = ? WHERE v.fact = ?`).all(f.rel, String(f.id))).map(x => String(x.method)))] }));
      return { answer: d?.answer ?? null, confidence: typeof d?.confidence === "number" ? d.confidence : null, ms: now() - t0, via: d?.via ?? null, basis };
    };
  }
  return out;
}

/**
 * Run the evaluation on the personal world. Returns { world, answerers: { before, answer } },
 * where an answerer the code does not have is { supported: false, reason }.
 * @param {{ world?: string, gold?: any, sessions?: any[], me?: any, now?: number, scratch?: string, vectors?: boolean, only?: string[] }} [opts]
 */
export async function runEval(opts = {}) {
  if (opts.world) {
    const w = WORLDS[opts.world];
    if (!w) throw new Error(`no world called ${opts.world} (${Object.keys(WORLDS).join(", ")})`);
    opts = { ...w(), ...opts };
  }
  const gold = opts.gold || JSON.parse(fs.readFileSync(GOLD_FILE, "utf8"));
  const questions = gold.questions;
  const sessions = opts.sessions || PERSONAL_SESSIONS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-eval-answer-"));
  const realNow = Date.now;
  Date.now = () => opts.now ?? NOW;
  let db, mem;
  try {
    db = open(path.join(dir, "vyre.db"));
    // A throwaway store: no fsync per row, or seeding 1,500 turns waits on the disk for seconds.
    db.exec("PRAGMA synchronous = OFF");
    seedRecall(db, sessions);
    const t0 = now();
    const embedder = opts.vectors === false ? null : fakeEmbedder();
    const dense = embedder ? new Dense(db) : null;
    if (embedder) await embedAll(db, embedder);
    const embedMs = now() - t0;
    // The reader's reads: replayed from test/eval/reads/<world>.json, recorded with --record,
    // or left out with --no-model (the rules alone).
    const readsFile = path.join(ROOT, "test/eval/reads", `${opts.world || "personal"}.json`);
    const mode = opts.model || "replay";
    const runner = mode === "record" ? claudeOnce({ cwd: dir }) : null;
    mem = await startMemory(db, { me: opts.me || ME, embedder, dense, runner });
    if (mode !== "off" && fs.existsSync(readsFile)) {
      const kept = JSON.parse(fs.readFileSync(readsFile, "utf8"));
      if (kept.version === VERSION) {
        const ins = db.prepare("INSERT OR REPLACE INTO memory_me_reads (hash, v, at, facts, usd) VALUES (?,?,?,?,?)");
        for (const [h, f] of Object.entries(kept.reads || {})) ins.run(h, VERSION, 0, JSON.stringify(f), 0);
      }
    }
    const t1 = now();
    await mem.call("memory.curate", { full: true });
    let recorded = null;
    if (mode === "record") {
      const got = await mem.call("memory.read", { now: true, max_runs: 1000 });
      recorded = { ...got.ran, ...(got.ran.waiting ? { why: got.status.last?.result ?? null } : {}) };
      const reads = Object.fromEntries(/** @type {any[]} */ (db.prepare("SELECT hash, facts FROM memory_me_reads WHERE v = ? ORDER BY hash").all(VERSION)).map(r => [String(r.hash), JSON.parse(String(r.facts))]));
      fs.mkdirSync(path.dirname(readsFile), { recursive: true });
      fs.writeFileSync(readsFile, JSON.stringify({ version: VERSION, model: modelFor({}), reads }, null, 1) + "\n");
    }
    const curateMs = now() - t1;
    const waitingTurns = Number(/** @type {any} */ (db.prepare("SELECT COUNT(DISTINCT hash) n FROM memory_me_queue").get()).n);
    const count = sql => Number(/** @type {any} */ (db.prepare(sql).get()).n);
    const world = {
      sessions: count("SELECT COUNT(*) n FROM recall_sessions"),
      turns: count("SELECT COUNT(*) n FROM recall_turns"),
      vectors: embedder ? count("SELECT COUNT(*) n FROM recall_vectors") : 0,
      embedder: embedder ? "fake (hashed words)" : "none (keyword only)",
      questions: questions.length,
      unknowns: questions.filter(q => !q.expect).length,
      model: mode, unread_turns: waitingTurns, ...(recorded ? { recorded } : {}),
      embed_ms: round(embedMs),
      curate_ms: round(curateMs),
    };
    // --facts: the personal facts the world left, for working on the rules (never on the sealed world).
    if (opts.facts) world.facts = /** @type {any[]} */ (db.prepare(`SELECT subj, rel, obj, obj_label, confidence, current, sessions,
      (SELECT group_concat(DISTINCT c.method) FROM memory_me_claims c WHERE c.rel = f.rel AND c.obj = f.obj) methods FROM memory_me_facts f ORDER BY subj, rel, confidence DESC`).all());
    // --claims <text>: every claim whose subject or object has that text, with where it came from.
    if (opts.claims) world.claims = /** @type {any[]} */ (db.prepare("SELECT session, seq, subj, rel, obj, conf, method FROM memory_me_claims WHERE subj LIKE ? OR obj LIKE ? ORDER BY ts").all(`%${opts.claims}%`, `%${opts.claims}%`));
    const all = answerers(mem, opts.scratch || SCRATCH);
    /** @type {Record<string, any>} */
    const results = {};
    for (const [name, fn] of Object.entries(all)) {
      if (opts.only && !opts.only.includes(name)) continue;
      if (!fn) { results[name] = { supported: false, reason: `the memory module has no ${name === "answer" ? "memory.answer" : name} tool yet` }; continue; }
      const got = [];
      for (const g of questions) got.push(await fn(g.q));
      // Determinism (ADR 0034): the same question over the same facts gives the same answer,
      // confidence and sources, every time. Asked twice more.
      let inconsistent = 0;
      if (name === "answer") for (let k = 0; k < 2; k++) for (let i = 0; i < questions.length; i++) {
        if (stable(await fn(questions[i].q)) !== stable(got[i])) inconsistent++;
      }
      results[name] = { supported: true, ...score(questions, got), inconsistent, answers: questions.map((g, i) => ({ q: g.q, answer: got[i].answer, confidence: round(got[i].confidence), via: got[i].via ?? null, basis: got[i].basis ?? [] })) };
    }
    return { world, answerers: results };
  } finally {
    Date.now = realNow;
    try { await mem?.stop(); } catch {}
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the report

function print(r) {
  const w = r.world;
  const out = [];
  out.push(`eval-answer: ${w.sessions} sessions, ${w.turns} turns, ${w.vectors} vectors (${w.embedder}); ${w.questions} questions, ${w.unknowns} with no answer`);
  out.push(`  embedded in ${Math.round(w.embed_ms)} ms, curated in ${Math.round(w.curate_ms)} ms`);
  out.push(`  reader: ${w.model}, ${w.unread_turns} turns with no read${w.recorded ? `; recorded ${w.recorded.read} turns in ${w.recorded.runs} runs for $${w.recorded.usd}${w.recorded.read ? ` ($${Math.round(w.recorded.usd / w.recorded.read * 1e6) / 1e3} per 1,000 turns)` : ""}${w.recorded.waiting ? `, stopped: ${w.recorded.waiting}${w.recorded.why ? ` (${w.recorded.why})` : ""}` : ""}` : ""}`);
  for (const [name, a] of Object.entries(r.answerers)) {
    out.push("");
    if (!a.supported) { out.push(`${name}: unsupported (${a.reason})`); continue; }
    out.push(`${name}:`);
    out.push(`  precision@1         ${a.precision_at_1}`);
    out.push(`  no-answer accuracy  ${a.no_answer_accuracy}`);
    out.push(`  confident-wrong     ${a.confident_wrong}`);
    if (a.ungrounded != null) out.push(`  ungrounded          ${a.ungrounded}`);
    if (a.inconsistent != null && name === "answer") out.push(`  inconsistent        ${a.inconsistent} (each question asked three times)`);
    out.push(`  overall             ${a.overall}`);
    out.push(`  latency p50/p95     ${a.p50_ms} / ${a.p95_ms} ms`);
    out.push(`  failures (${a.failures.length}):`);
    for (const f of a.failures) {
      const ans = f.answer ? `"${String(f.answer).slice(0, 90)}"` : "(none)";
      out.push(`    [${f.why}] ${f.q}  ->  ${ans}${f.confidence != null ? ` @${round(f.confidence)}` : ""}${f.expect ? `  (want ${f.expect.join(" | ")})` : ""}`);
    }
  }
  process.stdout.write(out.join("\n") + "\n");
}

/** The bar memory.answer must clear (test/eval/answer-eval.test.js holds it too). */
export const BAR = { overall: 0.9, confident_wrong: 0, p95_ms: 150, ungrounded: 0, inconsistent: 0 };

/** Why the answer bar fails, or [] when it holds. */
export function barFailures(a) {
  if (!a || !a.supported) return [`memory.answer is not there: ${a?.reason || "unknown"}`];
  const out = [];
  if (!(a.overall >= BAR.overall)) out.push(`overall ${a.overall} is under ${BAR.overall}`);
  if (a.confident_wrong > BAR.confident_wrong) out.push(`${a.confident_wrong} confident wrong answer(s)`);
  if (!(a.p95_ms < BAR.p95_ms)) out.push(`p95 ${a.p95_ms} ms is not under ${BAR.p95_ms} ms`);
  if (a.ungrounded > BAR.ungrounded) out.push(`${a.ungrounded} answer(s) told as fact with no fact or turn behind them`);
  if (a.inconsistent > BAR.inconsistent) out.push(`${a.inconsistent} answer(s) changed when asked again`);
  return out;
}

async function main(argv) {
  const wi = argv.indexOf("--world");
  const world = wi >= 0 ? argv[wi + 1] : "personal";
  if (argv.includes("--facts") && world === "sealed") throw new Error("the sealed world is sealed: no --facts");
  const model = argv.includes("--record") ? "record" : argv.includes("--no-model") ? "off" : "replay";
  const ai = argv.indexOf("--ask");
  if (ai >= 0 && world === "sealed") throw new Error("the sealed world is sealed: no --ask");
  const ci = argv.indexOf("--claims");
  if (ci >= 0 && world === "sealed") throw new Error("the sealed world is sealed: no --claims");
  const r = await runEval({ world, vectors: !argv.includes("--keyword"), facts: argv.includes("--facts"), model, claims: ci >= 0 ? argv[ci + 1] : null,
    ...(ai >= 0 ? { gold: { questions: [{ q: argv[ai + 1], expect: null }] }, full: true } : {}) });
  if (ai >= 0) { process.stdout.write(JSON.stringify(r.answerers.answer.answers[0], null, 1) + "\n"); return; }
  if (r.world.claims) for (const c of r.world.claims) process.stdout.write(`  ${c.subj} ${c.rel} ${c.obj} @${round(c.conf)} ${c.method} ${String(c.session).slice(-4)}:${c.seq}\n`);
  if (r.world.facts) for (const f of r.world.facts) process.stdout.write(`  ${f.current ? " " : "x"} ${f.subj} ${f.rel} ${f.obj_label || f.obj} @${round(f.confidence)} (${f.sessions}) ${f.methods || ""}\n`);
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else print(r);
  // CI runs this: a memory.answer under the bar fails the build.
  const bad = barFailures(r.answerers.answer);
  if (bad.length) { process.stderr.write(`eval-answer: the memory.answer bar fails: ${bad.join("; ")}\n`); process.exitCode = 1; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`eval-answer: ${e.message}\n`); process.exit(1); });
}
