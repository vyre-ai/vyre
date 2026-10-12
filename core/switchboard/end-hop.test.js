// A one-turn hop is over by whatever path it ended: the person leaves the thread's record and the base comes back (Switchboard.endHop), whether the ask failed, the hop's process stopped or crashed, or a restart found the hop pending.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";
import { hopMovedAway, probeBase } from "./asker-account.js";

const BASE = { provider: "claude", account: "acct_bob", model: "opus", person: "per_bob" };
/** a threads_runs table of one row, as much of the prepared-statement surface as the hop code uses */
function table(/** @type {any} */ row) {
  const writes = /** @type {any[]} */ ([]);
  return { row, writes, prepare: (/** @type {string} */ sql) => ({
    get: () => ({ opts: row.opts }), all: () => (/hopBack/.test(sql) ? [{ id: row.id, opts: row.opts }] : []),
    run: (/** @type {any[]} */ ...a) => { writes.push([sql, a]); if (/SET provider/.test(sql)) { [row.provider, row.account, row.model] = a; row.opts = a[3]; } else if (/SET opts/.test(sql)) row.opts = a[0]; return { changes: 1 }; } }) };
}
const hopRow = () => ({ id: "t1", provider: "claude", account: "acct_carol", model: null, opts: JSON.stringify({ provider: "claude", account: "acct_carol", person: "per_bob", switchPerson: "per_carol", hopBack: BASE }) });
const sbOf = (/** @type {any} */ t, /** @type {any} */ extra = {}) => /** @type {any} */ ({ db: t, once: new Map([["t1", { back: BASE }]]), reverting: new Map(), deps: { log() {} }, endHop: Switchboard.prototype.endHop, ...extra });

test("endHop with a base puts the base account, model and person back and removes the hop's person and its record", () => {
  const t = table(hopRow()); const sb = sbOf(t);
  Switchboard.prototype.endHop.call(sb, "t1", BASE);
  const o = JSON.parse(t.row.opts);
  assert.equal(t.row.account, "acct_bob"); assert.equal(t.row.model, "opus");
  assert.equal(o.person, "per_bob"); assert.equal(o.account, "acct_bob");
  assert.ok(o.switchPerson === undefined && o.hopBack === undefined, "the hop's person and its record are gone: " + t.row.opts);
  assert.equal(sb.once.has("t1"), false);
});

test("endHop without a base only clears the hop's records (an ask that failed before it moved anything)", () => {
  const row = { id: "t1", provider: "claude", account: "acct_bob", model: null, opts: JSON.stringify({ switchPerson: "per_carol", hopBack: BASE, account: "acct_bob" }) };
  const t = table(row); const sb = sbOf(t);
  Switchboard.prototype.endHop.call(sb, "t1");
  assert.equal(row.account, "acct_bob", "the record's account is untouched");
  assert.deepEqual(JSON.parse(row.opts), { account: "acct_bob" });
});

test("a hop to another account of the same provider has moved away from its base; one that moved nothing has not", () => {
  assert.equal(hopMovedAway({ provider: "claude", account: "acct_carol" }, BASE), true, "same provider, other account: the hop must be reverted");
  assert.equal(hopMovedAway({ provider: "codex", account: "acct_bob" }, BASE), true);
  assert.equal(hopMovedAway({ provider: "claude", account: "acct_bob" }, BASE), false);
  assert.equal(hopMovedAway({ provider: null, account: null }, { provider: "claude", account: null }), false, "no explicit account either side");
});

test("the hop's process ending on its own (stopped, crashed) puts the thread back on its base; the swap of a revert in progress is not an end", () => {
  const t = table(hopRow()); const st = { stopping: true, switching: false, idle: null };
  const sb = sbOf(t, { live: new Map([["t1", st]]), flush() {}, cancelTools() {}, releaseSlots() {}, closeSocket() {}, set() {}, asks: { open: () => [] }, record: () => ({ project: null }), emit() {}, states: new Map() });
  Switchboard.prototype.onExit.call(sb, "t1", st, 1, null, "", null);
  assert.equal(t.row.account, "acct_bob", "back on the base's account");
  assert.equal(JSON.parse(t.row.opts).switchPerson, undefined);
  // a revert already swapping the process: its own switch does this, not the exit handler
  const t2 = table(hopRow()); const st2 = { stopping: false, switching: false, idle: null };
  const sb2 = sbOf(t2, { live: new Map([["t1", st2]]), reverting: new Map([["t1", Promise.resolve()]]), flush() {}, cancelTools() {}, releaseSlots() {}, closeSocket() {}, set() {}, asks: { open: () => [] }, record: () => ({ project: null }), emit() {}, states: new Map() });
  Switchboard.prototype.onExit.call(sb2, "t1", st2, 0, null, "", null);
  assert.equal(t2.row.account, "acct_carol", "left to the revert");
});

test("a restart that finds a hop pending puts the thread back on the base the hop recorded", () => {
  const t = table(hopRow());
  const sb = sbOf(t, { once: new Map(), asks: { open: () => [] }, emit() {}, emitRaw() {}, states: new Map(), deps: { log() {}, root: "/nonexistent-root" } });
  sb.db = { prepare: (/** @type {string} */ sql) => (/status IN/.test(sql) ? { all: () => [] } : t.prepare(sql)) };
  Switchboard.prototype.recover.call(sb);
  assert.equal(t.row.account, "acct_bob");
  assert.equal(JSON.parse(t.row.opts).hopBack, undefined);
});

test("the models probe makes its folder under the work folder when the box has one (a uid-confined account may work nowhere else), else under temp", () => {
  assert.equal(probeBase({ work: "/work", tmp: "/tmp", exists: p => p === "/work" }), "/work");
  assert.equal(probeBase({ tmp: "/tmp", exists: p => p === "/work" }), "/work", "the default work folder is /work");
  assert.equal(probeBase({ work: "/work", tmp: "/tmp", exists: () => false }), "/tmp");
});
