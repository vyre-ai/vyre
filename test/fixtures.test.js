// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open } from "../core/store/index.js";
import { SESSIONS, writeTranscripts, seedRecall } from "./fixtures/corpus.js";
import { tempHome } from "./helpers.js";

test("fixtures: the corpus writes as Claude Code lays transcripts out, and seeds Recall's tables", t => {
  const home = tempHome(t);
  const { files } = writeTranscripts(path.join(home, "transcripts"));
  assert.equal(Object.keys(files).length, SESSIONS.length);
  const sub = SESSIONS.find(s => s.parent);
  assert.match(files[sub.id], /\/subagents\/agent-a5ub\.jsonl$/);
  for (const f of Object.values(files)) for (const l of fs.readFileSync(f, "utf8").trim().split("\n")) JSON.parse(l);
  const db = open(path.join(home, "vyre.db"));
  seedRecall(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recall_sessions").get().n, SESSIONS.length);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM recall_turns WHERE recall_turns MATCH 'Dana'").get().n > 0, true);
  assert.equal(db.prepare("SELECT human FROM recall_sessions WHERE id = ?").get(sub.id).human, 0);
  db.close();
});
