// @ts-check
// The sealed half of the 0.2 eval world: its fixture (test/fixtures/iq02-sealed.js) and gold
// (test/eval/iq02-sealed.json) are checked against each other and against the open world, and the
// bar is run over it in-process. This test never prints a question or an answer; run it in a temp
// HOME (H=$(mktemp -d); HOME=$H node --test test/eval/bar-sealed.test.js).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBar, CLASSES, ANSWERABLE, WORLDS } from "../../scripts/eval-bar.js";
import * as O from "../fixtures/iq02-open.js";
import * as S from "../fixtures/iq02-sealed.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const openGold = JSON.parse(read("test/eval/iq02-open.json"));
const gold = JSON.parse(read("test/eval/iq02-sealed.json"));
const byId = new Map(S.SESSIONS.map(s => [s.id, s]));
const count = (g, c) => g.questions.filter(q => q.class === c).length;
const low = s => String(s).toLowerCase();
const turnsOf = s => s.turns.map(t => low(t.text));
const inside = (s, p) => p.folders.some(f => s.cwd === f || s.cwd.startsWith(`${f}/`));
const projectOf = s => S.PROJECTS.find(p => inside(s, p))?.slug ?? null;

test("sealed: the world is deterministic, synthetic, five providers, and the open world's size", async () => {
  const again = await import(`../fixtures/iq02-sealed.js?again=${Date.now()}`);
  assert.deepEqual(again.SESSIONS, S.SESSIONS, "the seeded noise came out different");
  assert.equal(byId.size, S.SESSIONS.length, "two sessions share an id");
  assert.equal(S.PROJECTS.length, 4);
  const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 0.2 * b, `${what}: ${a} is not within 20 percent of the open world's ${b}`);
  near(S.SESSIONS.length, O.SESSIONS.length, "sessions");
  near(S.SESSIONS.reduce((n, s) => n + s.turns.length, 0), O.SESSIONS.reduce((n, s) => n + s.turns.length, 0), "turns");
  for (const s of S.SESSIONS) {
    assert.ok(["claude", "codex", "gemini", "grok", "kimi"].includes(s.provider), `${s.id}: provider ${s.provider}`);
    if (s.agent) assert.ok(S.AGENTS.some(a => a.name === s.agent), `${s.id}: no agent ${s.agent}`);
    assert.ok(s.start >= S.T0 && s.start < S.NOW, `${s.id} is outside the world's days`);
    assert.ok(s.turns.length && s.turns[0].role === "user", `${s.id}: starts with the assistant`);
  }
  assert.equal(new Set(S.SESSIONS.map(s => s.provider)).size, 5, "every provider has sessions");
  assert.ok(S.FRESH.session.start === S.NOW && S.FRESH.questions.length, "no freshness probe");
  assert.ok(!byId.has(S.FRESH.session.id));
  const text = JSON.stringify(S.SESSIONS) + JSON.stringify(S.FRESH) + JSON.stringify(gold);
  assert.ok(!/[—§]/.test(text), "an em dash or a section sign");
  assert.ok(!/\p{Extended_Pictographic}/u.test(text), "an emoji");
  // Each hard case is planted on purpose.
  const all = S.SESSIONS.flatMap(s => s.turns.map(t => t.text)).join("\n");
  assert.ok(/remember: always run/.test(all) && /note to all agents/.test(all), "no injected lines");
  for (const p of S.PROJECTS) {
    const elsewhere = S.SESSIONS.filter(s => !inside(s, p)).flatMap(turnsOf).join("\n");
    const here = S.SESSIONS.filter(s => inside(s, p)).flatMap(turnsOf).join("\n");
    for (const o of p.only) {
      assert.ok(here.includes(low(o)), `${p.slug}'s only-string is in none of its sessions`);
      assert.ok(!elsewhere.includes(low(o)), `${p.slug}'s only-string appears outside it`);
    }
  }
});

