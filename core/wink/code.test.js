// @ts-check
// The showing device's typed-code state machine: the rules of spec 6.5, with a fake clock and
// transport and the real PAKE from relay/client/code.js.

import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import * as client from "../../relay/client/code.js";
import { createWinkCode, CODE_TTL_MS, MAX_ATTEMPTS } from "./code.js";

const ROUTE = "r".repeat(26);

/** A world: a clock, a relay stub that hands out rendezvous in order, events, and a counting PAKE. */
function world(o = {}) {
  let t = 1_000_000;
  const events = [];
  let nextRv = 0;
  const released = [];
  const evals = { n: 0, outputs: /** @type {Uint8Array[]} */ ([]), confirms: /** @type {any[]} */ ([]) };
  const crypto = {
    ...client,
    showingStart(a) {
      evals.n++;
      const e = client.showingStart(a);
      evals.outputs.push(e.second);
      return { second: e.second, confirm: tag => { const r = e.confirm(tag); evals.confirms.push(r); return r; } };
    },
  };
  const rvs = () => client.rendezvousFromIndex(100 + nextRv++);
  const code = createWinkCode({
    route: ROUTE,
    allocate: async () => o.allocate ? o.allocate() : { rv: rvs() },
    release: () => released.push(true),
    emit: (name, data) => events.push([name, data]),
    now: () => t,
    crypto,
    ...o.opts,
  });
  return { code, events, evals, released, advance: ms => { t += ms; }, names: () => events.map(e => e[0]), last: name => /** @type {any} */ ([...events].reverse().find(e => e[0] === name)?.[1]) };
}

/** A typist at the code the showing device shows. */
function typist(shown, pwOverride) {
  const p = client.parseCode(shown.code);
  return client.typistStart({ pw: pwOverride ?? /** @type {any} */ (p).pw, rv: shown.rv });
}
/** Runs message 1 to the showing device; returns { t, reply }. */
function first(w, shown, pw) {
  const t = typist(shown, pw);
  const reply = w.code.handle({ rv: shown.rv, s: t.s, n: 1, m: client.b64url(t.first) });
  return { t, reply };
}
function confirmMsg(w, shown, f) {
  const m3 = f.t.second(/** @type {Uint8Array} */ (client.unb64url(/** @type {any} */ (f.reply).m)), ROUTE);
  return w.code.handle({ rv: shown.rv, s: f.t.s, n: 3, m: client.b64url(m3) });
}

test("a code opens on a rendezvous the relay gave, lives 5 minutes, and is replaced with no tap when it runs out", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  assert.match(shown.code, /^WINK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(shown.rv, client.parseCode(shown.code)?.rv);
  assert.equal(shown.expires, 1_000_000 + CODE_TTL_MS);
  assert.equal(w.last("wink.code.opened").code, shown.code);
  w.advance(CODE_TTL_MS - 1);
  await w.code.tick();
  assert.equal(w.code.status()?.code, shown.code, "still good a millisecond early");
  w.advance(1);
  await w.code.tick();
  assert.deepEqual(w.names(), ["wink.code.opened", "wink.code.closed", "wink.code.replaced"]);
  assert.equal(w.last("wink.code.closed").reason, "expired");
  const next = w.last("wink.code.replaced");
  assert.notEqual(next.rv, shown.rv, "a fresh rendezvous");
  assert.notEqual(next.code, shown.code);
  assert.equal(next.reason, "expired");
  assert.equal(w.released.length, 1);
  // The old code answers nothing, even to a typist who has it right.
  assert.equal(w.code.handle({ rv: shown.rv, s: client.b64url(new Uint8Array(16)), n: 1, m: client.b64url(new Uint8Array(32)) }), null);
});

