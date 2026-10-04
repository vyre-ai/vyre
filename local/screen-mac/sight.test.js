// @ts-check
// The real sight helper on a real Mac, against testwin, a window this test opens unfocused and
// owns. Every read names testwin's pid, so the test never reads what the person is using, and
// testwin is changed only through its own stdin, so the person's focus and keyboard stay put.
// Skipped cleanly off macOS, when the helpers are not built, or without the Accessibility grant.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeHelper } from "./runner.js";
import { Screen } from "./screen.js";
import { tempHome } from "../../test/helpers.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIGHT = path.join(HERE, "bin", "sight");
const TESTWIN = path.join(HERE, "bin", "testwin");
const SECRET = "hunter2-test-only";

/** Why this Mac cannot run the test, or null. */
async function unavailable() {
  if (process.platform !== "darwin") return "not macOS";
  if (!fs.existsSync(SIGHT) || !fs.existsSync(TESTWIN)) return "helpers not built; run local/screen-mac/build.sh";
  const h = makeHelper({ bin: SIGHT });
  try { return (await h.request({ cmd: "trust" })).trusted ? null : "this process has no Accessibility grant"; }
  catch (e) { return String(/** @type {any} */ (e).code || e); }
  finally { await h.stop(); }
}

/** Open testwin and wait for its line. Closed in t.after, which ends it (it exits on stdin EOF). */
async function testwin(t, title) {
  const p = spawn(TESTWIN, ["--title", title, "--x", "60", "--y", "60"], { stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { p.stdin.end(); setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 1000).unref(); });
  const info = await new Promise((ok, no) => {
    p.stdout.once("data", d => ok(JSON.parse(String(d).split("\n")[0])));
    p.once("error", no);
  });
  return { ...info, say: o => p.stdin.write(JSON.stringify(o) + "\n") };
}

/** The sight helper as a raw child, so the test sees every line exactly as written. */
function rawSight(t) {
  const p = spawn(SIGHT, [], { stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { p.stdin.end(); setTimeout(() => { try { p.kill("SIGKILL"); } catch {} }, 1000).unref(); });
  /** @type {string[]} */
  const lines = [];
  /** @type {((l: string) => void)[]} */
  const waiters = [];
  let buf = "";
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", d => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l); for (const w of waiters) w(l); }
  });
  let id = 0;
  const ask = req => new Promise(ok => {
    const n = ++id;
    const w = l => { const o = JSON.parse(l); if (o.id === n) { waiters.splice(waiters.indexOf(w), 1); ok(o); } };
    waiters.push(w);
    p.stdin.write(JSON.stringify({ ...req, id: n }) + "\n");
  });
  // A line that matches, among those written from index `from` on (default: from now).
  const until = (pred, ms = 3000, from = lines.length) => new Promise((ok, no) => {
    const hit = lines.slice(from).map(l => JSON.parse(l)).find(pred);
    if (hit) return ok(hit);
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); no(new Error("no matching line")); }, ms);
    const w = l => { const o = JSON.parse(l); if (pred(o)) { clearTimeout(timer); waiters.splice(waiters.indexOf(w), 1); ok(o); } };
    waiters.push(w);
  });
  return { lines, ask, until };
}

const why = await unavailable();

test("sight: reads testwin by pid, finds its text, and never emits its password", { skip: why || false }, async t => {
  const win = await testwin(t, "Northwind real test");
  const s = rawSight(t);
  assert.equal((await s.ask({ cmd: "watch", pid: win.pid })).watching, win.pid);

  const a = await s.ask({ cmd: "context", pid: win.pid });
  assert.equal(a.window.title, "Northwind real test");
  assert.equal(a.app.pid, win.pid);
  assert.match(a.text, /Northwind Bakery/);
  assert.equal(a.cached, false);
  const b = await s.ask({ cmd: "context", pid: win.pid });
  assert.equal(b.cached, true);

  // Focus the password field inside testwin (first responder only; the app stays inactive).
  win.say({ focus: "password" });
  const c = await s.until(o => o.changed && o.changed.pid === win.pid, 3000).then(() => s.ask({ cmd: "context", pid: win.pid }));
  assert.equal(c.focused && c.focused.subrole, "AXSecureTextField", JSON.stringify(c.focused));
  assert.equal(c.secure, true);
  assert.equal("value" in c.focused, false);
  for (const l of s.lines) assert.equal(l.includes(SECRET), false, "a raw helper line carried the password");
  for (const l of s.lines) assert.equal(l.includes("hunter2"), false);
});

test("sight: a title change in the watched window arrives as a change line, unasked", { skip: why || false }, async t => {
  const win = await testwin(t, "Northwind before");
  const s = rawSight(t);
  await s.ask({ cmd: "watch", pid: win.pid });
  await s.ask({ cmd: "context", pid: win.pid, text: false });
  const asked = s.lines.length;
  win.say({ title: "Northwind after" });
  const line = await s.until(o => o.changed && o.changed.pid === win.pid && o.changed.window === "Northwind after", 3000);
  assert.equal(line.id, undefined);
  assert.ok(s.lines.length > asked);
  const again = await s.ask({ cmd: "context", pid: win.pid, text: false });
  assert.equal(again.cached, false, "the change did not invalidate the helper's cache");
  assert.equal(again.window.title, "Northwind after");
  // The helper stops listening after a change line and listens again on the next request, so a
  // second change after that request must still be heard.
  win.say({ title: "Northwind third" });
  await s.until(o => o.changed && o.changed.pid === win.pid && o.changed.window === "Northwind third", 3000);
  assert.equal((await s.ask({ cmd: "context", pid: win.pid, text: false })).window.title, "Northwind third");
});

test("sight: through the runner and Screen, first and cached call times", { skip: why || false }, async t => {
  const win = await testwin(t, "Northwind timing");
  const helper = makeHelper({ bin: SIGHT });
  const shotDir = tempHome(t);
  const screen = new Screen({ helper, shotDir });
  t.after(() => screen.stop());
  await helper.request({ cmd: "watch", pid: win.pid });
  let t0 = performance.now();
  const first = await screen.context({}, { pid: win.pid });
  const firstMs = performance.now() - t0;
  // A window that has just opened can still send a late notification (it settles on screen),
  // which rightly clears the cache; a few tries find a quiet moment for the cached timing.
  let second, cachedMs = 0;
  for (let i = 0; i < 4; i++) {
    t0 = performance.now();
    second = await screen.context({}, { pid: win.pid });
    cachedMs = performance.now() - t0;
    if (second.cached) break;
  }
  t.diagnostic(`screen.context on testwin: first ${firstMs.toFixed(1)} ms, cached ${cachedMs.toFixed(2)} ms`);
  assert.match(String(first.text), /Northwind Bakery/);
  assert.equal(second && second.cached, true);
  assert.equal(JSON.stringify([first, second]).includes(SECRET), false);

  const info = await helper.request({ cmd: "shotinfo", pid: win.pid });
  if (!info.granted) return t.diagnostic("screen.shot not tried: no Screen Recording grant");
  const shot = /** @type {any} */ (await screen.shot({}, { pid: win.pid }));
  assert.ok(fs.existsSync(shot.path));
  assert.ok(shot.width > 100 && shot.height > 100);
  if (process.env.VYRE_SCREEN_KEEP_SHOT) fs.copyFileSync(shot.path, process.env.VYRE_SCREEN_KEEP_SHOT);
});
