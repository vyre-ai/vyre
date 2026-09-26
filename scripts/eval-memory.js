#!/usr/bin/env node
// @ts-check
// eval-memory: is what Memory believes right, and does it stay in its room?
// (docs/adr/0007-intelligence.md, decision 5)
//
//   node scripts/eval-memory.js                    the fictional world, as a report
//   node scripts/eval-memory.js --json             the same, as JSON
//   node scripts/eval-memory.js --write-baseline   also writes test/eval/memory-baseline.json
//   node scripts/eval-memory.js --real <vyre.db>   a COPY of a real index: counts and timings only
//
// The world run builds a temporary store under os.tmpdir(), seeds the evaluation corpus the way
// the tests seed Recall, starts the memory module against it with a stand-in for the daemon, runs
// curation and then asks the module's own tools. Nothing it reads is the user's.
//
// Anything the current code does not do yet (a relation it never writes, a room it cannot be
// asked for) is reported as "unsupported", not as zero, and never throws.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { open } from "../core/store/index.js";
import { seedRecall } from "../test/fixtures/corpus.js";
import { EVAL_SESSIONS, PROJECTS, ME, NOW, foldersOf } from "../test/fixtures/memory-world.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GOLD_FILE = path.join(ROOT, "test/eval/memory-gold.json");
export const BASELINE_FILE = path.join(ROOT, "test/eval/memory-baseline.json");

/** Relations the curator writes today; any other relation counts as supported once it is seen. */
const KNOWN_RELS = new Set(["works_at", "has_email", "has_domain", "at_domain", "owned_by"]);
/** Groups the ADR sets thresholds for. */
const GROUPS = {
  identity: ["has_email", "has_domain", "at_domain", "owned_by"],
  works_at: ["works_at"],
  new: ["has_title", "client_of", "repo_for", "deadline", "prefers", "decided"],
};
/** Relations with one right object per subject: a different object than gold's is a wrong fact. */
const SINGLE = new Set(["works_at", "has_title", "has_domain", "client_of", "deadline"]);

/** The ADR's targets (decision 5). `max` for timings, `min` for everything else. */
export const THRESHOLDS = [
  { key: "leakage", max: 0, label: "leakage is 0" },
  { key: "identity.precision", min: 0.95, label: "identity precision 0.95" },
  { key: "identity.recall", min: 0.85, label: "identity recall 0.85" },
  { key: "works_at.precision", min: 0.95, label: "works_at precision 0.95" },
  { key: "new.precision", min: 0.85, label: "new relations precision 0.85" },
  { key: "new.recall", min: 0.85, label: "new relations recall 0.85" },
  { key: "enrich.p_at_3", min: 0.8, label: "Enrich P@3 0.8" },
  { key: "irrelevant.empty_rate", min: 0.95, label: "empty on irrelevant prompts 0.95" },
  { key: "relevant.p95_ms", max: 5, label: "relevant p95 under 5 ms" },
];

// ------------------------------------------------------------------ matching

/** Split a fact id into its three parts. Node ids hold no "|", but keep any extra in dst. */
const parts = id => { const p = String(id).split("|"); return [p[0], p[1], p.slice(2).join("|")]; };

/** Does a gold pattern (parts may be "*" or "~a;b") match a fact id? */
export function matches(pattern, id) {
  const p = parts(pattern), f = parts(id);
  return p.every((x, i) => x === "*" || (x.startsWith("~")
    ? x.slice(1).toLowerCase().split(";").some(w => f[i].toLowerCase().includes(w))
    : x === f[i]));
}

const ratio = (a, b) => (b ? a / b : null);
const round = x => (x === null || x === undefined || typeof x !== "number" ? x : Math.round(x * 1000) / 1000);
const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };

// ------------------------------------------------------------------ the module, in-process

/**
 * Start the memory module against db with a stand-in for vyred: projects.list answers with the
 * world's projects, there are no agents, and events go nowhere.
 */
