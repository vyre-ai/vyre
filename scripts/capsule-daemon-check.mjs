#!/usr/bin/env node
// @ts-check
// capsule-daemon-check: Lumen against a REAL vyred (CI, macOS only). Starts vyred in a throwaway home with
// a fake tailscale, starts the built app pointed at it, and checks that what the server now offers lights up:
// the four tools (mentions.search, capsule.commands, capsule.view, capsule.act), the module commands Lumen
// read, and the "#" list asking the server and getting an answer. No real device, no network, no dialog.
//
//   node scripts/capsule-daemon-check.mjs [path/to/Vyre.app]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, execFileSync } from "node:child_process";

// It starts a real daemon and the real built app: only on a CI runner (or with VYRE_ALLOW_LOCAL_RUN=1 in a throwaway
// account), never by accident on a person's own Mac.
if (process.env.CI !== "true" && process.env.VYRE_ALLOW_LOCAL_RUN !== "1") { console.error("capsule-daemon-check runs on CI only (set VYRE_ALLOW_LOCAL_RUN=1 to run it in a throwaway account)"); process.exit(2); }
const app = path.resolve(process.argv[2] || "local/capsule/native/.build/Vyre.app");
const bin = path.join(app, "Contents", "MacOS", "Vyre");
if (!fs.existsSync(bin)) { console.error(`no app at ${app}`); process.exit(1); }
const home = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-daemon-check-"));
const failures = [];
const check = (ok, what) => { if (!ok) failures.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("FAIL the check did not finish in 3 minutes"); cleanup(); process.exit(1); }, 180_000);
watchdog.unref();

const env = { ...process.env, VYRE_HOME: home, VYRE_NO_DIALOGS: "1", VYRE_TAILSCALE_BIN: path.resolve("deck/test/fake-tailscale.js") };
const vyred = spawn(process.execPath, ["core/daemon/main.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
let vlog = ""; vyred.stdout.on("data", d => { vlog += d; }); vyred.stderr.on("data", d => { vlog += d; });
let child;
function cleanup() { try { child?.kill("SIGTERM"); } catch {} try { vyred.kill("SIGTERM"); } catch {} try { fs.rmSync(home, { recursive: true, force: true }); } catch {} }

try {
  const sock = path.join(home, "vyred.sock");
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { up = fs.existsSync(sock); if (!up) await pause(250); }
  check(up, "vyred is listening");
  if (!up) { console.log(vlog.slice(-1500)); throw new Error("vyred did not start"); }
  await pause(1500);

  child = spawn(bin, [], { env: { ...env, VYRE_SOCKET: sock, VYRE_CAPSULE_DRIVE: "1", VYRE_CAPSULE_TEST: "1" }, stdio: ["pipe", "pipe", "inherit"] });
  /** @type {((m: any) => void)[]} */
  const waiting = [];
  readline.createInterface({ input: /** @type {any} */ (child.stdout) }).on("line", l => { let m; try { m = JSON.parse(l); } catch { return; } const w = waiting.shift(); if (w) w(m); });
  const send = c => new Promise((r, j) => { waiting.push(r); child.stdin?.write(JSON.stringify(c) + "\n"); setTimeout(() => j(new Error(`no answer to ${JSON.stringify(c)}`)), 15_000); });
  await new Promise((r, j) => { waiting.push(r); setTimeout(() => j(new Error("the app did not say ready")), 20_000); });

  await send({ show: true });
  let v;
  for (let i = 0; i < 20; i++) { await pause(500); v = await send({ views: true }); if (v.up && Object.values(v.tools).every(Boolean) && v.commands.length) break; }
  console.log(`the server: up ${v.up}, tools ${JSON.stringify(v.tools)}, ${v.commands.length} module commands: ${v.commands.slice(0, 8).join(", ")}`);
  check(v.up === true, "Lumen sees the real vyred up");
  for (const t of ["mentions.search", "capsule.commands", "capsule.view", "capsule.act"]) check(v.tools[t] === true, `the server offers ${t}`);
  check(v.commands.length > 0, `Lumen read module commands (${v.commands.length})`);

  // "#": Lumen asks mentions.search and draws the answer (rows, or its own line when nothing is there yet).
  await send({ text: "#" });
  let p;
  for (let i = 0; i < 10; i++) { await pause(400); p = await send({ probe: true }); if (p.rows.some(r => r.kind === "tag") || p.line) break; }
  const tagRows = p.rows.filter(r => r.kind === "tag");
  console.log(`"#": ${tagRows.length} tag rows (${tagRows.slice(0, 4).map(r => r.title).join(", ")}), line: ${JSON.stringify(p.line)}`);
  check(tagRows.length > 0 || /Nothing to tag|to tag/.test(String(p.line || "")), "# reached the server's mentions.search and got an answer (rows or 'nothing to tag')");
  check(!/not a tool|no such tool|refused|denied/i.test(String(p.line || "")), "the answer is not a refusal");
  // The icons: every # row draws a real symbol. The connector rows came back as "plug", which is not one, and drew empty dark tiles.
  const badIcons = tagRows.filter(r => r.symbolOK === false).map(r => `${r.title} (${r.symbol})`);
  check(badIcons.length === 0, `every # row has an icon that draws${badIcons.length ? `: ${badIcons.join(", ")}` : ""}`);
  const connectors = tagRows.filter(r => /^Connectors?$/i.test(String(r.sub)));
  console.log(`"#" connector rows: ${connectors.length} (${connectors.slice(0, 3).map(r => `${r.title}: ${r.symbol}`).join(", ")})`);
  check(connectors.length === 0 || connectors.every(r => r.symbol === "powerplug"), "connector rows use the plug symbol");
  if (process.env.VYRE_CAPSULE_SCREENS) {
    try {
      fs.mkdirSync(process.env.VYRE_CAPSULE_SCREENS, { recursive: true });
      const w = await send({ windowid: true });
      const f = path.join(process.env.VYRE_CAPSULE_SCREENS, "hash-picker.png");
      execFileSync("/usr/sbin/screencapture", ["-x", "-o", "-l", String(w.windowid), f], { timeout: 20_000 });
      console.log(`# picker still: ${fs.statSync(f).size} bytes`);
    } catch (e) { console.log(`# picker still failed: ${String(e && e.message || e).split("\n")[0]}`); }
  }

  // A module command is matched by name.
  if (v.commands.length) {
    const first = v.commands[0].split("/")[1].replace(/[-_.]/g, " ");
    await send({ text: first }); await pause(600);
    p = await send({ probe: true });
    console.log(`"${first}": rows ${JSON.stringify(p.rows.slice(0, 4).map(r => `${r.kind}:${r.title}`))}`);
  }
  console.log(`next meeting line: ${v.nextMeeting === null ? "none (no calendar command on this server yet)" : JSON.stringify(v.nextMeeting)}`);
} catch (e) {
  failures.push(String(e && e.message || e)); console.log(`FAIL ${e && e.message || e}`);
} finally {
  cleanup();
}
process.exit(failures.length ? 1 : 0);
