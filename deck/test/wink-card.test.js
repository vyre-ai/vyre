// @ts-check
// The shared Wink ring card (js/wink-card.js, used by onboarding's devices step and Settings > Devices): after one explicit tap it
// keeps a code fresh for whoever is looking at it, so a second scan always finds a live ring. No proof is asked for a renewal;
// a server that wants one gets a plain Refresh. Never while hidden, never more than a handful in a row, never after redemption.

import "../../scripts/mac-test-guard.mjs";
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

/** A card against a server that has the pairing window: its tools and its events. */
function windowWorld() {
  let now = 1_000_000_000_000; const realNow = Date.now; Date.now = () => now;
  /** @type {{ name: string, input: any, opts: any }[]} */ const calls = [];
  let n = 0;
  /** @type {Record<string, (e: any) => void>} */ const events = {};
  /** @type {(() => void) | null} */ let tick = null;
  const attempt = async (/** @type {string} */ name, /** @type {any} */ input = {}, /** @type {any} */ opts) => {
    calls.push({ name, input, opts });
    if (name === "relay.pair.window.open") return { data: { window: "w1", closesAt: now + 30_000, pingEveryMs: 15_000, ticket: T(n++), ticketExpiresAt: now + 5 * 60_000 } };
    if (name === "relay.pair.window.renew") return { data: { ticket: T(n++), ticketExpiresAt: now + 5 * 60_000 } };
    return { data: {} };
  };
  const el = buildWinkCard({ attempt, subscribe: (e, f) => { events[e] = f; }, every: f => { tick = f; }, cleanup: () => {}, calm: () => true });
  const click = (/** @type {string} */ label) => { const b = /** @type {any[]} */ ([...el.querySelectorAll("button")]).find(x => x.textContent === label); assert.ok(b, label); b.listeners.get("click")[0](); };
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
  const advance = async (/** @type {number} */ ms) => { now += ms; tick?.(); await settle(); };
  const count = (/** @type {string} */ name) => calls.filter(c => c.name === name).length;
  return { el, calls, click, settle, advance, events, count, restore: () => { Date.now = realNow; } };
}

test("a pairing window: one proof opens it, pings go every 15 s only while in view, renewals carry the window id and ask for no proof", async t => {
  const w = windowWorld(); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  assert.equal(w.count("relay.pair.window.open"), 1);
  assert.deepEqual(w.calls[0].opts, { presence: "asked" }, "the one Touch ID");
  assert.equal(w.count("relay.pair.ticket"), 0, "no per-code mint when the window exists");
  await w.advance(14_000); assert.equal(w.count("relay.pair.window.ping"), 0);
  await w.advance(2_000); assert.equal(w.count("relay.pair.window.ping"), 1, "a ping after 15 s");
  assert.deepEqual(w.calls.find(c => c.name === "relay.pair.window.ping")?.input, { window: "w1" });
  /** @type {any} */ (document).visibilityState = "hidden";
  await w.advance(6 * 60_000); assert.equal(w.count("relay.pair.window.ping"), 1, "out of view: no ping, the window will close on its own");
  /** @type {any} */ (document).visibilityState = "visible";
  await w.advance(1_000);
  const renew = w.calls.find(c => c.name === "relay.pair.window.renew");
  assert.ok(renew, "the code ran out while hidden: renewed on return");
  assert.deepEqual(renew?.input, { window: "w1" });
  assert.equal(renew?.opts, undefined, "no proof for a renewal");
});

test("a phone redeems: 'A phone is pairing' with its name and fingerprint; only Confirm enrols; Not you? Close closes the window and pairs nothing", async t => {
  const w = windowWorld(); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  await w.events["pairing.requested"]({ payload: { window: "w9", device: "dX", name: "Evil", fingerprint: "FF" } });
  await w.settle(); assert.doesNotMatch(text(w.el), /Evil/, "another window's phone is not ours");
  await w.events["pairing.requested"]({ payload: { window: "w1", device: "d1", name: "Alex's iPhone", fingerprint: "AB12 CD34" } });
  await w.advance(1_000);
  assert.match(text(w.el), /A phone is pairing/); assert.match(text(w.el), /Alex's iPhone/); assert.match(text(w.el), /AB12 CD34/);
  assert.equal(w.count("relay.pair.window.confirm"), 0, "nothing is enrolled until Confirm");
  w.click("Confirm"); await w.settle();
  assert.deepEqual(w.calls.filter(c => c.name === "relay.pair.window.confirm").map(c => [c.input, c.opts]), [[{ window: "w1", device: "d1" }, undefined]]);
  const w2 = windowWorld(); t.after(w2.restore);
  w2.click("Add a device"); await w2.settle();
  await w2.events["pairing.requested"]({ payload: { window: "w1", device: "d2", name: "Sam's Pixel", fingerprint: "11 22" } });
  await w2.advance(1_000);
  w2.click("Not you? Close"); await w2.settle();
  assert.equal(w2.count("relay.pair.window.close"), 1);
  assert.equal(w2.count("relay.pair.window.confirm"), 0);
  assert.match(text(w2.el), /Nothing was paired/);
});

test("the server closes the window: a plain line and Refresh (which asks for the next proof); completed leaves it to relay.paired", async t => {
  const w = windowWorld(); t.after(w.restore);
  w.click("Add a device"); await w.settle();
  await w.events["pairing-window.closed"]({ payload: { window: "w1", reason: "silence" } });
  await w.advance(1_000);
  assert.match(text(w.el), /went quiet/);
  w.click("Refresh"); await w.settle();
  assert.equal(w.count("relay.pair.window.open"), 2, "the next window is a new proof");
  const w2 = windowWorld(); t.after(w2.restore);
  w2.click("Add a device"); await w2.settle();
  await w2.events["pairing-window.closed"]({ payload: { window: "w1", reason: "completed" } });
  await w2.events["relay.paired"]({ payload: { device: "d1", name: "Alex's iPhone", fingerprint: "AB12" } });
  await w2.settle();
  assert.match(text(w2.el), /Your phone is connected/);
});
