// @ts-check
// The S9 eval without a model: the dev set through a hostile fake model, an honest one, and the
// recorded reads. CI proves the guard here; scripts/eval-said.js prints the same as a report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadDev, loadReads, run, report, adversarial, RECALL_BAR } from "../../scripts/eval-said.js";
import { oracle } from "./testing.js";
import { PROMPT_VERSION } from "./prompt.js";

const dev = loadDev();

test("the dev set has 200+ rows of every kind of turn, in the sample world", () => {
  assert.ok(dev.rows.length >= 200, `${dev.rows.length} rows`);
  const cats = new Set(dev.rows.map(r => r.cat));
  for (const c of ["ask", "non_ask", "quoted", "conditional", "ambiguous", "mixed"]) assert.ok(cats.has(c), c);
  const ids = new Set(dev.rows.map(r => r.id));
  assert.equal(ids.size, dev.rows.length, "ids are unique");
  for (const r of dev.rows) {
    assert.ok(r.text && r.localTime && r.tz && Array.isArray(r.expect), r.id);
    for (const m of r.text.matchAll(/[\w.+-]+@([\w-]+\.)+[a-z]+/gi)) assert.match(m[0], /\.example$/i, `${r.id}: ${m[0]}`);
  }
});

test("adversarial: nothing a hostile model invents gets through", async () => {
  const a = await adversarial(dev);
  assert.ok(a.proposed > 1000, `${a.proposed} proposed`);
  for (const s of ["nowhere", "planted", "text", "flip"]) assert.ok(a.by_source[s]?.proposed > 0, s);
  assert.deepEqual(a.leaks, []);
});

test("oracle: an honest model's asks survive the guards, and nothing extra appears", async () => {
  const rep = report(await run(dev, row => oracle(row)));
  assert.ok(rep.recall !== null && rep.recall >= RECALL_BAR, `recall ${rep.recall}: ${JSON.stringify(rep.misses)}`);
  assert.equal(rep.false_positives, 0);
  assert.deepEqual(rep.resolve_wrong, []);
});

test("replay: the recorded reads meet the bar", async () => {
  const store = loadReads();
  assert.equal(store.version, PROMPT_VERSION, "reads were made with the current prompt");
  const rep = report(await run(dev, row => store.reads[row.id] ?? null));
  assert.equal(rep.false_positives_pasted_or_non_ask, 0, JSON.stringify(rep.leaks));
  if (rep.expected) assert.ok(rep.recall !== null && rep.recall >= RECALL_BAR, `recall ${rep.recall}`);
});
