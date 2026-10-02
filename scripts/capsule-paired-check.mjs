#!/usr/bin/env node
// @ts-check
// capsule-paired-check: Lumen on a Mac paired to a server that has an assistant (CI, macOS only). #36.
//
//   node scripts/capsule-paired-check.mjs [path/to/Vyre.app]
//
// One node process runs a box vyred and a Mac vyred in temp homes, paired through the link's seams and a simulated tailnet
// (test/link-harness.js, the harness the link tests and deck/test/mac-world.js use). The box has an assistant called "kit"; the
// Mac has none. The built Lumen is pointed at the Mac's socket in drive mode (nothing is posted to the system) and must:
//   - know it is linked to the box and offer agents.ask,
//   - list "kit" for "@" and for a question, from the box, and never say "no assistant on this Vyre",
//   - when the box goes away, say the server is not reachable (not "no assistant"),
//   - and the Mac's own things (apps) still answer.
// A failed check exits 1; the stills go to VYRE_CAPSULE_SCREENS.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.VYRE_NO_DIALOGS = "1";
process.env.NO_COLOR = "1";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.resolve(process.argv[2] || "local/capsule/native/.build/Vyre.app");
const bin = path.join(app, "Contents", "MacOS", "Vyre");
if (!fs.existsSync(bin)) { console.error(`no app at ${app}`); process.exit(1); }

const { pair, until } = await import(path.join(REPO, "test", "link-harness.js"));
const { socketPath } = await import(path.join(REPO, "core", "config", "index.js"));

const pause = ms => new Promise(r => setTimeout(r, ms));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const watchdog = setTimeout(() => { console.log("FAIL the check did not finish in 5 minutes"); process.exit(1); }, 300_000);
watchdog.unref();

/** @type {(() => any)[]} */ const cleanups = [];
const t = { name: "capsule-paired", fullName: "scripts/capsule-paired-check.mjs", after: fn => { cleanups.push(fn); } };
let child = null;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-capsule-paired-"));

try {
  const world = await pair(t, { hold: 2000, heartbeat: 500, boxName: "kit-box", macHost: "test-mac" });
  const made = await world.boxCall("agents.create", { name: "kit", kind: "assistant", projects: "*" });
  check(!made.error, `the box has an assistant called kit${made.error ? ` (${made.error.message})` : ""}`);
  const boxAgents = ((await world.boxCall("agents.list")).data || []).map(a => a.name);
  const macAgents = ((await world.macCall("agents.list")).data || []).map(a => a.name);
  console.log(`box agents: ${boxAgents.join(", ")}; Mac agents: ${macAgents.join(", ") || "(none)"}`);
  check(boxAgents.includes("kit") && !macAgents.includes("kit"), "kit is on the box and not on the Mac");
  check((await world.macCall("link.status")).data.linked === true, "the Mac is paired to the box");

  const sock = socketPath(world.macRoot);
  child = spawn(bin, [], { env: { ...process.env, VYRE_HOME: home, VYRE_SOCKET: sock, VYRE_CAPSULE_DRIVE: "1", VYRE_CAPSULE_TEST: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  /** @type {((m: any) => void)[]} */ const waiting = [];
  readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", l => { let m; try { m = JSON.parse(l); } catch { return; } const w = waiting.shift(); if (w) w(m); });
  const send = c => new Promise((r, j) => { waiting.push(r); child.stdin?.write(JSON.stringify(c) + "\n"); setTimeout(() => j(new Error(`no answer to ${JSON.stringify(c)}`)), 20_000); });
  await new Promise((r, j) => { waiting.push(r); setTimeout(() => j(new Error("the app did not say ready")), 20_000); });
  const dir = process.env.VYRE_CAPSULE_SCREENS; if (dir) fs.mkdirSync(dir, { recursive: true });
  const still = async name => {
    if (!dir) return;
    try { const w = await send({ windowid: true }); execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(w.windowid), path.join(dir, name)], { timeout: 20_000 }); console.log(`still ${name}`); }
    catch (e) { console.log(`still ${name} failed: ${String(e && e.message || e).split("\n")[0]}`); }
  };

  await send({ show: true });
  let c = null;
  for (let i = 0; i < 40; i++) { await pause(500); c = await send({ linkcatalog: true }); if (c.linked && Array.isArray(c.agents)) break; }
  console.log(`Lumen: ${JSON.stringify(c)}`);
  check(c.linked === true, "Lumen knows this Mac is paired");
  check(c.hasAsk === true, "Lumen offers agents.ask through the server");
  check(Array.isArray(c.agents) && c.agents.includes("kit"), `Lumen's catalog has the server's assistant (got ${JSON.stringify(c.agents)})`);

  // "@": the list names kit.
  await send({ text: "@ki" });
  let p = null;
  for (let i = 0; i < 20; i++) { await pause(300); p = await send({ probe: true }); if (p.rows.some(r => /kit/i.test(r.title))) break; }
  check(p.rows.some(r => /kit/i.test(r.title)), `@ lists kit (${p.rows.map(r => r.title).join(" | ")})`);
  await still("paired-at.png");

  // A question: not "no assistant on this Vyre".
  await send({ text: "what is on my plate today" }); await pause(1500);
  p = await send({ probe: true });
  const text = JSON.stringify(p.rows);
  check(!/no assistant on this Vyre/i.test(text), "a question does not say there is no assistant");
  check(p.rows.some(r => r.kind === "ask" && /kit/i.test(r.title)), `a question offers Ask kit (${p.rows.map(r => r.title).join(" | ")})`);
  await still("paired-ask.png");

  // The Mac's own things stay here.
  await send({ text: "" });
  await send({ text: "safari" }); await pause(900);
  p = await send({ probe: true });
  check(p.rows.length > 0, "an app search still answers on this Mac");

  // The server goes away: the words say so.
  await send({ text: "" }); await send({ hide: true });
  await world.stopTailnet();
  let away = false;
  for (let i = 0; i < 30 && !away; i++) {
    await pause(1000);
    await send({ show: true }); await pause(800);
    await send({ text: "what is on my plate today" }); await pause(800);
    p = await send({ probe: true });
    away = /Your server is not reachable/.test(JSON.stringify(p.rows) + JSON.stringify(p.line || ""));
    if (!away) await send({ hide: true });
  }
  check(away, "with the server away, Lumen says it is not reachable");
  check(!/no assistant on this Vyre/i.test(JSON.stringify(p.rows)), "and does not say there is no assistant");
  await still("paired-away.png");
} catch (e) {
  failures.push(String(e && e.message || e)); console.log(`FAIL ${e && e.message || e}`);
} finally {
  try { child?.kill("SIGTERM"); } catch {}
  for (const fn of cleanups.reverse()) { try { await fn(); } catch {} }
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failures.length ? 1 : 0);
