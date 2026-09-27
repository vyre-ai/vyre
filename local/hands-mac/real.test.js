// @ts-check
// The hands on the real Mac, against a window this test owns and nothing else.
//
// testwin opens unfocused and every request here is pinned to its pid, so the person's keyboard
// and focus stay where they were. Keystrokes go to that pid only (the helper has no other way to
// send them). The overlay helper runs for real, draws a ring on each act and the pill, and the
// run saves one screenshot of the test window with them on it when Screen Recording is already
// granted (checked by preflight, which never prompts). Skipped cleanly off macOS, without the
// builds, or without the Accessibility grant.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Hands } from "./hands.js";
import { makeRunner } from "./runner.js";
import { makeOverlay, OVERLAY_BIN } from "./overlay.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AX = path.join(HERE, "bin", "ax");
const TESTWIN = path.join(HERE, "..", "screen-mac", "bin", "testwin");
const SHOTS = process.env.VYRE_HANDS_SHOTS || "";

/** Why this cannot run here, or "" when it can. */
async function unavailable() {
  if (process.platform !== "darwin") return "not macOS";
  for (const [bin, how] of [[AX, "local/hands-mac/build.sh"], [OVERLAY_BIN, "local/hands-mac/build.sh"],
    [TESTWIN, "swiftc -O -o local/screen-mac/bin/testwin local/screen-mac/swift/testwin.swift"]]) {
    if (!fs.existsSync(bin)) return `${path.basename(bin)} is not built (${how})`;
  }
  try { if (!(await makeRunner({ bin: AX })({ cmd: "trust" })).trusted) return "no Accessibility grant"; }
  catch (e) { return `the helper failed: ${/** @type {Error} */ (e).message}`; }
  return "";
}

function preflight() {
  try { return JSON.parse(execFileSync(OVERLAY_BIN, ["--preflight"], { encoding: "utf8", timeout: 5000 })); }
  catch { return null; }
}

const why = await unavailable();

test("real: press, type, a refused password, a held Send, with the ring and pill on screen", { skip: why || false, timeout: 60000 }, async t => {
  const pre = preflight();
  // Top centre, under the menu bar, so the pill is drawn over this window and nowhere else the
  // screenshot would have to include.
  const W = 520, H = 360, TITLE = 32;
  const vis = pre && pre.visible ? pre.visible : { x: 0, y: 0, w: 1440, h: 860 };
  const x = Math.round(vis.x + vis.w / 2 - W / 2), y = Math.round(vis.y + vis.h - H - TITLE);
  const title = `Vyre hands test ${process.pid}`;
  const tw = spawn(TESTWIN, ["--title", title, "--x", String(x), "--y", String(y), "--w", String(W), "--h", String(H)], { stdio: ["pipe", "pipe", "ignore"] });
  t.after(() => { try { tw.stdin.end(); } catch {} setTimeout(() => { try { tw.kill("SIGKILL"); } catch {} }, 500).unref(); });
  const info = await new Promise((ok, no) => {
    tw.stdout.once("data", d => { try { ok(JSON.parse(String(d).split("\n")[0])); } catch (e) { no(e); } });
    tw.once("exit", () => no(new Error("testwin exited")));
  });

  const overlay = makeOverlay({ ringMs: 2500, linger: 4 });
  t.after(() => overlay.close());
  /** @type {number[]} */
  const times = [];
  const ax = makeRunner({ bin: AX });
  const run = async (/** @type {any} */ req) => {
    const t0 = performance.now();
    try { return await ax(req); } finally { times.push(performance.now() - t0); }
  };
  const events = [];
  const hands = new Hands({ run, overlay, emit: (type, p) => events.push([type, p]), known: async () => ({ box: null }) });
  const pid = info.pid;

  // A new window takes a moment to appear in the accessibility tree.
  let seen;
  for (let i = 0; i < 30; i++) {
    try { seen = await hands.observe({ pid }); if (seen.elements.some(e => e.selector.name === "Press me")) break; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  assert.ok(seen && seen.elements.some(e => e.selector.name === "Press me"), "testwin never showed its controls");
  assert.equal(seen.window, title);
  assert.equal(seen.bundle, null, "a bare executable has no bundle id");
  times.length = 0;

  const pressed = await hands.act({ pid, selector: { role: "AXButton", name: "Press me" }, kind: "press" });
  assert.equal(pressed.verified, true, pressed.reason);
  const after1 = await hands.observe({ pid });
  assert.ok(after1.texts.includes("Pressed 1"), JSON.stringify(after1.texts));

  // The ring is on screen for 2.5 s after each act: this is the moment to take the picture.
  const win = after1.elements.find(e => e.selector.role === "AXWindow");
  if (SHOTS && pre && pre.screen && win && win.frame) {
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = win.frame, file = path.join(SHOTS, "hands-ring-testwin.png");
    execFileSync("/usr/sbin/screencapture", ["-x", "-R", `${f.x},${f.y},${f.w},${f.h}`, file], { timeout: 10000 });
    t.diagnostic(`screenshot ${file}`);
  } else t.diagnostic(`no screenshot (${!SHOTS ? "VYRE_HANDS_SHOTS unset" : !pre || !pre.screen ? "Screen Recording not granted" : "no window frame"})`);

  const typed = await hands.act({ pid, selector: { role: "AXTextField", name: "Name" }, kind: "type", value: "Northwind Bakery" });
  assert.equal(typed.verified, true, typed.reason);
  assert.equal(typed.after?.target?.value, "Northwind Bakery");

  for (const kind of ["set", "type"]) {
    await assert.rejects(hands.act({ pid, selector: { role: "AXTextField", name: "Password" }, kind, value: "x" }),
      e => /** @type {any} */ (e).code === "secure" && /vault\.fill/.test(e.message));
  }

  const held = await hands.act({ pid, selector: { role: "AXButton", name: "Send" }, kind: "press" });
  assert.equal(held.held, true);
  assert.equal(held.acted, false);
  assert.equal(held.use, "hands.commit");
  const after2 = await hands.observe({ pid });
  assert.ok(!after2.texts.includes("Sent"), "a held Send was pressed anyway");

  const perCall = times.slice().sort((a, b) => a - b);
  t.diagnostic(`ax per call: n=${perCall.length} median=${perCall[Math.floor(perCall.length / 2)].toFixed(0)}ms max=${perCall[perCall.length - 1].toFixed(0)}ms`);
  assert.ok(!JSON.stringify(events).includes("Northwind"), "typed text reached an event");
});

test("real: the overlay helper's own logic checks out (stop keys, geometry, protocol)", { skip: process.platform !== "darwin" ? "not macOS" : !fs.existsSync(OVERLAY_BIN) ? "overlay is not built (local/hands-mac/build.sh)" : false }, () => {
  const out = JSON.parse(execFileSync(OVERLAY_BIN, ["--selftest"], { encoding: "utf8", timeout: 10000 }));
  assert.equal(out.selftest, "ok", JSON.stringify(out.failed));
  assert.ok(out.passed >= 20);
});

test("real: the overlay helper starts, says it can hear the keys, and exits when stdin closes", { skip: why || false, timeout: 15000 }, async () => {
  const c = spawn(OVERLAY_BIN, ["--linger", "5"], { stdio: ["pipe", "pipe", "ignore"] });
  const first = await new Promise(ok => c.stdout.once("data", d => ok(JSON.parse(String(d).split("\n")[0]))));
  assert.deepEqual(first, { keys: true, ready: true });
  const exited = new Promise(ok => c.once("exit", code => ok(code)));
  c.stdin.end();
  assert.equal(await exited, 0);
});
