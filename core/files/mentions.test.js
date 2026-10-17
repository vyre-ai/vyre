// @ts-check
// A file tagged in a chat is readable in that chat, and what one person tagged is for that person's turns: another member's turn in the same chat reads nothing from it.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { mentions, MIGRATIONS, ASKER_MIGRATIONS } from "./mentions.js";

const OWNER = "per_" + "o".repeat(26), BEN = "per_" + "b".repeat(26);

function rig() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-mention-")));
  fs.writeFileSync(path.join(dir, "report.txt"), "the figures");
  const db = new DatabaseSync(":memory:");
  for (const m of [...MIGRATIONS, ...ASKER_MIGRATIONS]) db.exec(m);
  /** @type {Record<string, any>} */ const tools = {};
  const turn = { asker: /** @type {string | null} */ (null) };
  const ctx = { store: { db }, events: { on() {} }, tool: (/** @type {string} */ n, /** @type {any} */ d) => { tools[n] = d; }, call: async (/** @type {string} */ n) => (n === "threads.turn-asker" ? { data: { asker: turn.asker } } : { error: { code: "no" } }) };
  const box = mentions(ctx, { folder: (/** @type {string} */ p) => p, shares: () => ({ docs: dir }), resolveIn: async (/** @type {string} */ _s, /** @type {string} */ rel) => ({ safe: { real: path.join(dir, rel), path: rel } }) });
  const resolve = (/** @type {any} */ extra) => tools["files.mentions.resolve"].run({ id: "docs:report.txt", thread: "t1", said: "u1", ...extra }, { caller: "module:sessions" });
  return { box, resolve, turn, dir };
}

test("a file the owner tagged in a chat is readable on the owner's turn and not on Ben's", async () => {
  const { box, resolve, turn, dir } = rig();
  await resolve({ asker: OWNER });
  turn.asker = BEN;
  assert.equal(await box.tagged("t1", "docs", "report.txt"), null, "Ben's turn gets nothing from the owner's tag");
  turn.asker = null;
  assert.equal(await box.tagged("t1", "docs", "report.txt"), null, "a turn with no known asker gets nothing from a tag bound to a person");
  turn.asker = OWNER;
  assert.equal(await box.tagged("t1", "docs", "report.txt"), path.join(dir, "report.txt"), "the owner's own turn reads it");
});

test("a tag made on a person's own surface is bound to no one, as before; an asker that is not a person id is refused", async () => {
  const { box, resolve, turn, dir } = rig();
  await resolve({});
  turn.asker = BEN;
  assert.equal(await box.tagged("t1", "docs", "report.txt"), path.join(dir, "report.txt"));
  await assert.rejects(() => resolve({ asker: "bob" }), /person id/);
});
