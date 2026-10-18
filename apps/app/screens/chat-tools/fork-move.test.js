// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { forkAndMove, forkMoveOffer } from "./fork-move.js";

test("the offer is the other place only", () => {
  assert.equal(forkMoveOffer("server")?.title, "Fork and continue on Space's Cloud");
  assert.equal(forkMoveOffer("mac")?.title, "Fork and continue on My Computer");
  assert.equal(forkMoveOffer(null), null);
});

test("fork then move: the copy is moved, never the chat itself, and a copy is kept when it cannot move", async () => {
  /** @type {string[]} */ const calls = [];
  const box = (/** @type {any} */ move) => ({ fork: async (/** @type {string} */ t) => { calls.push(`fork ${t}`); return { ok: /** @type {const} */ (true), thread: "copy" }; }, move: async (/** @type {string} */ t, /** @type {any} */ to) => { calls.push(`move ${t} ${to}`); return move(); } });
  assert.deepEqual(await forkAndMove(box(() => ({ where: "server" })), "chat", "server"), { ok: true, thread: "copy", note: "The copy runs on Space's Cloud." });
  assert.deepEqual(calls, ["fork chat", "move copy server"], "only the copy is moved");
  const stays = await forkAndMove(box(() => ({ where: "mac" })), "chat", "server");
  assert.deepEqual(stays, { ok: true, thread: "copy", note: "The copy is made and runs on My Computer." });
  const refused = await forkAndMove(box(() => { throw new Error("Coming in this release: a chat that began on Space's Cloud cannot be moved to a computer yet; leave it on Space's Cloud for now"); }), "chat", "mac");
  assert.equal(refused.ok, true);
  assert.match(/** @type {any} */ (refused).note, /^The copy is made, but it could not go to My Computer: Coming in this release/);
  const none = await forkAndMove({ fork: async () => ({ ok: false, reason: "The copy did not start." }), move: async () => { throw new Error("never"); } }, "chat", "server");
  assert.deepEqual(none, { ok: false, reason: "The copy did not start." });
});