async function startMemory(db, { me, projects }) {
  const tools = new Map();
  const ctx = {
    name: "memory",
    config: { me, role: "local" },
    paths: {},
    store: { db, migrate: () => {} },
    log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    memory: { teach: async () => false },
    vault: { fetch: async () => { throw new Error("no vault in the evaluation"); } },
    call: async (tool, input) => {
      if (tool === "projects.list") return { data: projects };
      if (tool === "projects.of") {
        const cwd = String(input?.cwd || "");
        const p = projects.find(p => foldersOf(p).some(f => cwd === f || cwd.startsWith(f + "/")));
        return { data: p || null };
      }
      return { error: { code: "no_such_tool", message: `${tool} is not in the evaluation` } };
    },
    tool: (name, def) => tools.set(name, def),
  };
  const mod = (await import("../core/memory/index.js")).default;
  const handle = await mod.start(ctx);
  /** Call one of memory's tools as the CLI would. */
  const call = async (name, input = {}) => {
    const t = tools.get(name);
    if (!t) throw new Error(`memory has no tool ${name}`);
    return t.run(input, { caller: "cli" });
  };
  return { call, stop: () => handle.stop() };
}

/**
 * What to pass for a room. Projects are asked by slug and by folders (the picked threads come
 * from projects.list when Memory reads them); unfiled only by name, which the code may not take.
 */
function roomInput(room, projects) {
  if (room === "*") return {};
  if (room.startsWith("project:")) {
    const p = projects.find(p => "project:" + p.slug === room);
    if (!p) throw new Error(`gold names ${room}, which is not a project in the world`);
    return { project: p.slug, project_cwds: foldersOf(p) };
  }
  return { room };
}

/** Every fact memory holds in a room, as { id, open }, or null when the room cannot be asked for. */
async function roomFacts(call, room, input) {
  let g;
  try { g = await call("memory.graph", { ...input, limit: 500 }); } catch (e) { return { supported: false, reason: /** @type {Error} */ (e).message }; }
  if (room === "unfiled") {
    // Supported only if the answer is the unfiled room itself, not the main graph drawn anyway.
    const ok = g && (g.scope === "unfiled" || (g.scope !== "main" && g.rooms?.length === 1 && g.rooms[0].id === "unfiled"));
    if (!ok) return { supported: false, reason: "memory.graph has no unfiled room" };
  }
  const facts = (g.edges || []).filter(e => e.rel !== "mentioned_in").map(e => ({ id: String(e.id), rel: String(e.rel), open: e.until === null || e.until === undefined }));
  const sessions = new Set((g.edges || []).filter(e => e.rel === "mentioned_in").map(e => String(e.dst).slice(8)));
  return { supported: true, facts, sessions, truncated: Boolean(g.truncated) };
}

// ------------------------------------------------------------------ the world run

/**
 * Run the evaluation on the fictional world and return the report.
 * @param {{ gold?: any, sessions?: any[], projects?: any[], me?: any, now?: number, calls?: number }} [opts]
 */
