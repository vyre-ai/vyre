// @ts-check
// The person's standing choice for a computer (Always allow or Ask), at the lent home: a new chat starts on a computer by itself only under Always allow, and a session that left a computer for a condition that
// cleared comes back to it by itself only under Always allow, only after the computer has stayed ready beat after beat, only past the cooldown of the last move, and never for any other reason.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLentHome } from "./lent-home.js";
import { STEADY_MS, COOLDOWN_MS, LAPSE_MS } from "./placement-book.js";

const SPACE = "spc_aaaaaaaaaaaa";
const chain = (/** @type {string} */ person, /** @type {string} */ device) => ({ space: SPACE, hops: [{ actor: { kind: "person", id: person }, via: { device } }] });
const spec = async () => ({ command: "/usr/bin/agent", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] });
const A = chain("per_a", "dev_1");

function world(/** @type {import("node:test").TestContext} */ t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1_000_000;
  const leases = { renew: async () => {}, bind: () => {}, unbind: () => {} };
  const home = createLentHome({ space: SPACE, root: dir, offers: { active: () => ({ spaceAllows: true, memberAccepts: true }) }, leases, now: () => clock, specFor: spec });
  /** Beat well every 5 seconds for `ms`, as a computer that stays ready does. */
  const stayWell = async (/** @type {number} */ ms, /** @type {boolean} */ auto = true) => { for (let n = 0; n < ms / 5000; n++) { clock += 5000; await home.beat(A, { sessions: [], well: true, auto }); } };
  return { home, tick: (/** @type {number} */ ms) => { clock += ms; }, stayWell };
}

/** A session that started on dev_1 and left it because the lid shut. */
async function leftForLid(/** @type {ReturnType<typeof world>} */ w) {
  await w.home.start(A, { session: "s1", lease: "L1" });
  const r = await w.home.release(A, { session: "s1", epoch: 1, reason: "lid-closed" });
  assert.equal(r.moved, true);
}

test("a new chat starts on a computer by itself under Always allow, and not under Ask", async t => {
  const w = world(t);
  await w.stayWell(10_000, false);
  assert.deepEqual(w.home.placeNew({ session: "n1", person: "per_a" }), { where: "box" }, "Ask: the box runs it; the person puts it on the computer when they want");
  await w.stayWell(10_000, true);
  assert.equal(w.home.placeNew({ session: "n2", person: "per_a" }).where, "mac", "Always allow: it starts on the computer");
});

test("a computer from before this setting existed (no flag) behaves as Always allow, as it did", async t => {
  const w = world(t);
  w.tick(5000); await w.home.beat(A, { sessions: [], well: true });
  assert.equal(w.home.placeNew({ session: "n1", person: "per_a" }).where, "mac");
});

test("a session that left for the lid comes back by itself only after the computer stayed ready and the cooldown passed; a computer that comes and goes never gets it", async t => {
  const w = world(t);
  await leftForLid(w);
  await w.stayWell(STEADY_MS + 5000);
  assert.equal(w.home.book.get("s1")?.offer, "mac", "offered back once the computer is well");
  assert.equal(w.home.mayReturn("s1", "per_a"), false, "ready for a minute is not enough: the move itself is still inside its cooldown");
  await w.stayWell(COOLDOWN_MS);
  assert.equal(w.home.mayReturn("s1", "per_a"), true, "steadily ready, past the cooldown");
  assert.equal(w.home.mayReturn("s1", "per_b"), false, "only the session's own person");
  // the computer drops out for longer than a lapse and returns: it starts the steady stretch again
  w.tick(LAPSE_MS + 1000);
  await w.home.beat(A, { sessions: [], well: true, auto: true });
  assert.equal(w.home.mayReturn("s1", "per_a"), false, "a gap restarts the stretch");
  await w.stayWell(STEADY_MS - 5000);
  assert.equal(w.home.mayReturn("s1", "per_a"), false);
  await w.stayWell(10_000);
  assert.equal(w.home.mayReturn("s1", "per_a"), true);
  // not well for one beat: the stretch restarts
  w.tick(5000); await w.home.beat(A, { sessions: [], well: false, auto: true });
  assert.equal(w.home.mayReturn("s1", "per_a"), false);
});

test("under Ask nothing comes back by itself, and a session pinned to the server never does", async t => {
  const w = world(t);
  await leftForLid(w);
  await w.stayWell(STEADY_MS + COOLDOWN_MS + 5000, false);
  assert.equal(w.home.mayReturn("s1", "per_a"), false, "Ask: the offer waits for the person");
  await w.stayWell(10_000, true);
  assert.equal(w.home.mayReturn("s1", "per_a"), true);
  w.home.book.pin("s1", "server", "per_a");
  assert.equal(w.home.mayReturn("s1", "per_a"), false, "pinned to the server");
});

test("a session that left for any reason that does not clear is never put back by the standing choice", async t => {
  const w = world(t);
  await w.home.start(A, { session: "s1", lease: "L1" });
  await w.home.release(A, { session: "s1", epoch: 1, reason: "you" });
  await w.stayWell(STEADY_MS + COOLDOWN_MS + 5000);
  assert.equal(w.home.mayReturn("s1", "per_a"), false, "the person moved it: only they move it back");
  await assert.rejects(w.home.adopt({ session: "s1", thread: "s1", person: "per_a", native: "s1", lines: ["x"], policy: true }), (/** @type {any} */ e) => e.code === "unavailable");
});

test("the policy return is refused before anything is written when the computer is not steadily ready", async t => {
  const w = world(t);
  await leftForLid(w);
  await w.stayWell(10_000);
  await assert.rejects(w.home.adopt({ session: "s1", thread: "s1", person: "per_a", native: "s1", lines: ["x"], policy: true }), (/** @type {any} */ e) => e.code === "unavailable");
  assert.equal(w.home.book.get("s1")?.where, "server", "nothing moved");
});
