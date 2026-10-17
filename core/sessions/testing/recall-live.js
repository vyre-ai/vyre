// @ts-check
// Live-daemon recall for person-relay and slash isolation tests: corpus transcripts, fake
// embedder, no model download. Requires Node's built-in SQLite with FTS5 (Node >= 22.16).

import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { useEmbedder } from "../../recall/index.js";
import { fakeEmbedder } from "../../recall/testing.js";
import { until } from "./boot.js";

/** Recall block for config.json on a temp box (background timer off, vectors off). */
export const RECALL_LIVE_CONFIG = Object.freeze({ every: 0, vectors: false });

let fts5 = /** @type {boolean | null} */ (null);

/** Whether this Node build can run the recall module (FTS5 in node:sqlite). */
export function recallFts5Available() {
  if (fts5 !== null) return fts5;
  try {
    const d = new DatabaseSync(":memory:");
    d.exec("CREATE VIRTUAL TABLE _vyre_fts_probe USING fts5(x)");
    fts5 = true;
  } catch {
    fts5 = false;
  }
  return fts5;
}

/** @param {import("node:test").TestContext} t */
export function hookRecallTestEmbedder(t) {
  useEmbedder(fakeEmbedder());
  t.after(() => useEmbedder(null));
}

/** @param {any} d live daemon @param {string} [hint] */
export function assertRecallLoaded(d, hint = "recall module") {
  assert.ok(
    recallFts5Available(),
    "recall live tests need Node 22.16+ (node:sqlite with FTS5); upgrade Node on this runner",
  );
  assert.ok(d.registry.tools.has("recall.search"), `${hint}: recall.search must be registered`);
  assert.ok(d.registry.tools.has("recall.index"), `${hint}: recall.index must be registered`);
}

/**
 * Recall indexes transcript files on disk; threads.start returns once the agent is launched, not
 * after the first turn (and fake Claude may still be writing). Wait so member /find tests do not
 * race the indexer — Bob's thread, started last, was the usual flake.
 * @param {any} d live daemon
 * @param {string[]} threadIds
 * @param {number} [ms]
 */
export async function waitForThreadsFirstTurn(d, threadIds, ms = 90_000) {
  const ids = threadIds.map(String).filter(Boolean);
  if (!ids.length) return;
  await until(async () => {
    for (const id of ids) {
      const g = await d.registry.call("threads.get", { thread: id, limit: 50 }, "cli");
      if (!g.data?.events?.some((/** @type {any} */ e) => e.type === "thread.finished")) return false;
    }
    return true;
  }, "threads' first turn (for recall indexing)", ms);
}

/** @param {any} d transcripts must already be on disk under the home's configured folders */
export async function indexCorpusTranscripts(d) {
  assertRecallLoaded(d, "recall.index");
  const ix = await d.registry.call("recall.index", {}, "cli");
  assert.ok(!ix.error, JSON.stringify(ix.error));
  return ix.data;
}
