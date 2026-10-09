// @ts-check
// The placement book: where a lent session runs, who may move it next, and the fence that keeps a paused computer from writing a turn the server already ran.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlacementBook, fileStore, placementOf, LAPSE_MS, COOLDOWN_MS } from "./placement-book.js";

const clock = (start = 1_000_000) => { let t = start; return { now: () => t, tick: (/** @type {number} */ ms) => { t += ms; } }; };
const who = { person: "per_a", device: "dev_mac" };

test("a lent session is on the computer; moving it to the server raises the epoch, says why, and tells the world once", () => {
  const c = clock(), said = /** @type {any[]} */ ([]);
  const b = createPlacementBook({ now: c.now, emit: (type, p) => said.push([type, p]) });
  const r = b.lend({ session: "s1", chat: "chat_x", ...who });
  assert.deepEqual([r.where, r.state, r.epoch, r.reason, r.offer], ["mac", "here", 1, null, null]);
  c.tick(5000);
  const m = b.toServer("s1", "lid-closed", { auto: true });
  assert.equal(m.changed, true);
  assert.deepEqual([m.row?.where, m.row?.state, m.row?.epoch, m.row?.reason], ["server", "server", 2, "lid-closed"]);
  assert.deepEqual(said, [["thread.moved", { thread: "chat_x", session: "s1", from: "mac", to: "server", reason: "lid-closed", at: c.now() }]]);
  assert.deepEqual(b.toServer("s1", "crash"), { changed: false, why: "there", row: b.get("s1") }, "a second move to the same place changes nothing and says nothing");
  assert.equal(said.length, 1);
  assert.throws(() => b.toServer("s1", "not-a-reason"), e => /** @type {any} */ (e).code === "bad_input");
});

test("the split case: the computer is paused, not dead; the server takes the session; the computer wakes and nothing it says counts", () => {
  const c = clock(), b = createPlacementBook({ now: c.now });
  const first = b.lend({ session: "s1", ...who });
  assert.equal(b.beat({ session: "s1", epoch: first.epoch, device: "dev_mac", turn: 3 }).ok, true);
  c.tick(LAPSE_MS + 1);
  assert.deepEqual(b.lapsed().map(r => r.session), ["s1"], "no heartbeat for the lapse: the server's to take");
  const taken = b.toServer("s1", "offline");
  assert.equal(taken.changed, true);
  // the computer wakes and speaks with the epoch it started with
  assert.deepEqual(b.beat({ session: "s1", epoch: first.epoch, device: "dev_mac" }), { ok: false, fenced: true });
  assert.equal(b.current("s1", first.epoch, "dev_mac"), false, "its writes are refused too");
  // it cannot start the session again by itself
  assert.throws(() => b.lend({ session: "s1", ...who }), e => /** @type {any} */ (e).code === "conflict");
  // when the person brings it back it runs under a newer epoch, and the old process is still fenced
  b.bringBack("s1", "per_a");
  const again = b.lend({ session: "s1", ...who });
  assert.ok(again.epoch > first.epoch + 1);
  assert.equal(b.current("s1", first.epoch, "dev_mac"), false);
  assert.equal(b.current("s1", again.epoch, "dev_mac"), true);
});

test("another person's computer or a different device is fenced; another person's session is not found", () => {
  const b = createPlacementBook();
  const r = b.lend({ session: "s1", ...who });
  assert.equal(b.beat({ session: "s1", epoch: r.epoch, device: "dev_other" }).fenced, true);
  assert.throws(() => b.lend({ session: "s1", person: "per_b", device: "dev_b" }), e => /** @type {any} */ (e).code === "not_found");
  assert.throws(() => b.bringBack("s1", "per_b"), e => /** @type {any} */ (e).code === "not_found");
});

