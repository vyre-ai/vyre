// @ts-check
// Review row 10: the server must not take a lent session while nothing can continue it, or the session is lost. Through the real daemon's wiring of the lent home: with no resume loader a move to the server answers "coming
// in this release", the lender keeps the session, a silent lender is not taken, and nothing is owed; when the loader exists (agent-core's `resumeLent`), the same move happens and the loader is told.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SESSION = "ses_a1b2c3d4e5f6", CHAT = "chat_00000000-0000-4000-8000-0000000000a1", DEVICE = "dev_office_mac";

/** @param {any} t @param {Record<string, any>} [opts] */
async function world(t, opts = {}) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", modules: { disable: ["agents", "computers", "threads"] } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, ...opts });
  asOwner(d, root);
  t.after(() => d.stop());
  const owner = d.kernel.id.owner;
  const team = await d.kernel.spaces.host({ owner, name: "team" });
  const home = /** @type {any} */ (d.registry.deps).lentHome(team.space);
  assert.ok(home, "the daemon made the lent home for the Space");
  home.book.lend({ session: SESSION, chat: CHAT, person: owner, device: DEVICE, key: "KEY" });
  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  return { d, team, home, call };
}

test("with nothing to continue a lent session, the server takes none: the move answers coming in this release, the lender keeps it, a silent lender is not taken", { timeout: 120_000 }, async t => {
  const { team, home, call } = await world(t);
  const move = await call("runner.move", { thread: CHAT, to: "server", space: team.space });
  assert.equal(move.error && move.error.code, "unavailable", JSON.stringify(move));
  assert.match(move.error.message, /Coming in this release/);
  assert.equal(home.book.get(SESSION).where, "mac", "the session stays on the computer");
  assert.equal(home.book.get(SESSION).state, "here", "and nobody was asked to hand it over");
  // the computer's own hand-over (a closed lid) is refused the same way, and the epoch does not move
  const epoch = home.book.get(SESSION).epoch;
  assert.deepEqual(await home.takeOver(SESSION, "lid-closed", { auto: true }), { changed: false, why: "unavailable" });
  assert.equal(home.book.get(SESSION).epoch, epoch);
  // a lender that goes silent is not taken either (there is nothing to take it to); nothing is owed once the loader never comes
  await home.sweep();
  assert.equal(home.book.get(SESSION).where, "mac");
  assert.deepEqual(home.book.pendingResume(), []);
});

test("with the loader in place the same move happens and the loader is told, from the last whole turn", { timeout: 120_000 }, async t => {
  /** @type {any[]} */ const told = [];
  const { team, home, call } = await world(t, { resumeLent: async (/** @type {any} */ i) => { told.push([i.session, i.chat, i.reason]); } });
  const move = await call("runner.move", { thread: CHAT, to: "server", space: team.space });
  assert.equal(move.data && move.data.state, "moving", JSON.stringify(move));
  const r = await home.takeOver(SESSION, "you");
  assert.equal(r.changed, true);
  await new Promise(res => setTimeout(res, 100));
  assert.deepEqual(told, [[SESSION, CHAT, "you"]]);
  assert.equal(home.book.get(SESSION).where, "server");
});
