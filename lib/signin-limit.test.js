// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSigninLimit, guardSignin, usernameKey, addressKey, waitWords, POLICY } from "./signin-limit.js";

const MIN = 60_000;
const clock = () => { const c = { t: Date.UTC(2026, 9, 17, 12, 0, 0) }; return Object.assign(c, { now: () => c.t, advance: (/** @type {number} */ ms) => { c.t += ms; } }); };
const who = { username: "alex", address: "alex-space.vyre.run" };

test("five wrong guesses lock the username, the lock grows each time and a clean day resets it", () => {
  const c = clock(), l = createSigninLimit({ now: c.now });
  for (let i = 0; i < 5; i++) { assert.equal(l.check(who).ok, true); l.fail(who); c.advance(1000); }
  const first = l.check(who);
  assert.equal(first.ok, false);
  assert.ok(first.ok === false && first.retryAfterMs > 50_000 && first.retryAfterMs <= MIN, "the first lock is a minute");
  c.advance(MIN);
  for (let i = 0; i < 5; i++) { assert.equal(l.check(who).ok, true); l.fail(who); c.advance(1000); }
  const second = l.check(who);
  assert.ok(second.ok === false && second.retryAfterMs > 100_000 && second.retryAfterMs <= 2 * MIN, "the second lock is two minutes");
  for (let n = 0; n < 8; n++) { c.advance(61 * MIN); for (let i = 0; i < 5; i++) { l.check(who); l.fail(who); } }
  const capped = l.check(who);
  assert.ok(capped.ok === false && capped.retryAfterMs <= 60 * MIN, "no lock is longer than an hour");
  c.advance(25 * 60 * MIN);
  assert.equal(l.check(who).ok, true, "a day later the username is free");
  for (let i = 0; i < 5; i++) { l.check(who); l.fail(who); }
  const again = l.check(who);
  assert.ok(again.ok === false && again.retryAfterMs <= MIN, "and the lock starts from a minute again");
});

test("a correct sign-in clears the username but not the address, and guesses spread over many names lock the address", () => {
  const c = clock(), l = createSigninLimit({ now: c.now });
  for (let i = 0; i < 4; i++) { l.check(who); l.fail(who); }
  l.pass(who);
  for (let i = 0; i < 4; i++) { l.check(who); l.fail(who); }
  assert.equal(l.check(who).ok, true, "four more after a good sign-in is not five in a row");
  const spread = createSigninLimit({ now: c.now });
  for (let i = 0; i < 30; i++) { c.advance(500); assert.equal(spread.check({ username: `user-${i}`, address: who.address }).ok, true); spread.fail({ username: `user-${i}`, address: who.address }); }
  const locked = spread.check({ username: "someone-new", address: who.address });
  assert.equal(locked.ok, false, "thirty wrong guesses at one address lock every name there");
  assert.equal(spread.check({ username: "someone-new", address: "other.vyre.run" }).ok, true, "another address is untouched");
  spread.pass({ username: "user-1" });
  assert.equal(spread.check({ username: "user-1", address: who.address }).ok, false, "one person getting in does not clear the address");
});

test("a name that does not exist is limited exactly like one that does, and the refusal says nothing about which limit", async () => {
  const c = clock();
  const run = async (/** @type {any} */ i) => { if (i.username !== "alex") throw Object.assign(new Error("That did not work."), { code: "denied" }); throw Object.assign(new Error("That did not work."), { code: "denied" }); };
  const make = () => guardSignin(createSigninLimit({ now: c.now }), run, { kind: "finish", who: (i) => i });
  const seen = [];
  for (const username of ["alex", "nobody-here"]) {
    const g = make();
    for (let i = 0; i < 5; i++) { await assert.rejects(() => g({ username, address: who.address }), (e) => e.code === "denied"); c.advance(1000); }
    await assert.rejects(() => g({ username, address: who.address }), (e) => { seen.push([e.code, e.message, Math.round(e.retryAfterMs / 1000)]); return e.code === "rate_limited"; });
  }
  assert.deepEqual(seen[0], seen[1], "the same refusal, to the second");
  assert.ok(!/username|address|account|exist/i.test(String(seen[0][1])));
  assert.equal(waitWords(30_000), "Too many sign-in tries. Wait a minute and try again.");
  assert.equal(waitWords(5 * MIN), "Too many sign-in tries. Wait 5 minutes and try again.");
  assert.equal(waitWords(3 * 60 * MIN), "Too many sign-in tries. Wait an hour and try again.");
});