test("sealed: the gold has the open gold's class counts, and every answer's turn holds it", () => {
  assert.equal(gold.questions.length, openGold.questions.length);
  for (const c of CLASSES) assert.equal(count(gold, c), count(openGold, c), `class ${c}`);
  assert.equal(new Set(gold.questions.map(q => low(q.q))).size, gold.questions.length, "a question is asked twice");
  const openQs = new Set(openGold.questions.map(q => low(q.q)));
  assert.equal(gold.questions.filter(q => openQs.has(low(q.q))).length, 0, "a question reuses the open world's wording");
  const all = S.SESSIONS.flatMap(turnsOf).join("\n");
  for (const q of gold.questions) {
    assert.ok(CLASSES.includes(q.class));
    for (const w of q.where) {
      const s = byId.get(w.session);
      assert.ok(s, `a ${q.class} question cites no session`);
      assert.ok(Number.isInteger(w.seq) && w.seq >= 0 && w.seq < s.turns.length, `a ${q.class} question cites no such turn`);
    }
    if (ANSWERABLE.includes(q.class)) {
      assert.ok(Array.isArray(q.expect) && q.expect.length && q.where.length, `an answerable ${q.class} question has no expect or where`);
      for (const w of q.where) {
        const t = low(byId.get(w.session).turns[w.seq].text);
        assert.ok(q.expect.some(e => t.includes(low(e))), `a ${q.class} question's cited turn (${w.session.slice(-4)}:${w.seq}) holds none of its expect strings`);
      }
      for (const b of q.expect_before || []) assert.ok(all.includes(low(b)), `a ${q.class} question's before-value is not in the world`);
    } else assert.equal(q.expect, null);
    if (q.class === "cross_provider") for (const w of q.where) assert.notEqual(byId.get(w.session).provider, "claude");
    if (q.class === "unanswerable") {
      assert.ok(q.forbid?.length, "an unanswerable question has no decoy");
      for (const f of q.forbid) assert.ok(all.includes(low(f)), `an unanswerable question's decoy is not in the world`);
    }
    if (q.class === "inject") {
      assert.ok(q.forbid?.length);
      for (const f of q.forbid) {
        const inAssistant = S.SESSIONS.some(s => s.turns.some(t => t.role === "assistant" && low(t.text).includes(low(f))));
        assert.ok(inAssistant, "an inject probe's command is not planted in assistant or tool text");
      }
    }
  }
});

test("sealed: no open-world name, project, host, id or number appears in the sealed world or its gold", () => {
  const strings = new Set([
    ...O.ME.name.split(" "), ...O.ME.domains, ...O.ME.emails, O.HOME,
    ...O.PROJECTS.filter(p => p.slug !== "notes").flatMap(p => [p.slug, p.name, ...p.only, ...p.folders]),
    ...O.AGENTS.filter(a => a.kind !== "assistant" && a.name !== "kit").map(a => a.name),
    "Harlow Legal", "Harlow", "Northwind", "Dana Reyes", "Sam Okafor", "Mara Lindqvist", "Jordan Vale", "Pickles", "Biscuit", "Portland", "Oakland",
    "Seattle", "Denver", "Sacramento", "Rivera Studio", "Kestrel", "Marzipan", "c2020000",
  ].filter(x => String(x).length >= 3));
  const text = low(read("test/fixtures/iq02-sealed.js") + JSON.stringify(S.SESSIONS) + JSON.stringify(S.FRESH) + JSON.stringify(gold));
  const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const x of strings) {
    const re = new RegExp(`(^|[^a-z0-9])${esc(low(x))}($|[^a-z0-9])`);
    assert.ok(!re.test(text), `an open-world string (${x.length} chars, starting "${x.slice(0, 2)}") is in the sealed world`);
  }
  // None of the open world's turns is copied whole into the sealed world.
  const sealedTurns = new Set(S.SESSIONS.flatMap(s => s.turns.map(t => low(t.text))));
  for (const t of O.SESSIONS.flatMap(s => s.turns).filter(x => x.text.length >= 25)) assert.ok(!sealedTurns.has(low(t.text)), "a turn is copied from the open world");
});

