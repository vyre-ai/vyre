// @ts-check
// The eval harness, on the fictional corpus and its labelled set.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { Dense } from "./dense.js";
import { evaluate } from "./eval.js";
import { fakeEmbedder } from "./testing.js";
import { writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

const SET = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/recall-eval.json", import.meta.url), "utf8"));

async function indexed(t) {
  const home = tempHome(t);
  writeTranscripts(path.join(home, "t"));
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  const ix = new Indexer(db);
  await ix.run([path.join(home, "t")]);
  return { db, ix };
}

test("eval: every labelled answer exists in the corpus", async t => {
  const { db } = await indexed(t);
  const has = db.prepare("SELECT 1 FROM recall_turns WHERE session = ? AND seq = ?");
  for (const c of SET.queries) for (const a of c.answers) assert.ok(has.get(a.session, a.seq), `${c.q}: no turn ${a.session}:${a.seq}`);
});

test("eval: keyword only, the scores are in range and meaning is reported as absent", async t => {
  const { db } = await indexed(t);
  const r = await evaluate(db, SET);
  assert.equal(r.queries, SET.queries.length);
  assert.ok(r.keyword.mrr > 0 && r.keyword.mrr <= 1 && r.keyword.recall > 0 && r.keyword.recall <= 1);
  assert.equal(r.dense, null);
  assert.equal(r.hybrid, null);
  assert.equal(r.nonsense.withHits, 0, "nonsense matched a word in the fixture corpus");
});

test("eval: MRR and recall are computed per question as defined", async t => {
  const { db } = await indexed(t);
  const r = await evaluate(db, { queries: [
    { q: "northwind-invoices", answers: [{ session: "11111111-aaaa-4000-8000-000000000003", seq: 1 }] },
    { q: "zygomorphic", answers: [{ session: "11111111-aaaa-4000-8000-000000000003", seq: 1 }] },
  ] });
  assert.equal(r.keyword.mrr, 0.5, "one question found first and one not at all is an MRR of 0.5");
  assert.equal(r.keyword.recall, 0.5);
});

test("eval: with an embedder, hybrid is scored and beats keyword on the paraphrased set", async t => {
  const { db, ix } = await indexed(t);
  const emb = fakeEmbedder({ same: { blind: "accessibility", visitors: "problems", baker: "bakery", money: "dollars", spend: "total" } });
  await ix.vectorize(emb);
  const r = await evaluate(db, SET, { embedder: emb, dense: new Dense(db) });
  assert.ok(r.hybrid && r.dense && r.floor);
  assert.ok(r.hybrid.mrr >= r.keyword.mrr, "hybrid scored worse than keyword on the fixture set");
  assert.equal(r.floor.chunks, 16);
  assert.equal(r.floor.answers, SET.queries.reduce((n, c) => n + c.answers.length, 0));
  // Where nonsense lands is a property of the real model, checked below; hashed words collide.
  assert.equal(r.nonsense.n, SET.nonsense.length);
});

test("eval: with the real model, hybrid beats keyword and nonsense stays under the floor", async t => {
  let load;
  try { await import("@huggingface/transformers"); ({ load } = await import("./embed.js")); }
  catch { t.skip("the optional @huggingface/transformers package is not installed"); return; }
  const { embedder, why } = await load({ cacheDir: path.join(os.tmpdir(), "vyre-test-models") });
  if (!embedder) { t.skip(`the model did not load: ${why}`); return; }
  const { db, ix } = await indexed(t);
  await ix.vectorize(embedder);
  const r = await evaluate(db, SET, { embedder, dense: new Dense(db) });
  assert.ok(r.hybrid && r.floor);
  assert.ok(r.hybrid.mrr > r.keyword.mrr, `hybrid ${r.hybrid.mrr} did not beat keyword ${r.keyword.mrr}`);
  assert.equal(r.nonsense.withDense, 0);
  assert.ok((r.floor.nonsenseTop ?? 1) < r.floor.value);
});
