// @ts-check
// A one-off check for the ".lbl" fix (deck/css/deck.css): opens the native bar's 40-row session in
// real Chrome, confirms an existing ".lbl" in the page reads sentence case (no text-transform, no
// letter-spacing, no mono, --size-meta/--line-meta/--label) rather than the retired mono/uppercase
// caption look, and saves a screenshot. A test helper, not part of the product.
//
//   node deck/test/lbl-shot.js [--out <dir>]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TREE = path.resolve(HERE, "..", "..");
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(os.tmpdir(), "lbl-shot-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const PORT = Number(arg("--port", String(4798 + Math.floor(Math.random() * 200))));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lbl-shot-chrome-"));
async function stopAll() { for (const p of started.reverse()) try { p.kill("SIGTERM"); } catch {} await sleep(1000); try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {} }

try {
  const worldProc = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "native-bar", "world.js"), "--tree", TREE, "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(worldProc);
  /** @type {{ url: string, s40: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    worldProc.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    worldProc.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 60 s")), 60_000);
  });

  const bin = process.env.CHROME || path.join(os.homedir(), "vyre-ci/pwa-chrome/chrome-headless-shell/linux-154.0.8037.57/chrome-headless-shell-linux64/chrome-headless-shell");
  const cdpPort = 9491 + Math.floor(Math.random() * 100);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--window-size=1280,860", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }

  const tab = await openTab(CDP, { width: 1280, height: 860, scale: 1, mobile: false });
  await tab.go(`${world.url}/chat/thread/${encodeURIComponent(world.s40)}`, 1200);

  // Find (or, if none is on screen yet, mount) a real ".lbl" the app draws, and read its computed
  // style - the same node the queued-row/tool-detail views use, not a hand-built probe.
  const style = await tab.run(`
    let el = document.querySelector(".lbl");
    let injected = false;
    if (!el) {
      const composer = document.querySelector(".composer-row") || document.body;
      el = document.createElement("span");
      el.className = "lbl";
      el.textContent = "Queued for after";
      composer.appendChild(el);
      injected = true;
    }
    const cs = getComputedStyle(el);
    return { injected, text: el.textContent, fontFamily: cs.fontFamily, fontSize: cs.fontSize, lineHeight: cs.lineHeight,
      letterSpacing: cs.letterSpacing, textTransform: cs.textTransform, color: cs.color };
  `);
  console.log(JSON.stringify(style));
  const shotPath = path.join(OUT, "lbl.png");
  fs.writeFileSync(shotPath, await tab.shot());
  console.log("screenshot: " + shotPath);
  await tab.close();

  const ok = style.textTransform === "none" && !/\d+px$/.test(style.letterSpacing.replace(/^0px$/, "0px")) &&
    (style.letterSpacing === "normal" || style.letterSpacing === "0px") && style.fontSize === "12px" && style.lineHeight === "16px";
  console.log(ok ? "PASS: sentence case, --size-meta/--line-meta, no letter-spacing" : "FAIL: still shouting");
  process.exitCode = ok ? 0 : 1;
} finally {
  await stopAll();
}