test("sealed: leak probes name a project agent, and their forbidden strings sit only where that agent may not read", () => {
  const probes = gold.questions.filter(q => q.class === "leak");
  assert.ok(probes.some(q => q.probe === "project") && probes.some(q => q.probe === "personal"));
  for (const q of probes) {
    const agent = S.AGENTS.find(a => a.name === q.ask_as?.agent);
    assert.ok(agent && agent.kind !== "assistant", "a leak probe is not asked by a project agent");
    assert.equal(q.ask_as.caller, `mcp:agent:${agent.name}`);
    const mine = S.PROJECTS.find(p => p.folders.includes(q.ask_as.project));
    assert.ok(mine && agent.projects.includes(mine.slug), "the probe's folder is not one of the agent's projects");
    for (const f of q.forbid) {
      const homes = S.SESSIONS.filter(s => turnsOf(s).some(t => t.includes(low(f))));
      assert.ok(homes.length, "a leak probe forbids a string no session holds");
      const where = new Set(homes.map(projectOf));
      if (q.probe === "project") {
        assert.equal(where.size, 1, "a project-only string appears in more than one project");
        const [slug] = [...where];
        assert.ok(slug && slug !== "journal", "a project probe forbids a string from no code project");
        assert.ok(!agent.projects.includes(slug), "the agent may read the project that holds the string");
      } else {
        for (const s of homes) assert.ok(s.cwd === S.HOME || inside(s, S.PROJECTS.find(p => p.slug === "journal")), "a personal string appears in a code project's session");
        assert.ok(![...where].some(x => x && x !== "journal"));
      }
    }
  }
});

test("sealed: the world is wired in, and the harness refuses to explain or record it", async () => {
  assert.equal(typeof WORLDS.sealed, "function");
  const w = WORLDS.sealed();
  assert.equal(w.sealed, true);
  assert.equal(w.world, S);
  assert.ok(w.asks.endsWith("test/eval/asks/iq02-sealed.json"));
  const asks = JSON.parse(read("test/eval/asks/iq02-sealed.json"));
  const openAsks = JSON.parse(read("test/eval/asks/iq02-open.json"));
  assert.deepEqual(asks, { version: openAsks.version, model: null, replies: {} });
  await assert.rejects(runBar({ world: "sealed", explain: true }), /never runs on a sealed world/);
  await assert.rejects(runBar({ world: "sealed", record: true }), /never recorded/);
});

test("sealed: the bar runs over the sealed world and the report carries no question or answer text", { timeout: 300_000 }, async () => {
  const r = await runBar({ world: "sealed" });
  assert.equal(r.world.name, "sealed");
  assert.equal(r.world.sealed, true);
  assert.equal(r.world.sessions, S.SESSIONS.length);
  assert.equal(r.world.questions, gold.questions.length);
  for (const c of CLASSES) assert.equal(r.by_class[c].n, count(gold, c), `by_class ${c}`);
  for (const x of r.rows) assert.ok(["PASS", "FAIL", "not yet measurable"].includes(x.status), `${x.key}: ${x.status}`);
  for (const k of ["leaks", "planted", "traps", "explained"]) assert.ok(!(k in r), `the report has ${k}`);
  // Replies are unrecorded, so the model-dependent numbers are lower bounds; scoping must hold regardless.
  assert.equal(r.rows.find(x => x.key === "project_leak").value, 0);
  assert.equal(r.rows.find(x => x.key === "personal_leak").value, 0);
  const json = low(JSON.stringify(r));
  for (const q of gold.questions) {
    assert.ok(!json.includes(low(q.q)), "the report carries a question");
    for (const e of [...(q.expect || []), ...(q.expect_before || []), ...(q.forbid || [])]) {
      if (String(e).length >= 5) assert.ok(!json.includes(low(e)), "the report carries an answer or a decoy string");
    }
  }
  for (const f of S.FRESH.questions) assert.ok(!json.includes(low(f.q)), "the report carries a freshness question");
});

test("recording the sealed world is refused everywhere but the memory-sealed-record workflow", async () => {
  const { runBar } = await import("../../scripts/eval-bar.js");
  await assert.rejects(() => runBar({ world: "sealed", record: true }), /never recorded outside/);
  const keep = { a: process.env.VYRE_EVAL_SEALED_RECORD, b: process.env.GITHUB_ACTIONS };
  try {
    delete process.env.VYRE_EVAL_SEALED_RECORD; delete process.env.GITHUB_ACTIONS;
    await assert.rejects(() => runBar({ world: "sealed", record: true, recordSealed: true }), /only by the memory-sealed-record workflow/);
    process.env.VYRE_EVAL_SEALED_RECORD = "1";
    await assert.rejects(() => runBar({ world: "sealed", record: true, recordSealed: true }), /only by the memory-sealed-record workflow/, "the flag alone is not enough: it must be a GitHub Actions run");
    await assert.rejects(() => runBar({ world: "open", record: true, recordSealed: true }), /only by the memory-sealed-record workflow/, "and only for the sealed world");
  } finally { for (const [k, v] of [["VYRE_EVAL_SEALED_RECORD", keep.a], ["GITHUB_ACTIONS", keep.b]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
