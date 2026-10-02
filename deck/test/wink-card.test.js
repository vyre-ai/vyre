// @ts-check
// The shared Wink ring card (js/wink-card.js, used by onboarding's devices step and Settings > Devices): after one explicit tap it
// keeps a code fresh for whoever is looking at it, so a second scan always finds a live ring. No proof is asked for a renewal;
// a server that wants one gets a plain Refresh. Never while hidden, never more than a handful in a row, never after redemption.

import { test } from "node:test";
import assert from "node:assert/strict";
import { install, text } from "./fake-dom.js";

install();
/** @type {any} */ (globalThis).DOMParser = class { parseFromString() { const s = document.createElement("svg"); s.append(document.createElement("circle")); return { documentElement: s }; } };
/** @type {any} */ (document).importNode = (/** @type {any} */ n) => n;
/** @type {any} */ (document).visibilityState = "visible";
/** @type {any} */ (document).addEventListener = () => {};
/** @type {Record<string, () => void>} */ const win = {};
/** @type {any} */ (globalThis).addEventListener = (/** @type {string} */ t, /** @type {() => void} */ f) => { win[t] = f; };
/** @type {any} */ (document.documentElement).dataset = {};
const { buildWinkCard } = await import("../js/wink-card.js");

const T = (/** @type {number} */ n) => String.fromCharCode(97 + n).repeat(11); // an 11-character ticket

function world(/** @type {{ renewAnswer?: (n: number) => any }} */ o = {}) {
  let now = 1_000_000_000_000;
  const realNow = Date.now;
  Date.now = () => now;
  /** @type {{ name: string, input: any, opts: any }[]} */ const calls = [];
  let minted = 0;
  /** @type {(() => void) | null} */ let tick = null;
  /** @type {Record<string, (e: any) => void>} */ const events = {};
  const attempt = async (/** @type {string} */ name, /** @type {any} */ input = {}, /** @type {any} */ opts) => {
    calls.push({ name, input, opts });
    if (name !== "relay.pair.ticket") return { data: {} };
    if (opts === undefined && o.renewAnswer) { const a = o.renewAnswer(calls.filter(c => c.opts === undefined).length); if (a) return a; }
    const n = minted++;
    return { data: { ticket: T(n), expiresAt: now + 5 * 60_000, confirmed: true } };
  };
  const el = buildWinkCard({ attempt, subscribe: (e, f) => { events[e] = f; }, every: f => { tick = f; }, cleanup: () => {}, calm: () => true });
  const click = (/** @type {string} */ label) => { const b = /** @type {any[]} */ ([...el.querySelectorAll("button")]).find(x => x.textContent === label); assert.ok(b, label); b.listeners.get("click")[0](); };
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  const advance = async (/** @type {number} */ ms) => { now += ms; tick?.(); await settle(); };
  return { el, calls, click, settle, advance, events, now: () => now, restore: () => { Date.now = realNow; },
    renews: () => calls.filter(c => c.name === "relay.pair.ticket" && c.opts === undefined).length, taps: () => calls.filter(c => c.name === "relay.pair.ticket" && c.opts !== undefined).length };
}

test("the first code is minted by the tap with a proof asked; the last 30 seconds renew it with none, and the new ring replaces the old", async t => {
  const w = world(); t.after(w.restore);
  assert.equal(w.calls.length, 0, "nothing is minted on render");
  w.click("Add a device"); await w.settle();
  assert.deepEqual([w.taps(), w.renews()], [1, 0]);
  assert.deepEqual(w.calls[0].opts, { presence: "asked" });
  await w.advance(4 * 60_000); assert.equal(w.renews(), 0, "plenty of time left: no renewal");
  await w.advance(40_000); // 25 s left
  assert.equal(w.renews(), 1, "renewed in the last 30 seconds");
  assert.equal(w.calls.at(-1)?.opts, undefined, "no proof asked for a renewal");
  assert.match(text(w.el), /Expires in 4:5\d|Expires in 5:00/, "the countdown is the new code's");
  await w.advance(2_000); assert.equal(w.renews(), 1, "one renewal, not one a second");
});

test("a server that wants a proof for a renewal: no more tries, the code runs out, and Refresh asks as it always did", async t => {
  const w = world({ renewAnswer: () => ({ error: { code: "presence_required" } }) }); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  await w.advance(4 * 60_000 + 40_000);
  assert.equal(w.renews(), 1);
  await w.advance(60_000);
  assert.equal(w.renews(), 1, "it does not keep asking");
  assert.match(text(w.el), /This code expired/);
  w.click("Refresh"); await w.settle();
  assert.equal(w.taps(), 2, "Refresh is the explicit tap, with its proof");
  await w.advance(4 * 60_000 + 40_000);
  assert.equal(w.renews(), 2, "a tap re-arms the renewals");
});

test("hidden or blurred: nothing is renewed; coming back to a spent code renews it at once", async t => {
  const w = world(); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  /** @type {any} */ (document).visibilityState = "hidden";
  await w.advance(6 * 60_000);
  assert.equal(w.renews(), 0, "nobody is looking: no code is minted");
  /** @type {any} */ (document).visibilityState = "visible";
  await w.advance(1_000);
  assert.equal(w.renews(), 1, "back in view: a fresh code, no click");
  assert.doesNotMatch(text(w.el), /This code expired/);
});

test("at most six renewals in a row, then a plain expiry; redemption disarms it", async t => {
  const w = world(); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  for (let i = 0; i < 8; i++) await w.advance(4 * 60_000 + 40_000);
  assert.equal(w.renews(), 6);
  const w2 = world(); t.after(w2.restore);
  w2.click("Add a device"); await w2.settle();
  await w2.events["relay.paired"]({ payload: { device: "d1", name: "Alex's iPhone", fingerprint: "AB12" } });
  await w2.settle();
  await w2.advance(10 * 60_000);
  assert.equal(w2.renews(), 0, "a paired phone: nothing is minted for a card that is done");
});
