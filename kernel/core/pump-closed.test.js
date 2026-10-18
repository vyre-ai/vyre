// @ts-check
// The event bus pump when the log is closed under it: a handler fails as the kernel stops, and its retry path reads the log again. That read must end the pump quietly (nothing is left to
// retry), not throw out of it: a throw out of the async pump is an unhandled rejection that fails whichever test is running (v0.6.1 node, "database is not open").
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSqliteEventLog } from "../store/sqlite-log.js";
import { createChainBuilder } from "./chain.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), clock, is_person: () => true });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });

test("a consumer whose handler fails as the log closes: the pump ends quietly, no unhandled rejection, no retry left behind", async () => {
  const db = new DatabaseSync(":memory:");
  // a window of 3 events, so the consumer's first read (from the start) goes to the database, as it does on a busy kernel
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 3, bytes: 1_000_000 }, rand: n => Buffer.alloc(n, 7) });
  for (let i = 0; i < 10; i++) log.append(owner(), { type: "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/c${i}`, data: { i } });
  /** @type {unknown[]} */ const loose = [];
  const note = (/** @type {unknown} */ e) => { loose.push(e); };
  process.on("unhandledRejection", note);
  try {
    let calls = 0;
    log.subscribe("closing", {}, () => { calls++; db.close(); throw new Error("the handler failed as the database closed"); });
    await log.pump();                                      // must resolve, not reject
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));   // the subscribe's own pump and any retry timer have had their turn
    assert.equal(calls, 1, "the handler ran once, and the closed log scheduled no retry");
    assert.deepEqual(loose, [], "no unhandled rejection");
  } finally { process.off("unhandledRejection", note); }
});

test("any other read error still surfaces out of the pump: only a closed log is nothing to retry", async () => {
  const db = new DatabaseSync(":memory:");
  const log = createSqliteEventLog({ db, space: SPACE, clock, window: { events: 3, bytes: 1_000_000 }, rand: n => Buffer.alloc(n, 7) });
  for (let i = 0; i < 10; i++) log.append(owner(), { type: "contact.updated", sv: 1, subject: `vyre://${SPACE}/contact/c${i}`, data: { i } });
  /** @type {any[]} */ const loose = [];
  const note = (/** @type {unknown} */ e) => { loose.push(e); };
  // the runner's own listener would fail this test for the very rejection it expects: stand in for it for the length of the test
  const saved = process.listeners("unhandledRejection"); process.removeAllListeners("unhandledRejection"); process.on("unhandledRejection", note);
  try {
    // the handler fails and the log is damaged (not closed): the second read throws an ordinary database error, which must not be taken for a closed log
    log.subscribe("damaged", {}, () => { db.exec("DROP TABLE kernel_events"); throw new Error("the handler failed"); });
    await log.pump().catch(() => {});
    await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
    assert.ok(loose.length >= 1, `the read error came out of the pump (${loose.length} rejections seen)`);
    assert.doesNotMatch(String(loose[0] && loose[0].message), /not open/);
  } finally { process.off("unhandledRejection", note); for (const l of saved) process.on("unhandledRejection", l); }
});