export async function runEval({ gold = JSON.parse(fs.readFileSync(GOLD_FILE, "utf8")), sessions = EVAL_SESSIONS, projects = PROJECTS, me = ME, now = NOW, calls = 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-eval-memory-"));
  const realNow = Date.now;
  // Ages and decay are read from the clock; the world is dated, so the clock is too.
  Date.now = () => now;
  let db, mem;
  try {
    db = open(path.join(dir, "vyre.db"));
    seedRecall(db, sessions);
    mem = await startMemory(db, { me, projects });
    const t0 = process.hrtime.bigint();
    const cur = await mem.call("memory.curate", { full: true });
    const curateMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const rooms = [...new Set([...gold.facts, ...gold.absent, ...gold.prompts, ...gold.irrelevant].map(x => x.room))];
    /** @type {Map<string, any>} */
    const views = new Map();
    for (const room of rooms) views.set(room, { input: roomInput(room, projects), ...(await roomFacts(mem.call, room, roomInput(room, projects))) });

    // Relations: known ones, plus any the code wrote somewhere.
    const seenRels = new Set(KNOWN_RELS);
    for (const v of views.values()) for (const f of v.facts || []) seenRels.add(f.rel);
    const relOf = id => parts(id)[1];
    const supportedRel = rel => seenRels.has(rel);

    // ---- facts: per room and relation
    /** @type {Record<string, Record<string, { tp: number, fn: number, fp: number }>>} */
    const cells = {};
    const cell = (room, rel) => ((cells[room] ||= {})[rel] ||= { tp: 0, fn: 0, fp: 0 });
    const missed = [], wrongly = [], leaks = [];
    for (const f of gold.facts) {
      const v = views.get(f.room);
      if (!v.supported || !supportedRel(relOf(f.id))) continue;
      const hit = v.facts.find(x => matches(f.id, x.id) && x.open === (f.open !== false));
      if (hit) cell(f.room, relOf(f.id)).tp++;
      else { cell(f.room, relOf(f.id)).fn++; missed.push({ room: f.room, id: f.id }); }
    }
    for (const [room, v] of views) {
      if (!v.supported) continue;
      const goldHere = gold.facts.filter(f => f.room === room);
      const absentHere = gold.absent.filter(a => a.room === room);
      for (const x of v.facts.filter(x => x.open)) {
        if (goldHere.some(f => matches(f.id, x.id))) continue;
        const bad = absentHere.find(a => matches(a.id, x.id));
        // A second object for something that has one: gold says who Dana works for here, so any
        // other employer is wrong.
        const [src, rel] = parts(x.id);
        const other = !bad && SINGLE.has(rel) && goldHere.some(f => parts(f.id)[0] === src && parts(f.id)[1] === rel);
        if (!bad && !other) continue;
        cell(room, rel).fp++;
        const why = bad ? bad.why : "wrong";
        wrongly.push({ room, id: x.id, why });
        if (why === "leak") leaks.push({ room, id: x.id, via: "facts" });
      }
    }

    const sum = (pred) => {
      let tp = 0, fn = 0, fp = 0;
      for (const [room, rels] of Object.entries(cells)) for (const [rel, c] of Object.entries(rels)) if (pred(room, rel)) { tp += c.tp; fn += c.fn; fp += c.fp; }
      return { tp, fn, fp, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) };
    };
    const byRel = {};
    for (const rel of new Set(gold.facts.map(f => relOf(f.id)))) {
      byRel[rel] = supportedRel(rel) ? sum((_, r) => r === rel) : "unsupported";
    }
    const byRoom = {};
    for (const [room, v] of views) {
      byRoom[room] = v.supported ? { ...sum(r => r === room), picked: pickedIn(room, v, projects), truncated: v.truncated } : "unsupported";
    }
    const byGroup = {};
    for (const [g, rels] of Object.entries(GROUPS)) {
      const live = rels.filter(r => supportedRel(r) && gold.facts.some(f => relOf(f.id) === r));
      byGroup[g] = live.length ? { ...sum((_, r) => live.includes(r)), relations: live } : "unsupported";
    }

    // ---- Enrich: precision in the top k, and whether any right fact made it
    const enrich = [];
    for (const p of gold.prompts) {
      const v = views.get(p.room);
      if (!v.supported) { enrich.push({ text: p.text, room: p.room, unsupported: true }); continue; }
      const got = await mem.call("memory.relevant", { text: p.text, ...v.input, limit: p.k || 3 });
      const top = (Array.isArray(got) ? got : []).slice(0, p.k || 3);
      const hits = top.filter(r => p.expect.some(e => matches(e, r.id)));
      for (const r of top) {
        const a = gold.absent.find(a => a.room === p.room && a.why === "leak" && matches(a.id, r.id));
        if (a) leaks.push({ room: p.room, id: r.id, via: "relevant" });
      }
      enrich.push({ text: p.text, room: p.room, got: top.map(r => r.id), hits: hits.length, p: top.length ? hits.length / top.length : 0, any: hits.length > 0 });
    }
    const scored = enrich.filter(e => !e.unsupported);

    // ---- irrelevant prompts: nothing should come back
    const irrelevant = [];
    for (const q of gold.irrelevant) {
      const v = views.get(q.room);
      if (!v.supported) { irrelevant.push({ text: q.text, room: q.room, unsupported: true }); continue; }
      const got = await mem.call("memory.relevant", { text: q.text, ...v.input, limit: 3 });
      const list = Array.isArray(got) ? got : [];
      for (const r of list) {
        const a = gold.absent.find(a => a.room === q.room && a.why === "leak" && matches(a.id, r.id));
        if (a) leaks.push({ room: q.room, id: r.id, via: "relevant" });
      }
      irrelevant.push({ text: q.text, room: q.room, got: list.map(r => r.id), empty: list.length === 0 });
    }
    const judged = irrelevant.filter(x => !x.unsupported);

    // ---- relevant timing
    const texts = [...gold.prompts, ...gold.irrelevant].filter(x => views.get(x.room).supported).map(x => ({ text: x.text, input: views.get(x.room).input }));
    const times = [];
    for (let i = 0; i < calls && texts.length; i++) {
      const x = texts[i % texts.length];
      const a = process.hrtime.bigint();
      await mem.call("memory.relevant", { text: x.text, ...x.input, limit: 3 });
      times.push(Number(process.hrtime.bigint() - a) / 1e6);
    }

    const stats = await mem.call("memory.stats", {});
    const report = {
      corpus: { sessions: sessions.length, projects: projects.length, nodes: stats.nodes, edges: stats.edges, facts: stats.facts, curate_ms: round(curateMs), changed: cur.changed },
      gold: { facts: gold.facts.length, absent: gold.absent.length, prompts: gold.prompts.length, irrelevant: gold.irrelevant.length },
      leakage: leaks.length,
      groups: roundAll(byGroup),
      relations: roundAll(byRel),
      rooms: roundAll(byRoom),
      enrich: {
        p_at_3: round(scored.length ? scored.reduce((s, e) => s + e.p, 0) / scored.length : null),
        hit_at_3: round(ratio(scored.filter(e => e.any).length, scored.length)),
        prompts: scored.length, unsupported: enrich.length - scored.length,
      },
      irrelevant: { empty_rate: round(ratio(judged.filter(x => x.empty).length, judged.length)), prompts: judged.length, unsupported: irrelevant.length - judged.length },
      relevant: { calls: times.length, p50_ms: round(pct(times, 0.5)), p95_ms: round(pct(times, 0.95)) },
      unsupported: {
        relations: [...new Set(gold.facts.map(f => relOf(f.id)))].filter(r => !supportedRel(r)).sort(),
        rooms: [...views].filter(([, v]) => !v.supported).map(([r, v]) => ({ room: r, reason: v.reason })),
        picked_threads: [...views].filter(([r, v]) => r.startsWith("project:") && v.supported && pickedIn(r, v, projects) === false).map(([r]) => r),
      },
      failures: {
        missed, wrong: wrongly, leaks,
        enrich: scored.filter(e => e.p < 1).map(e => ({ room: e.room, text: e.text, got: e.got, hits: e.hits })),
        irrelevant: judged.filter(x => !x.empty).map(x => ({ room: x.room, text: x.text, got: x.got })),
      },
    };
    report.metrics = flatten(report);
    return report;
  } finally {
    Date.now = realNow;
    if (mem) await mem.stop().catch(() => {});
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Does the room's view include the threads picked into the project? null when none are picked. */
function pickedIn(room, v, projects) {
  if (!room.startsWith("project:")) return null;
  const p = projects.find(p => "project:" + p.slug === room);
  const picked = (p?.threads || []).filter(Boolean);
  if (!picked.length) return null;
  return picked.every(id => v.sessions?.has(id));
}

function roundAll(o) {
  if (!o || typeof o !== "object") return o;
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "number" ? round(v) : v && typeof v === "object" && !Array.isArray(v) ? roundAll(v) : v]));
}

