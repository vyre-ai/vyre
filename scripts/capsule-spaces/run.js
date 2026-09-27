#!/usr/bin/env node
// @ts-check
// Does the Capsule open on the Space of a full-screen app, or switch to the desktop?
//
//   VYRE_FULLSCREEN_OK=1 [ELECTRON_BIN=...] <team-dir>/buildlock.sh <team> node scripts/capsule-spaces/run.js [default stay stay-then-steal]
//
// It opens a throwaway window of its own and puts it in full screen, which takes over the display
// and moves to its Space. So it runs only when someone says the Mac is free (VYRE_FULLSCREEN_OK=1),
// never in a test suite. For each variant a Capsule-like panel is shown with lib/present.js; the
// check reads, with no permission needed (CGWindowList and NSWorkspace, through osascript), whether
// the full-screen window is still on screen (no Space switch), which app is in front, and whether
// the panel is key. It posts no keys: typing is checked by hand.
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import os from "node:os";
import fs from "node:fs";

if (process.env.VYRE_FULLSCREEN_OK !== "1") {
  console.error("This opens a full-screen window and switches Spaces. Run it only when the Mac is free, with VYRE_FULLSCREEN_OK=1.");
  process.exit(2);
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, "..", "..", "local", "capsule", "package.json"));
// ELECTRON_BIN for a worktree without local/capsule/node_modules (point it at another checkout's).
const ELECTRON = process.env.ELECTRON_BIN || /** @type {string} */ (/** @type {unknown} */ (require("electron")));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "vyre-spaces-"));
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ["default", "stay", "stay-then-steal"];

function run(mode, variant = "") {
  const p = spawn(ELECTRON, [HERE, `--user-data-dir=${path.join(data, mode + variant)}`], { env: { ...process.env, SPACES_MODE: mode, SPACES_VARIANT: variant }, stdio: ["pipe", "pipe", "ignore"] });
  /** @type {{ f: (m: any) => boolean, r: (m: any) => void }[]} */
  const waiters = [];
  readline.createInterface({ input: /** @type {any} */ (p.stdout) }).on("line", l => {
    let m; try { m = JSON.parse(l); } catch { return; }
    for (const w of [...waiters]) if (w.f(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); }
  });
  const wait = (/** @type {(m: any) => boolean} */ f) => new Promise((r, j) => { waiters.push({ f, r }); setTimeout(() => j(new Error(`${mode} ${variant}: no answer`)), 15_000); });
  return { p, wait };
}
const onscreen = () => JSON.parse(execFileSync("osascript", ["-l", "JavaScript", path.join(HERE, "onscreen.js")]).toString());
const pause = ms => new Promise(r => setTimeout(r, ms));

const fsw = run("fs");
try {
  const f = await fsw.wait(m => m.fs);
  for (const v of variants) {
    const panel = run("panel", v);
    const r = await panel.wait(m => m.ready);
    await pause(500);
    panel.p.stdin?.write("show\n");
    const s = await panel.wait(m => m.shown);
    const o = onscreen();
    const on = new Set(o.windows.map(w => w.pid));
    const stayed = on.has(f.pid) && on.has(r.pid);
    console.log(JSON.stringify({ variant: v, stayedOnFullScreenSpace: stayed, panelKey: s.focused, frontApp: o.front.pid === r.pid ? "panel" : o.front.pid === f.pid ? "full-screen window" : o.front.name }));
    panel.p.stdin?.write("quit\n");
    await pause(1500);
    panel.p.kill();
  }
} finally {
  fsw.p.kill();
  fs.rmSync(data, { recursive: true, force: true });
}
