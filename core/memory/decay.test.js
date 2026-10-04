// @ts-check
// Decay at read time (docs/adr/0007-intelligence.md, decision 3). Derive never reads the clock;
// freshness is computed when a fact is read, from the newest turn that supports it over all its
// evidence. Fictional data only.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { open } from "../store/index.js";
import { HOME, seedRecall } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { Curator } from "./curator.js";
import { Graph, freshness, STALE } from "./graph.js";

const T0 = Date.parse("2026-01-05T09:00:00Z");
const DAY = 86_400_000;
let n = 0;
const S = (turns, start, dir = "misc") => ({
  id: `55555555-eeee-4000-8000-${String(++n).padStart(12, "0")}`, cwd: `${HOME}/Work/${dir}`, start,
  turns: turns.map(text => ({ role: /** @type {"user"} */ ("user"), text })),
});

async function world(t, sessions, { now = T0 + 30 * DAY, curatorNow } = {}) {
  const db = open(path.join(tempHome(t), "vyre.db"));
  t.after(() => db.close());
  seedRecall(db, sessions);
  const curator = new Curator(db, { me: { domains: ["riverastudio.com"] }, ...(curatorNow ? { now: () => curatorNow } : {}) });
  await curator.curate();
  let clock = now;
  const graph = new Graph(db, curator, { now: () => clock });
  return { db, curator, graph, at: ms => { clock = ms; } };
}

/** Everything derive writes, without write times. */
const dump = db => ({
  edges: db.prepare("SELECT room, src, rel, dst, weight, valid_from, valid_to, confidence, seen, conflict, origin, rule FROM memory_edges ORDER BY 1, 2, 3, 4, 6").all(),
  nodes: db.prepare("SELECT * FROM memory_nodes ORDER BY id").all(),
  forms: db.prepare("SELECT room, node, form, precision, sessions FROM memory_shortforms ORDER BY 1, 2, 3").all(),
});

// Eight, not more: past eight sessions an organisation with no project named for it is a hub.
const EIGHT = Array.from({ length: 8 }, (_, i) => S([`Dana Reyes (dana@harlowlegal.com) sent Harlow Legal draft ${i}.`], T0 + i * 7 * DAY));

test("decay: derive does not depend on the clock", async t => {
  const a = await world(t, EIGHT, { curatorNow: T0 });
  const b = await world(t, EIGHT, { curatorNow: T0 + 400 * DAY });
  assert.deepEqual(dump(a.db), dump(b.db));
});

test("decay: seen is the newest supporting turn over all evidence, not the capped few", async t => {
  const { db } = await world(t, EIGHT);
  const e = db.prepare("SELECT seen, id FROM memory_edges WHERE room = '*' AND src = 'name:Dana Reyes' AND rel = 'works_at' AND valid_to IS NULL").get();
  const evidence = Number(db.prepare("SELECT COUNT(*) n FROM memory_evidence WHERE edge = ?").get(e?.id)?.n);
  assert.ok(evidence <= 6, "evidence stays capped");
  assert.equal(e?.seen, T0 + 7 * 7 * DAY, "seen must be the last session's turn");
  const mention = db.prepare("SELECT seen FROM memory_edges WHERE room = '*' AND src = 'name:Dana Reyes' AND dst = ?").get("session:" + EIGHT[4].id);
  assert.equal(mention?.seen, EIGHT[4].start);
});

test("decay: freshness per relation, with floors, and what the user said does not decay", () => {
  const now = T0 + 1000 * DAY;
  const at = days => now - days * DAY;
  assert.equal(freshness({ rel: "works_at", seen: at(180) }, now), 0.5);
  assert.equal(freshness({ rel: "works_at", seen: at(5000) }, now), 0.25);
  assert.equal(freshness({ rel: "has_email", seen: at(365) }, now), 0.5);
  assert.equal(freshness({ rel: "has_email", seen: at(5000) }, now), 0.4, "identity never falls below its floor");
  assert.equal(freshness({ rel: "mentioned_in", seen: at(30) }, now), 0.5);
  assert.equal(freshness({ rel: "works_at", seen: at(5000), origin: "user" }, now), 1);
  assert.equal(freshness({ rel: "works_at", seen: at(5000), origin: "confirmed" }, now), 1);
  assert.equal(freshness({ rel: "works_at", seen: 0 }, now), 1, "a fact with no date is as fresh as it was");
});

test("decay: an old employer is stale, still listed and marked, and left out of a prompt unless pinned", async t => {
  const { graph, at } = await world(t, EIGHT);
  const last = T0 + 7 * 7 * DAY;
  at(last + 30 * DAY);
  const fresh = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at");
  assert.equal(fresh?.stale, false);
  assert.ok(graph.relevant({ text: "ask Dana Reyes" }).some(f => f.text === "Dana Reyes works at Harlow Legal"));
  // works_at goes stale about nine months after it was last said: 0.5 ^ (272 / 180) is 0.35.
  at(last + 300 * DAY);
  const old = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "works_at");
  assert.equal(old?.stale, true);
  assert.equal(old?.seen_age, "10 months");
  assert.ok(old?.fresh < STALE);
  const email = graph.facts({ about: "Dana Reyes" }).facts.find(f => f.rel === "has_email");
  assert.equal(email?.stale, false, "who someone is barely ages");
  const r = graph.relevant({ text: "ask Dana Reyes" });
  assert.ok(!r.some(f => f.rel === "works_at" || f.text.includes("works at")), r.map(f => f.text).join("\n"));
  assert.ok(r.some(f => f.text.includes("email")), "identity still answers");
  // Silence never closes an edge.
  assert.equal(old?.until, null);
  graph.steer({ node: "Dana Reyes", mode: "pin" });
  assert.ok(graph.relevant({ text: "ask Dana Reyes" }).some(f => f.text === "Dana Reyes works at Harlow Legal"), "a pin keeps a stale fact in the prompt");
});
