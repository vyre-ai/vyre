// @ts-check
// The lent home's start, beat and resume bookkeeping, driven directly with fake Offers and a spy on the credential binding: what a refused or failed start must leave alone.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLentHome } from "./lent-home.js";

const SPACE = "spc_aaaaaaaaaaaa";
const chain = (/** @type {string} */ person, /** @type {string} */ device) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: person }, via: { device } }] });
const spec = async () => ({ command: "/usr/bin/agent", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] });

function world(/** @type {import("node:test").TestContext} */ t, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const state = { stands: true, renewFails: false };
  /** @type {string[]} */ const calls = [];
  const leases = { renew: async () => { calls.push("renew"); if (state.renewFails) throw new Error("no lease"); }, bind: (/** @type {string} */ s) => { calls.push("bind:" + s); }, unbind: (/** @type {string} */ s) => { calls.push("unbind:" + s); } };
  const home = createLentHome({ space: SPACE, root: dir, offers: { active: () => ({ spaceAllows: state.stands, memberAccepts: state.stands }) }, leases, now: () => clock, specFor: spec, ...o });
  return { home, state, calls, tick: (/** @type {number} */ ms) => { clock += ms; }, dir };
}

test("a second computer of the same person cannot take a session that is running on the first, and the first's credentials are not touched", async t => {
  const w = world(t);
  await w.home.start(chain("per_a", "dev_1"), { session: "s1", lease: "L1" });
  assert.deepEqual(w.calls, ["renew", "bind:s1"]);
  await assert.rejects(w.home.start(chain("per_a", "dev_2"), { session: "s1", lease: "L2" }), e => e.code === "conflict");
  assert.deepEqual(w.calls, ["renew", "bind:s1"], "no second bind, no unbind: the first computer's session keeps what it had");
  assert.equal(w.home.book.get("s1").device, "dev_1");
});

test("another person's session id is refused before anything is asked or bound, even after its row was forgotten", async t => {
  const w = world(t);
  await w.home.start(chain("per_a", "dev_1"), { session: "s1", lease: "L1" });
  await w.home.stop(chain("per_a", "dev_1"), { session: "s1" });
  w.calls.length = 0;
  await assert.rejects(w.home.start(chain("per_b", "dev_b"), { session: "s1", lease: "L2" }), e => e.code === "not_found");
  assert.deepEqual(w.calls, [], "nothing was renewed or bound for the stranger");
  await w.home.start(chain("per_a", "dev_1"), { session: "s1", lease: "L3" });   // its owner may use the id again
});

test("a lease that does not hold undoes the lend: a new session is forgotten, a session that was on the server goes back to it, and the epoch used stays used", async t => {
  const w = world(t);
  w.state.renewFails = true;
  await assert.rejects(w.home.start(chain("per_a", "dev_1"), { session: "new1", lease: "L1" }));
  assert.equal(w.home.book.get("new1"), null);
  assert.equal(w.home.book.ownerOf("new1"), "per_a");
  w.state.renewFails = false;
  await w.home.start(chain("per_a", "dev_1"), { session: "old1", lease: "L2" });
  await w.home.release(chain("per_a", "dev_1"), { session: "old1", epoch: 1, reason: "you" });
  w.home.book.bringBack("old1", "per_a");
  w.state.renewFails = true;
  await assert.rejects(w.home.start(chain("per_a", "dev_1"), { session: "old1", lease: "L3" }));
  const row = w.home.book.get("old1");
  assert.deepEqual([row.where, row.epoch], ["server", 4], "back on the server; epochs 1 (first lend), 2 (handed over), 3 (the failed lend) and 4 (undone) are all spent");
});

test("an Offer that stands again after one blip is not a reason to take a healthy session; two beats running with none are", async t => {
  const w = world(t);
  const c = chain("per_a", "dev_1");
  await w.home.start(c, { session: "s1", lease: "L1" });
  w.state.stands = false;
  assert.deepEqual((await w.home.beat(c, { sessions: [{ session: "s1", epoch: 1 }] })).fenced, [], "once is a blip (a home that has only just started may not have read its Offers)");
  w.state.stands = true;
  assert.deepEqual((await w.home.beat(c, { sessions: [{ session: "s1", epoch: 1 }] })).fenced, []);
  w.state.stands = false;
  await w.home.beat(c, { sessions: [{ session: "s1", epoch: 1 }] });
  assert.deepEqual((await w.home.beat(c, { sessions: [{ session: "s1", epoch: 1 }] })).fenced, ["s1"], "twice running: the lending is over");
  assert.deepEqual([w.home.book.get("s1").where, w.home.book.get("s1").reason], ["server", "switched-off"]);
});

test("a late continuation of an earlier take-over does not clear what a later take-over of the same session still owes", async t => {
  /** @type {(() => void)[]} */ const finish = [];
  const w = world(t, { resume: () => new Promise(res => { finish.push(() => res(undefined)); }) });
  const c = chain("per_a", "dev_1");
  await w.home.start(c, { session: "s1", lease: "L1" });
  await w.home.release(c, { session: "s1", epoch: 1, reason: "you" });   // take-over 1: its continuation is slow
  w.home.book.bringBack("s1", "per_a");
  const again = await w.home.start(c, { session: "s1", lease: "L2" });
  await w.home.release(c, { session: "s1", epoch: again.epoch, reason: "you" });   // take-over 2 of the same session
  finish.shift()?.();   // the first continuation finally answers
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(w.home.book.pendingResume().map(r => r.session), ["s1"], "take-over 2 is still owed its own");
});