test("the guard counts a wrong answer from finish and nothing else: begin, a busy server and bad input never lock anyone", async () => {
  const c = clock(), l = createSigninLimit({ now: c.now });
  let mode = "wrong";
  const finish = guardSignin(l, async () => { if (mode === "right") return { ok: true }; if (mode === "wrong") throw Object.assign(new Error("x"), { code: "bad_password" }); if (mode === "soft") return { ok: false }; throw Object.assign(new Error("x"), { code: mode }); }, { kind: "finish", who: (i) => i, wrong: (r) => /** @type {any} */ (r).ok === false });
  const begin = guardSignin(l, async () => { throw Object.assign(new Error("x"), { code: "not_found" }); }, { kind: "begin", who: (i) => i });
  for (const m of ["unavailable", "unreachable", "bad_input", "timeout"]) { mode = m; for (let i = 0; i < 4; i++) { await assert.rejects(() => finish(who)); c.advance(7000); } }
  for (let i = 0; i < 4; i++) { await assert.rejects(() => begin(who), (e) => e.code === "not_found"); c.advance(7000); }
  mode = "right";
  assert.deepEqual(await finish(who), { ok: true }, "nothing above locked the username");
  c.advance(2 * MIN);
  mode = "soft";
  for (let i = 0; i < 5; i++) { assert.deepEqual(await finish(who), { ok: false }); c.advance(1000); }
  await assert.rejects(() => finish(who), (e) => e.code === "rate_limited", "a refusal that returns instead of throwing counts too");
  c.advance(2 * MIN);
  mode = "right";
  assert.deepEqual(await finish(who), { ok: true });
});

test("a burst of calls is refused for the rest of the window even when every one is right", async () => {
  const c = clock(), l = createSigninLimit({ now: c.now });
  const begin = guardSignin(l, async () => ({ ok: true }), { kind: "begin", who: (i) => i });
  for (let i = 0; i < POLICY.username.burst; i++) await begin(who);
  await assert.rejects(() => begin(who), (e) => e.code === "rate_limited" && e.retryAfterMs >= 1000 && e.retryAfterMs <= MIN);
  c.advance(MIN + 1);
  await begin(who);
});

test("typed addresses and names are normalised, junk shares one bucket, and the table stays bounded", () => {
  assert.equal(usernameKey(" Alex "), "alex");
  assert.equal(usernameKey("a b"), "");
  assert.equal(addressKey("https://Alex-Space.vyre.run/"), "alex-space.vyre.run");
  assert.equal(addressKey("alex-space.vyre.run:443"), "", "a port is not an address; it falls in the shared junk bucket");
  const c = clock();
  const small = createSigninLimit({ now: c.now, policy: { ...POLICY, maxKeys: 50 } });
  for (let i = 0; i < 500; i++) { small.check({ username: `n${i}`, address: `a${i}.vyre.run` }); small.fail({ username: `n${i}`, address: `a${i}.vyre.run` }); }
  assert.ok(small.size() <= 50, `held ${small.size()} keys`);
  const l = createSigninLimit({ now: c.now });
  for (let i = 0; i < 5; i++) { l.check(who); l.fail(who); }
  const keep = JSON.parse(JSON.stringify(l.snapshot()));
  const back = createSigninLimit({ now: c.now });
  back.restore(keep);
  back.restore({ v: 9, rows: [["u:evil", { fails: "x" }]] });
  assert.equal(back.check(who).ok, false, "a restart keeps a lock that was in force");
});
