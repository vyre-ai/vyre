// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { watchHeal } from "./heal-watch.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** A fake connection store, browser and clock. */
function fakes() {
  /** @type {((s: { status: string }) => void)[]} */ const conn = [];
  /** @type {(() => void)[]} */ const online = [];
  /** @type {{ f: () => void, ms: number } | null} */ let timer = null;
  let cleared = false;
  return {
    onConnection: (/** @type {(s: { status: string }) => void} */ f) => { conn.push(f); return () => { conn.splice(conn.indexOf(f), 1); }; },
    onOnline: (/** @type {() => void} */ f) => { online.push(f); return () => { online.splice(online.indexOf(f), 1); }; },
    setInterval: (/** @type {() => void} */ f, /** @type {number} */ ms) => { timer = { f, ms }; return 1; },
    clearInterval: () => { cleared = true; },
    status: (/** @type {string} */ s) => { for (const f of [...conn]) f({ status: s }); },
    online: () => { for (const f of [...online]) f(); },
    fire: () => timer && timer.f(),
    get timer() { return timer; },
    get cleared() { return cleared; },
    get listeners() { return conn.length + online.length; },
  };
}

test("the repairs run again when the connection comes back, when the browser is online again, and on a ten-minute timer, never on a steady connection", async () => {
  const f = fakes();
  let runs = 0;
  const w = watchHeal({ heal: async () => { runs++; }, onConnection: f.onConnection, onOnline: f.onOnline, setInterval: f.setInterval, clearInterval: f.clearInterval });
  assert.equal(f.timer?.ms, 600_000);
  f.status("live"); await tick();
  assert.equal(runs, 0, "a live connection that stays live runs nothing");
  f.status("reconnecting"); await tick();
  assert.equal(runs, 0);
  f.status("live"); await tick();
  assert.equal(runs, 1, "back from reconnecting");
  f.status("offline"); f.status("live"); await tick();
  assert.equal(runs, 2, "back from offline");
  f.online(); await tick();
  assert.equal(runs, 3);
  f.fire(); await tick();
  assert.equal(runs, 4, "the timer");
  w.stop();
  assert.equal(f.cleared, true);
  assert.equal(f.listeners, 0);
});

test("one run at a time, and a failing run is quiet and does not stop the next", async () => {
  const f = fakes();
  let runs = 0;
  /** @type {() => void} */ let finish = () => {};
  const w = watchHeal({ heal: () => { runs++; return new Promise((_, rej) => { finish = () => rej(new Error("directory down")); }); }, onConnection: f.onConnection, setInterval: f.setInterval, clearInterval: f.clearInterval });
  f.fire(); f.fire(); await tick();
  assert.equal(runs, 1, "the second waits for the first");
  finish(); await tick(); await tick();
  f.fire(); await tick();
  assert.equal(runs, 2);
  w.stop();
});
