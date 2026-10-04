// @ts-check
// The 0.2 quality-bar harness (scripts/eval-bar.js) and the open 0.2 world it scores. Fast: the
// gold is checked against the world, and a smoke run asks a few questions of every class. The
// full run, and whether memory passes the bar, is `npm run eval:bar` (and its --gate in CI).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBar, CLASSES, ANSWERABLE, BAR_FILE } from "../../scripts/eval-bar.js";
import * as W from "../fixtures/iq02-open.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const gold = JSON.parse(fs.readFileSync(path.join(ROOT, "test/eval/iq02-open.json"), "utf8"));
const byId = new Map(W.SESSIONS.map(s => [s.id, s]));

test("bar: the open 0.2 world is deterministic, synthetic and the size the plan asks for", async () => {
  const again = await import(`../fixtures/iq02-open.js?again=${Date.now()}`);
  assert.deepEqual(again.SESSIONS, W.SESSIONS, "the seeded noise came out different");
  assert.ok(W.SESSIONS.length >= 150, `only ${W.SESSIONS.length} sessions`);
  assert.equal(byId.size, W.SESSIONS.length, "two sessions share an id");
  assert.equal(W.PROJECTS.length, 4);
  for (const s of W.SESSIONS) {
    assert.ok(["claude", "codex", "gemini", "grok", "kimi"].includes(s.provider), `${s.id}: provider ${s.provider}`);
    if (s.agent) assert.ok(W.AGENTS.some(a => a.name === s.agent), `${s.id}: no agent ${s.agent}`);
    assert.ok(s.start >= W.T0 && s.start < W.NOW, `${s.id} is outside the world's 90 days`);
  }
  assert.ok(new Set(W.SESSIONS.map(s => s.provider)).size === 5, "every provider has sessions");
  const text = JSON.stringify(W.SESSIONS) + JSON.stringify(gold);
  assert.ok(!/[—§]/.test(text), "an em dash or a section sign in the world or the gold");
  // A project's only-strings are in no other project's sessions (else a leak probe could not tell).
  for (const p of W.PROJECTS) {
    const inside = s => p.folders.some(f => s.cwd === f || s.cwd.startsWith(`${f}/`));
    const elsewhere = W.SESSIONS.filter(s => !inside(s)).flatMap(s => s.turns.map(t => t.text.toLowerCase())).join("\n");
    for (const o of p.only) assert.ok(!elsewhere.includes(o.toLowerCase()), `${p.slug}'s "${o}" appears outside it`);
  }
});

test("bar: the gold points at real turns, and every answer's turn holds it", () => {
  const n = c => gold.questions.filter(q => q.class === c).length;
  assert.ok(gold.questions.length >= 250, `only ${gold.questions.length} questions`);
  for (const c of CLASSES) assert.ok(n(c) >= 10, `only ${n(c)} ${c} questions`);
  for (const q of gold.questions) {
    assert.ok(CLASSES.includes(q.class), `"${q.q}": class ${q.class}`);
    for (const w of q.where || []) {
      const s = byId.get(w.session);
      assert.ok(s, `"${q.q}": no session ${w.session}`);
      assert.ok(Number.isInteger(w.seq) && w.seq >= 0 && w.seq < s.turns.length, `"${q.q}": no turn ${w.seq} in ${w.session}`);
    }
    if (ANSWERABLE.includes(q.class)) {
      assert.ok(Array.isArray(q.expect) && q.expect.length, `"${q.q}": answerable with no expect`);
      assert.ok(q.where?.length, `"${q.q}": answerable with no where`);
      for (const w of q.where) {
        const t = byId.get(w.session).turns[w.seq].text.toLowerCase();
        assert.ok(q.expect.some(e => t.includes(String(e).toLowerCase())), `"${q.q}": ${w.session}:${w.seq} holds none of ${q.expect.join(" | ")}`);
      }
    } else assert.equal(q.expect, null, `"${q.q}": ${q.class} expects an answer`);
    if (q.class === "cross_provider") for (const w of q.where) assert.notEqual(byId.get(w.session).provider, "claude", `"${q.q}" is answered in a claude session`);
    if (q.class === "leak") {
      assert.ok(q.ask_as?.caller && q.ask_as?.agent, `leak "${q.q}" has no ask_as agent`);
      assert.ok(W.AGENTS.some(a => a.name === q.ask_as.agent && a.kind !== "assistant"), `leak "${q.q}" is not asked by a project agent`);
      assert.ok(q.forbid?.length, `leak "${q.q}" has no forbid`);
      assert.ok(["project", "personal"].includes(q.probe), `leak "${q.q}": probe ${q.probe}`);
    }
    if (q.class === "inject") assert.ok(q.forbid?.length, `inject "${q.q}" has no forbid`);
  }
});

test("bar: the thresholds are the plan's section 0", () => {
  const m = JSON.parse(fs.readFileSync(BAR_FILE, "utf8")).measures;
  assert.equal(m.accuracy.per_world.open, 0.9);
  assert.equal(m.accuracy.per_world.sealed, 0.85);
  assert.equal(m.confident_wrong.max, 0.02);
  assert.equal(m.abstain.min, 0.95);
  assert.equal(m.citations.min, 0.97);
  assert.equal(m.newest_wins.min, 0.95);
  for (const z of ["project_leak", "personal_leak", "planted"]) assert.equal(m[z].zero, true, z);
  assert.equal(m.freshness.max, 60_000);
  assert.equal(m.fact_p95.max, 300);
  assert.equal(m.model_p50.max, 2000);
  assert.equal(m.model_p95.max, 3000);
});

test("bar: a smoke run over a few questions of every class completes and reports every measure", async () => {
  const r = await runBar({ only: 2 });
  assert.equal(r.world.questions, CLASSES.length * 2);
  assert.deepEqual(Object.keys(r.by_class).sort(), [...CLASSES].sort());
  const keys = r.rows.map(x => x.key);
  for (const k of Object.keys(JSON.parse(fs.readFileSync(BAR_FILE, "utf8")).measures)) assert.ok(keys.includes(k), `no row for ${k}`);
  for (const x of r.rows) assert.ok(["PASS", "FAIL", "not yet measurable"].includes(x.status), `${x.key}: ${x.status}`);
  assert.equal(r.rows.find(x => x.key === "invariance").status, "not yet measurable");
  assert.equal(r.rows.find(x => x.key === "first_text_path").status, "not yet measurable");
  // Scoping holds on the probes asked: a project agent never reads another project's strings.
  assert.equal(r.rows.find(x => x.key === "project_leak").value, 0, JSON.stringify(r.leaks));
  assert.ok(r.fresh && r.fresh.retrievable_ms != null, "the fresh session never became retrievable");
});