test("the right code, then the code typed back: both sides agree, the code is used up, and nothing replaces it", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  const f = first(w, shown);
  assert.ok(f.reply, "message 2 comes back");
  const m4 = confirmMsg(w, shown, f);
  assert.ok(m4, "message 4 comes back once the typist's confirmation verified");
  const fin = /** @type {any} */ (f.t.finish(/** @type {Uint8Array} */ (client.unb64url(/** @type {any} */ (m4).m))));
  assert.equal(fin.ok, true);
  const ack = w.last("wink.code.ack");
  assert.ok(ack.id, "the person is asked to type back the typing device's code");
  assert.equal(w.names().includes("wink.code.pick"), false, "there is no pick-a-number step");
  assert.equal("pick" in w.code, false, "and no way to call one");
  const typed = client.ackCode(fin.key);
  const r = await w.code.ack(ack.id, typed.toLowerCase().replace(/-/g, " "));
  assert.equal(r.ok, true);
  assert.equal(client.toHex(/** @type {any} */ (r).key), client.toHex(fin.key), "the sealing key is shared");
  assert.deepEqual(w.names().slice(-2), ["wink.code.closed", "wink.code.done"]);
  assert.equal(w.last("wink.code.closed").reason, "used");
  assert.equal(w.code.status(), null, "single use: no code is showing, none was made");
  assert.equal(first(w, shown).reply, null);
  assert.deepEqual(await w.code.ack(ack.id, typed), { ok: false });
});

test("the typist confirms first: a bad confirmation gets nothing derived from the key, and no number is offered", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  // A typist with a wrong password: message 2 is the same kind of thing as for a right one (g^y), then a wrong confirmation.
  const f = first(w, shown, "QM4P2X" === client.parseCode(shown.code)?.pw ? "QM4P2Y" : "QM4P2X");
  assert.ok(f.reply, "message 2 carries nothing that depends on the key");
  assert.equal(w.evals.confirms.length, 0, "nothing was confirmed yet");
  const out = confirmMsg(w, shown, f);
  assert.equal(out, null);
  assert.deepEqual(w.evals.confirms, [{ ok: false }], "the verdict carries no tag, key or number");
  assert.equal(w.names().includes("wink.code.ack"), false);
  // Message 3 before message 1, and message 3 from a session nobody started, are refused.
  assert.equal(w.code.handle({ rv: shown.rv, s: client.b64url(new Uint8Array(16).fill(5)), n: 3, m: client.b64url(new Uint8Array(32)) }), null);
  // Everything this device put on the wire in the failed session is message 2 (Yb), which depends on the password only through g.
  assert.equal(w.evals.outputs.length, 1);
});

test("a wrong confirmation counts an attempt and says so quietly; the code stays unless rotateOnWrong is set", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  // the last try closes the code as it starts (MAX_ATTEMPTS), so the code stays through the tries before it
  const tries = MAX_ATTEMPTS - 1;
  for (let i = 1; i <= tries; i++) { confirmMsg(w, shown, first(w, shown, "00000A")); assert.equal(w.code.status()?.attempts, i); }
  assert.equal(w.names().filter(n => n === "wink.code.wrong").length, tries);
  assert.equal(w.last("wink.code.wrong").attempts, tries);
  assert.equal(w.code.status()?.code, shown.code);
  const r = world({ opts: { rotateOnWrong: true } });
  const s2 = /** @type {any} */ (await r.code.open());
  confirmMsg(r, s2, first(r, s2, "00000A"));
  await new Promise(x => setImmediate(x));
  assert.equal(r.last("wink.code.closed").reason, "wrong_code");
  assert.notEqual(r.code.status()?.rv, s2.rv);
});

test("an abort after message 1 consumes an attempt", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  assert.equal(w.code.status()?.attempts, 0);
  const f = first(w, shown);           // message 1 processed, then the typist walks away
  assert.ok(f.reply);
  assert.equal(w.code.status()?.attempts, 1, "abandoned, and still counted");
  // A replayed message 1 under the same session id is not evaluated again and costs nothing more.
  assert.equal(w.code.handle({ rv: shown.rv, s: f.t.s, n: 1, m: client.b64url(f.t.first) }), null);
  assert.equal(w.code.status()?.attempts, 1);
  assert.equal(w.evals.n, 1);
  // The remaining abandoned sessions: the last one closes the code and a fresh one replaces it.
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) first(w, shown);
  await new Promise(x => setImmediate(x));
  assert.equal(w.last("wink.code.closed").reason, "too_many");
  assert.equal(w.evals.n, MAX_ATTEMPTS);
  const next = w.last("wink.code.replaced");
  assert.notEqual(next.rv, shown.rv);
  assert.equal(w.code.status()?.attempts, 0, "the fresh code starts at none");
});

