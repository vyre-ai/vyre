// @ts-check
// A real-Chrome check of Glass's live view, on testbox only:
//
//   node deck/test/glass-browser.js [--port 4757] [--out <dir>]
//
// Starts deck/test/glass-world.js's world (a real vyred, computers on the fake driver, a fake
// Xvnc TCP server) and drives the real Deck page in headless Chrome, the way settings-browser.js
// checks Settings. Covers what glass-plan.md asked a harness for: mounting the screen, fit, the
// take-over class, a reconnect that keeps the last frame instead of a black flash, the fullscreen
// button's wiring, and the Deck/phone layouts at their real sizes. One JSON line per check, plus
// a screenshot of each; a test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openTab } from "./cdp.js";
import { SCRATCH } from "../../test/scratch.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PORT = Number(arg("--port", "4757"));
const OUT = path.resolve(arg("--out", fs.mkdtempSync(path.join(SCRATCH, "glass-shots-"))));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** @type {import("node:child_process").ChildProcess[]} */ const started = [];
const scratch = fs.mkdtempSync(path.join(SCRATCH, "glass-chrome-"));
let failed = 0;
const say = (/** @type {string} */ check, /** @type {boolean} */ pass, detail = "") => { if (!pass) failed++; process.stdout.write(JSON.stringify({ check, pass, ...(detail ? { detail } : {}) }) + "\n"); };
async function stopAll() {
  for (const p of started.reverse()) { try { p.kill("SIGTERM"); } catch {} }
  await sleep(1500);
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
}

/** One tab at a given size, past Glass's screen tab loading. @param {string} cdp @param {string} base @param {string} agent @param {{width:number,height:number,mobile:boolean}} dev */
async function openGlass(cdp, base, agent, dev) {
  const tab = await openTab(cdp, { ...dev, scale: dev.mobile ? 3 : 1 });
  await tab.go(`${base}/agents/${encodeURIComponent(agent)}/glass`, 800);
  await tab.run(`await waitFor(".gl-stage", 15000); return true;`);
  return tab;
}
const shot = async (/** @type {any} */ tab, /** @type {string} */ name) => {
  const r = await tab.send("Page.captureScreenshot", { format: "png" });
  if (r.result?.data) fs.writeFileSync(path.join(OUT, name + ".png"), Buffer.from(r.result.data, "base64"));
};