test("an automatic move waits out the cooldown; a crash, a lapse and the person's own move never do", () => {
  const c = clock(), b = createPlacementBook({ now: c.now });
  b.lend({ session: "s1", ...who });
  assert.equal(b.toServer("s1", "unplugged", { auto: true }).changed, true);
  b.bringBack("s1", "per_a"); c.tick(30_000); b.lend({ session: "s1", ...who });
  assert.deepEqual(b.toServer("s1", "unplugged", { auto: true }), { changed: false, why: "cooldown", row: b.get("s1") }, "no ping-pong inside the cooldown");
  assert.equal(b.toServer("s1", "crash").changed, true, "a computer that vanished is taken at once");
  b.bringBack("s1", "per_a"); b.lend({ session: "s1", ...who });
  c.tick(COOLDOWN_MS + 1);
  assert.equal(b.toServer("s1", "you", { auto: false }).changed, true);
  b.bringBack("s1", "per_a"); b.lend({ session: "s1", ...who }); c.tick(1000);
  assert.equal(b.toServer("s1", "cpu-cap", { auto: true }).changed, false, "a person's own move also starts a cooldown for the automatic ones");
});

test("a condition that clears offers the session back and moves nothing; a reason that does not clear offers nothing; a pin to the server offers nothing", () => {
  const b = createPlacementBook();
  for (const s of ["s1", "s2", "s3"]) b.lend({ session: s, ...who });
  b.toServer("s1", "lid-closed"); b.toServer("s2", "version-skew"); b.pin("s3", "server"); b.toServer("s3", "offline");
  const offered = b.clear("dev_mac");
  assert.deepEqual(offered.map(r => r.session), ["s1"]);
  assert.equal(b.get("s1")?.where, "server", "offered, not moved");
  assert.equal(b.get("s1")?.offer, "mac");
  assert.equal(b.get("s2")?.offer, null);
  assert.equal(b.get("s3")?.offer, null);
  assert.throws(() => b.bringBack("s3", "per_a"), e => /** @type {any} */ (e).code === "conflict");
  assert.deepEqual(b.clear("dev_mac"), [], "offered once");
});

test("a pin to the server is never overridden: the computer may not start the session", () => {
  const b = createPlacementBook();
  b.lend({ session: "s1", ...who }); b.pin("s1", "server"); b.toServer("s1", "you");
  assert.throws(() => b.lend({ session: "s1", ...who }), e => /** @type {any} */ (e).code === "conflict" && /pinned/.test(/** @type {any} */ (e).message));
  assert.equal(placementOf(b.get("s1")).pinned, true);
  b.pin("s1", null);
  assert.equal(placementOf(b.get("s1")).pinned, false);
});

test("the book survives a restart: place, epoch and offer come back from the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "book-"));
  try {
    const file = path.join(dir, "lent", "placements.json");
    const c = clock(), a = createPlacementBook({ now: c.now, store: fileStore(file) });
    a.lend({ session: "s1", chat: "chat_x", ...who }); a.toServer("s1", "asleep"); a.clear("dev_mac");
    assert.equal((fs.statSync(file).mode & 0o777), 0o600);
    const b = createPlacementBook({ now: c.now, store: fileStore(file) });
    assert.deepEqual([b.get("s1")?.where, b.get("s1")?.epoch, b.get("s1")?.reason, b.get("s1")?.offer], ["server", 2, "asleep", "mac"]);
    assert.equal(b.find("chat_x")?.session, "s1", "a chat id finds its session");
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["placements.json"], "no temporary file is left behind");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a session not in the book is on the server, and the answer says so without inventing a computer", () => {
  assert.deepEqual(placementOf(null), { where: "server", computer: null, state: "server", reason: null, since: null, offer: null, pinned: false, pin: null });
  const b = createPlacementBook(); const r = b.lend({ session: "s1", ...who });
  assert.deepEqual([placementOf(r, { computer: "Office Mac" }).where, placementOf(r, { computer: "Office Mac" }).computer], ["mac", "Office Mac"]);
});