/** The numbers the baseline tracks, flat: "identity.precision", "room.project:harlow.recall", ... */
export function flatten(r) {
  const out = { leakage: r.leakage };
  const put = (prefix, o) => { if (o && typeof o === "object") for (const k of ["precision", "recall"]) if (typeof o[k] === "number") out[`${prefix}.${k}`] = o[k]; };
  for (const [g, o] of Object.entries(r.groups)) put(g, o);
  for (const [rel, o] of Object.entries(r.relations)) put("rel." + rel, o);
  for (const [room, o] of Object.entries(r.rooms)) put("room." + room, o);
  if (typeof r.enrich.p_at_3 === "number") out["enrich.p_at_3"] = r.enrich.p_at_3;
  if (typeof r.enrich.hit_at_3 === "number") out["enrich.hit_at_3"] = r.enrich.hit_at_3;
  if (typeof r.irrelevant.empty_rate === "number") out["irrelevant.empty_rate"] = r.irrelevant.empty_rate;
  if (typeof r.relevant.p95_ms === "number") out["relevant.p95_ms"] = r.relevant.p95_ms;
  return out;
}

/** Metrics that fell more than `slack` below the baseline. Timings and leakage are judged elsewhere. */
export function regressions(metrics, baseline, slack = 0.02) {
  const out = [];
  for (const [k, was] of Object.entries(baseline || {})) {
    if (k === "leakage" || k.endsWith("_ms") || typeof was !== "number") continue;
    const now = metrics[k];
    if (typeof now !== "number") { out.push({ key: k, was, now: "missing" }); continue; }
    if (now < was - slack - 1e-9) out.push({ key: k, was, now });
  }
  return out;
}