try {
  const w = spawn("nice", ["-n", "15", process.execPath, path.join(HERE, "glass-world.js"), "--port", String(PORT)], { stdio: ["ignore", "pipe", "inherit"] });
  started.push(w);
  /** @type {{ url: string, agent: string }} */
  const world = await new Promise((resolve, reject) => {
    let buf = "";
    w.stdout?.on("data", d => { buf += d; const l = buf.split("\n").find(x => x.startsWith("{")); if (l) resolve(JSON.parse(l)); });
    w.once("exit", c => reject(new Error(`world exited ${c}`)));
    setTimeout(() => reject(new Error("world did not come up in 60 s")), 60_000);
  });
  const bin = process.env.CHROME || "/usr/local/bin/vyre-chrome";
  const cdpPort = 9432 + Math.floor(Math.random() * 400);
  const chrome = spawn("nice", ["-n", "15", bin, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", `--user-data-dir=${scratch}`,
    "--headless=new", "--no-sandbox", "--no-first-run", "about:blank"], { stdio: "ignore" });
  started.push(chrome);
  const CDP = `http://127.0.0.1:${cdpPort}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }
  const kick = (/** @type {string} */ p) => fetch(`${world.url}${p}`);

  // 0. sight.frame's data path: the fake hands-desktop the world seeds gives a real, decodable
  // JPEG. watch.js's stillFrame() consumes exactly this shape for the reconnect/cold-start still;
  // the local fake Xvnc connects too fast over loopback to reliably catch that still on screen
  // mid-race in this harness, so this checks the data it would draw, not the paint itself.
  const frame = await (await fetch(`${world.url}/v1/tools/sight.frame`, { method: "POST",
    headers: { "content-type": "application/json", "x-vyre-caller": "deck" }, body: JSON.stringify({ target: `agent:${world.agent}` }) })).json();
  say("sight.frame: a real image glass's stillFrame() could draw", frame?.data?.mime === "image/jpeg" && typeof frame?.data?.image === "string" && frame.data.image.length > 100, JSON.stringify(frame).slice(0, 200));

  // 1. Mount and connect: the RFB handshake completes against the fake Xvnc, no real container.
  const tab = await openGlass(CDP, world.url, world.agent, { width: 1440, height: 900, mobile: false });
  await tab.run(`await waitFor(".gl-badge-live", 10000); return true;`);
  const canvas1 = await tab.run(`const c = document.querySelector(".gl-screen canvas"); return c ? [c.width, c.height] : null;`);
  say("mounts and connects: a live badge and a canvas sized to the screen", Array.isArray(canvas1) && canvas1[0] > 0 && canvas1[1] > 0, JSON.stringify(canvas1));
  await shot(tab, "watch-live");

  // 2. Fit: scaleViewport keeps the whole remote desktop in view, ratio set from the real size.
  const ratio = await tab.run(`return document.querySelector(".gl-stage").style.getPropertyValue("--ratio");`);
  say("fit: the stage's aspect ratio matches the screen glass.open reported", /1024\s*\/\s*768/.test(String(ratio)), String(ratio));

  // 2b. 1:1 toggle (Deck only): flips the screen to scrollable native size and back.
  const toggled = await tab.run(`const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "1:1");
    if (!b) return "no button"; b.click(); await wait(200);
    const on = document.querySelector(".gl-screen").classList.contains("gl-1to1"), label = b.textContent.trim();
    b.click(); await wait(200);
    const off = document.querySelector(".gl-screen").classList.contains("gl-1to1");
    return { on, label, off };`);
  say("1:1 toggle: turns gl-1to1 on and off, and the label flips to Fit", toggled?.on === true && toggled?.label === "Fit" && toggled?.off === false, JSON.stringify(toggled));

  // 3. Take over: the CTA is enabled with no proof needed (PERSON_ONLY, no passkey), and the
  // stage marks itself held.
  const took = await tab.run(`const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("Take over"));
    if (!b || b.disabled) return "no button"; b.click(); await wait(1000); return document.querySelector(".gl-stage").className;`);
  say("take-over: the stage gets gl-held with no passkey prompt", /gl-held/.test(String(took)), String(took));
  await shot(tab, "watch-takeover");
  await tab.run(`const b = document.querySelector('[aria-keyshortcuts="Control+Enter"]'); b?.click(); await wait(800); return true;`);

  // 4. Fullscreen: today the button only exists on the phone layout (checked in step 6, where
  // the phone tab opens) — Deck has none yet. That gap is glass-plan.md's native-full-screen
  // item (now top-2); this harness is what will prove it once it's built, not before.

  // 5. Reconnect without a black flash: crash the backend after a real frame painted; the client
  // should keep showing that frame (the gl-snap canvas), never a blank one.
  await kick("/__xvnc/frame");
  await sleep(500);
  await kick("/__xvnc/crash");
  await tab.run(`await waitFor(".gl-badge:not(.gl-badge-live)", 8000); return true;`);
  const snap = await tab.run(`const s = document.querySelector(".gl-snap"); return s ? { hidden: s.hidden, w: s.width, h: s.height } : null;`);
  say("reconnect: the last frame stays up (gl-snap) instead of a black canvas", !!snap && snap.hidden === false && snap.w > 0 && snap.h > 0, JSON.stringify(snap));
  await shot(tab, "watch-reconnect");
  await tab.close();

  // 6. Resize: the same route lays out as PhoneGlass under 600 px / touch, GlassWatch above it.
  const phoneTab = await openGlass(CDP, world.url, world.agent, { width: 390, height: 844, mobile: true });
  const phoneLayout = await phoneTab.run(`return { phone: !!document.querySelector(".gl-phone"), stagewrap: !!document.querySelector(".gl-stagewrap") };`);
  say("resize (phone, 390 wide): lays out as PhoneGlass, not the desktop shell", phoneLayout.phone && !phoneLayout.stagewrap, JSON.stringify(phoneLayout));
  await shot(phoneTab, "watch-phone");

  // Fullscreen (phone): the button calls the real Fullscreen API on the stage element (stubbed,
  // since headless Chrome's own fullscreen state is not what this checks).
  await phoneTab.run(`window.__fs = 0; HTMLElement.prototype.requestFullscreen = function () { if (this.classList.contains("gl-stage")) window.__fs++; return Promise.resolve(); };`);
  const fsCalls = await phoneTab.run(`await waitFor('[aria-label="Full screen"]', 5000); document.querySelector('[aria-label="Full screen"]').click(); await wait(200); return window.__fs;`);
  say("fullscreen (phone): the button asks the stage element, not some other node", fsCalls === 1, `called ${fsCalls} times`);
  const deckTab = await openGlass(CDP, world.url, world.agent, { width: 1440, height: 900, mobile: false });
  const deckLayout2 = await deckTab.run(`return { phone: !!document.querySelector(".gl-phone"), stagewrap: !!document.querySelector(".gl-stagewrap") };`);
  say("resize (deck, 1440 wide): lays out as GlassWatch, not the phone shell", !deckLayout2.phone && deckLayout2.stagewrap, JSON.stringify(deckLayout2));
  await phoneTab.close(); await deckTab.close();

  say("no page errors", tab.errors.length === 0, tab.errors.slice(0, 3).join(" | "));
  process.stdout.write(JSON.stringify({ shots: OUT }) + "\n");
} catch (e) {
  say("ran", false, String(/** @type {Error} */ (e).stack || e));
} finally {
  await stopAll();
  process.exit(failed ? 1 : 0);
}