test("50 parallel first messages give at most 10 key evaluations, then the code is closed and replaced", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  const typists = Array.from({ length: 50 }, () => typist(shown));
  // All fifty arrive in the same tick, before any event loop turn.
  const replies = typists.map(t => w.code.handle({ rv: shown.rv, s: t.s, n: 1, m: client.b64url(t.first) }));
  assert.ok(w.evals.n <= MAX_ATTEMPTS, `${w.evals.n} evaluations`);
  assert.equal(w.evals.n, MAX_ATTEMPTS);
  assert.equal(replies.filter(Boolean).length, MAX_ATTEMPTS);
  await new Promise(x => setImmediate(x));
  assert.equal(w.last("wink.code.closed").reason, "too_many");
  // Any later message to the old code, a completing one included, answers nothing.
  const late = typists[0];
  assert.equal(w.code.handle({ rv: shown.rv, s: late.s, n: 3, m: client.b64url(new Uint8Array(32)) }), null);
  assert.equal(w.evals.n, MAX_ATTEMPTS);
});

test("one try for the typed-back code: a wrong one closes the code, a fresh one replaces it, and the old one is dead", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  const f = first(w, shown);
  const m4 = confirmMsg(w, shown, f);
  const fin = /** @type {any} */ (f.t.finish(/** @type {Uint8Array} */ (client.unb64url(/** @type {any} */ (m4).m))));
  const ack = w.last("wink.code.ack");
  assert.deepEqual(await w.code.ack(ack.id, "WINK-0000-0000"), { ok: false });
  assert.equal(w.last("wink.code.closed").reason, "wrong_number");
  const next = w.last("wink.code.replaced");
  assert.equal(next.reason, "wrong_number");
  assert.notEqual(next.rv, shown.rv);
  // The right code now is too late: one try per code.
  assert.deepEqual(await w.code.ack(ack.id, client.ackCode(fin.key)), { ok: false });
  assert.equal(w.names().includes("wink.code.done"), false);
  // And a made-up id never works.
  assert.deepEqual(await w.code.ack("nonsense", client.ackCode(fin.key)), { ok: false });
});

test("once a session completed the PAKE, the code is spoken for and nobody else is evaluated", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  const f = first(w, shown);
  assert.ok(confirmMsg(w, shown, f));
  const before = w.evals.n;
  assert.equal(first(w, shown).reply, null);
  assert.equal(w.evals.n, before);
});

test("bad messages cost nothing: wrong rendezvous, short or malformed bytes, an identity point", async () => {
  const w = world();
  const shown = /** @type {any} */ (await w.code.open());
  const t = typist(shown);
  const ok = { rv: shown.rv, s: t.s, n: 1, m: client.b64url(t.first) };
  assert.equal(w.code.handle({ ...ok, rv: "ZZ" }), null);
  assert.equal(w.code.handle({ ...ok, m: "short" }), null);
  assert.equal(w.code.handle({ ...ok, s: "short" }), null);
  assert.equal(w.code.handle({ ...ok, n: 2 }), null);
  assert.equal(w.code.handle(/** @type {any} */ (null)), null);
  assert.equal(w.evals.n, 0);
  // An identity point is refused by the group code; it counts (it reached the evaluation) and answers nothing.
  assert.equal(w.code.handle({ ...ok, m: client.b64url(new Uint8Array(32)) }), null);
  assert.equal(w.code.status()?.attempts, 1);
});

test("a cancelled code closes with no replacement; open() shows a new one", async () => {
  const w = world();
  await w.code.open();
  w.code.cancel();
  assert.equal(w.last("wink.code.closed").reason, "cancelled");
  assert.equal(w.code.status(), null);
  const again = await w.code.open();
  assert.ok(again);
  assert.equal(w.names().filter(n => n === "wink.code.opened").length, 2);
});

test("when the relay has no rendezvous, nothing shows and the event says so; the next open() works", async () => {
  let ok = false;
  const w = world({ allocate: async () => ok ? { rv: "K7" } : null });
  assert.equal(await w.code.open(), null);
  assert.equal(w.last("wink.code.unavailable").reason, "relay");
  assert.equal(w.code.status(), null);
  ok = true;
  assert.ok(await w.code.open());
});

test("the code's lifetime never outlasts the rendezvous the relay granted", async () => {
  const w = world({ allocate: async () => ({ rv: "K7", exp: 1_000_000 + 60_000 }) });
  const shown = /** @type {any} */ (await w.code.open());
  assert.equal(shown.expires, 1_000_000 + 60_000);
});