// ------------------------------------------------------------------ a real index, numbers only

/**
 * Open a copy of a real vyre.db, read-only, and time Memory's reads over it. Prints counts and
 * timings only: never a label, a fact or any text.
 */
export async function runReal(file) {
  if (!fs.existsSync(file)) throw new Error(`no database at ${file}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-eval-real-"));
  let db;
  try {
    const copy = path.join(dir, "vyre.db");
    fs.copyFileSync(file, copy);
    for (const ext of ["-wal", "-shm"]) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    // A WAL database opened read-only still needs its -shm; the copy has one if the original did.
    db = new DatabaseSync(copy, { readOnly: true });
    const has = t => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t));
    if (!has("memory_edges")) return { error: "this index has no memory tables yet" };
    const { Curator } = await import("../core/memory/curator.js");
    const { Graph } = await import("../core/memory/graph.js");
    let curator;
    try { curator = new Curator(db, { me: {} }); }
    catch { return { error: "this index's memory tables are older than the code (a migration would have to write); run vyred once, then copy it again" }; }
    const graph = new Graph(db, curator);
    const n = sql => Number(db.prepare(sql).get()?.n || 0);
    const rels = Object.fromEntries(db.prepare("SELECT rel, COUNT(*) n FROM memory_edges WHERE valid_to IS NULL GROUP BY rel ORDER BY n DESC").all().map(r => [String(r.rel), Number(r.n)])
      .filter(([rel]) => /^[a-z_]+$/.test(rel)));
    const counts = {
      sessions: has("recall_sessions") ? n("SELECT COUNT(*) n FROM recall_sessions") : 0,
      turns: has("recall_turns") ? n("SELECT COUNT(*) n FROM recall_turns") : 0,
      nodes: n("SELECT COUNT(*) n FROM memory_nodes"),
      edges: n("SELECT COUNT(*) n FROM memory_edges"),
      open_facts: n("SELECT COUNT(*) n FROM memory_edges WHERE rel != 'mentioned_in' AND valid_to IS NULL"),
      closed_facts: n("SELECT COUNT(*) n FROM memory_edges WHERE rel != 'mentioned_in' AND valid_to IS NOT NULL"),
      evidence: n("SELECT COUNT(*) n FROM memory_evidence"),
      shortforms: n("SELECT COUNT(*) n FROM memory_shortforms"),
      open_by_relation: rels,
    };
    // Queries built from the index's own labels, so they name real things; never printed.
    const labels = db.prepare("SELECT label FROM memory_nodes WHERE kind IN ('person','org') AND role IS NULL ORDER BY sessions DESC LIMIT 100").all().map(r => String(r.label));
    const queries = [...labels.map(l => `can you check what ${l} asked for`), "what's a good way to cache this function?", "run the tests again"];
    const time = fn => { const a = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - a) / 1e6; };
    const first = time(() => graph.relevant({ text: queries[0] || "hello" }));
    const rel = [], empty = [];
    for (let i = 0; i < 200; i++) {
      const q = queries[i % queries.length];
      let out = [];
      rel.push(time(() => { out = graph.relevant({ text: q }); }));
      empty.push(out.length === 0);
    }
    const facts = [];
    for (let i = 0; i < 20; i++) facts.push(time(() => graph.facts({ limit: 20 })));
    return {
      counts,
      relevant: { calls: rel.length, first_ms: round(first), p50_ms: round(pct(rel, 0.5)), p95_ms: round(pct(rel, 0.95)), empty_share: round(empty.filter(Boolean).length / empty.length) },
      facts: { calls: facts.length, p50_ms: round(pct(facts, 0.5)), p95_ms: round(pct(facts, 0.95)) },
    };
  } finally {
    try { db?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ printing

const show = x => (x === null || x === undefined ? "n/a" : typeof x === "number" ? x.toFixed(3).replace(/\.?0+$/, "") || "0" : String(x));

function print(r) {
  const line = s => process.stdout.write(s + "\n");
  line(`memory eval: ${r.corpus.sessions} sessions, ${r.corpus.projects} projects, ${r.corpus.nodes} nodes, ${r.corpus.facts} open facts, curated in ${show(r.corpus.curate_ms)} ms`);
  line(`gold: ${r.gold.facts} facts, ${r.gold.absent} absent, ${r.gold.prompts} prompts, ${r.gold.irrelevant} irrelevant`);
  line("");
  line(`leakage                ${r.leakage}${r.leakage ? "   <-- must be 0" : ""}`);
  const pr = (name, o) => line(`${name.padEnd(22)} ${typeof o === "string" ? o : `precision ${show(o.precision)}  recall ${show(o.recall)}  (tp ${o.tp}, fp ${o.fp}, fn ${o.fn})`}`);
  for (const [g, o] of Object.entries(r.groups)) pr(g, o);
  line("");
  line("by relation");
  for (const [k, o] of Object.entries(r.relations)) pr("  " + k, o);
  line("by room");
  for (const [k, o] of Object.entries(r.rooms)) pr("  " + k, o);
  line("");
  line(`enrich P@3             ${show(r.enrich.p_at_3)}  (any right fact in top 3: ${show(r.enrich.hit_at_3)}; ${r.enrich.prompts} prompts, ${r.enrich.unsupported} unsupported)`);
  line(`empty on irrelevant    ${show(r.irrelevant.empty_rate)}  (${r.irrelevant.prompts} prompts, ${r.irrelevant.unsupported} unsupported)`);
  line(`relevant               p50 ${show(r.relevant.p50_ms)} ms, p95 ${show(r.relevant.p95_ms)} ms over ${r.relevant.calls} calls`);
  if (r.unsupported.relations.length) line(`unsupported relations  ${r.unsupported.relations.join(", ")}`);
  for (const x of r.unsupported.rooms) line(`unsupported room       ${x.room}: ${x.reason}`);
  if (r.unsupported.picked_threads.length) line(`picked threads unused  ${r.unsupported.picked_threads.join(", ")} (rooms are folders only)`);
  const f = r.failures;
  if (f.leaks.length) { line(""); line("leaks"); for (const x of f.leaks) line(`  ${x.room}  ${x.id}  (${x.via})`); }
  if (f.wrong.length) { line(""); line("wrong facts"); for (const x of f.wrong) line(`  ${x.room}  ${x.id}  (${x.why})`); }
  if (f.missed.length) { line(""); line("missed facts"); for (const x of f.missed) line(`  ${x.room}  ${x.id}`); }
  if (f.enrich.length) { line(""); line("enrich below 1"); for (const x of f.enrich) line(`  ${x.room}  "${x.text}"  ${x.hits}/${x.got.length}${x.got.length ? "  " + x.got.join("  ") : ""}`); }
  if (f.irrelevant.length) { line(""); line("irrelevant prompts that got facts"); for (const x of f.irrelevant) line(`  ${x.room}  "${x.text}"  ${x.got.join("  ")}`); }
}

async function main(argv) {
  const json = argv.includes("--json");
  const i = argv.indexOf("--real");
  if (i >= 0) {
    const file = argv[i + 1];
    if (!file) throw new Error("--real needs the path of a vyre.db (a copy is read, never the file itself)");
    const r = await runReal(path.resolve(file));
    process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : Object.entries(r).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n") + "\n");
    return;
  }
  const r = await runEval();
  if (argv.includes("--write-baseline")) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify({ written: new Date(NOW).toISOString().slice(0, 10), metrics: r.metrics }, null, 2) + "\n");
  }
  if (json) process.stdout.write(JSON.stringify(r, null, 2) + "\n"); else print(r);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(e => { process.stderr.write(`eval-memory: ${e.message}\n`); process.exit(1); });
}
