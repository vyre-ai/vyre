// @ts-check
// The scan test for every avatar's Wink ring (design-system.md step 6, ux-research.md section 10 item 2): draw each family's ring at 120 px in
// real headless Chrome, screenshot it at a phone camera's pixel density, and read it back with the same decoder the phone uses
// (deck/vyrecode/decode-core2.js, then Reed-Solomon and the CRC in payload.js). The bytes read must be the bytes the ring was drawn from.
//
//   node deck/test/wink-scan-browser.js [--out <dir>]
//   CDP=http://127.0.0.1:9422 node deck/test/wink-scan-browser.js     (use a Chrome that is already running)
//
// Hard checks: every family, Dark and Paper, at 5x and 3x density (a 600 and a 360 pixel capture of the 120 px avatar) decodes. 2x and 1x are
// printed for information. Synthetic seeds only (alex, juno, northwind). Starts only the one headless Chrome it launches, with a temp profile,
// and stops it by pid. A test helper, not part of the product.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openTab } from "./cdp.js";
import { avatarSource, ringBytes } from "../js/avatars.js";
import { bitsToBytes, recoverId } from "../../lib/wink-code/payload.js";
import { levelsToBits } from "../vendor/vyrecode/vyrecode2.js";
import { decodeCore2 } from "../../lib/wink-code/decode-core2.js";
import * as geo from "../../lib/wink-code/geometry.js";
import { CHROME_SAFE } from "../../lib/chrome-flags/index.js";

const args = process.argv.slice(2);
const arg = (/** @type {string} */ n, /** @type {string} */ d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = arg("--out", "");
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

const FP = [0x3a, 0x91, 0x0c, 0xe4, 0x57, 0x28, 0xbd, 0x6f]; // a made-up fingerprint8
/** family, seed and options as the Deck draws them (synthetic names). @type {[string, string, any][]} */
const CASES = [
  ["person", "alex", { fp: FP }],
  ["assistant", "juno", { fp: [0x11, 0xd2, 0x7a, 0x05, 0xc9, 0x40, 0xee, 0x83] }],
  ["agent", "juno", {}],
  ["agent", "kit", {}],
  ["teammate", "reviewer-northwind", { color: "#2F93DA" }],
  ["project", "northwind", {}],
  ["project", "harlow-legal", {}],
];
const GEO = { CENTER: geo.CENTER, FACE_R: geo.FACE_R, RING_R: geo.RING_R, TINT_MARGIN: 40, LEVELS: [0, 1, 2, 3].map(geo.tickLength), CAP_RADIUS: geo.TICK_CAP_RADIUS };
const DECODE = `const decodeCore2 = ${decodeCore2.toString()};`;

/** @type {import("node:child_process").ChildProcess | null} */ let chrome = null;
let profile = "";
let cdp = process.env.CDP || "";
if (!cdp) {
  const bin = process.env.CHROME || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome");
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "wink-scan-"));
  const port = 9440 + Math.floor(Math.random() * 50);
  chrome = spawn(bin, [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, `--user-data-dir=${profile}`, "--headless=new", "--no-first-run", "--disable-gpu", ...(process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
  cdp = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { await fetch(`${cdp}/json/version`); break; } catch { await sleep(200); } }
}

let hardFails = 0;
try {
  for (const scale of [5, 3, 2, 1]) {
    const tab = await openTab(cdp, { width: 120, height: 120, scale, mobile: false });
    for (const theme of /** @type {const} */ (["dark", "paper"])) for (const [family, seed, o] of CASES) {
      const want = ringBytes(/** @type {any} */ (family), seed, o);
      const svg = avatarSource(/** @type {any} */ (family), seed, 120, { ...o, ring: true, theme });
      await tab.run(`document.body.style.cssText = "margin:0;background:#333;overflow:hidden"; document.body.innerHTML = ${JSON.stringify(svg)};`);
      await sleep(60);
      const png = await tab.shot();
      if (OUT) fs.writeFileSync(path.join(OUT, `${family}-${seed}-${theme}-${scale}x.png`), png);
      const got = await tab.run(`${DECODE}
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64,${png.toString("base64")}"; });
        const c = document.createElement("canvas"); c.width = 600; c.height = 600;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 600, 600);
        const d = ctx.getImageData(0, 0, 600, 600).data;
        const lum = (x, y) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= 600 || y >= 600) return null; const i = (y * 600 + x) * 4; return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; };
        const top = decodeCore2(${JSON.stringify(GEO)}).searchWithPerspective(lum, 300, 300, {});
        return top.map(t => t.levels);`);
      let ok = false;
      for (const levels of got || []) {
        const r = recoverId(bitsToBytes(levelsToBits(levels)));
        if (r && JSON.stringify(r.id8) === JSON.stringify(want)) { ok = true; break; }
      }
      const hard = scale >= 3;
      if (!ok && hard) hardFails++;
      console.log(JSON.stringify({ family, seed, theme, density: `${scale}x`, px: 120 * scale, decoded: ok, hard }));
    }
    await tab.close();
  }
} finally {
  if (chrome?.pid) { try { chrome.kill("SIGTERM"); } catch { /* already gone */ } }
  if (profile) { await sleep(300); try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } }
}
console.log(hardFails ? `FAILED: ${hardFails} hard scan checks` : "ok: every family's ring at 120 px reads at 5x and 3x");
process.exit(hardFails ? 1 : 0);
