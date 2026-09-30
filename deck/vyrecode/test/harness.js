// @ts-check
// The "prove it's readable" harness for the FINAL Vyre code layout (2 rings x 36 marks x 2 bits,
// ticksSunburst), same technique as round5's own prototype harness (render -> degrade with real
// CSS in real headless Chrome -> screenshot -> reload into a fresh canvas -> decode-core2's real
// getImageData search -> RS/CRC-validate in Node) and the SAME 17-scenario matrix, for a
// like-for-like pass-rate comparison against round5's 14/17 on the old (4-ring, 1-bit) layout.
// Renders with the real, vendored renderer (deck/vendor/vyrecode/vyrecode2.js) and geometry
// (geometry.js) - the same code and constants app-design's own renderer and pwa's live decoder
// use, not a stand-in.
//
// Manual/robustness run, not part of `npm test` (needs a local Chrome and ~35s, real pixels):
//   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node deck/vyrecode/test/harness.js [out dir]

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import http from "node:http";
import crypto from "node:crypto";
import * as payload from "../payload.js";
import { renderCode2, bitsToLevels, levelsToBits } from "../../vendor/vyrecode/vyrecode2.js";
import * as geo from "../../vendor/vyrecode/geometry.js";

/** A stand-in for a real public-key fingerprint (test-only: payload.js itself must stay
 * browser-safe, since deck/js/scan.js imports it for the real on-phone decode). */
function fingerprint8(publicSeed) {
  return [...crypto.createHash("sha256").update(publicSeed).digest()].slice(0, 8);
}
import { decodeCore2 } from "../decode-core2.js";
import { CHROME_SAFE } from "../../../lib/chrome-flags/index.js";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));

async function main() {
const OUT = path.resolve(process.argv[2] || path.join(HERE, "harness-out"));
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = 8935;
const server = http.createServer((req, res) => {
  const file = path.join(OUT, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ct = file.endsWith(".png") ? "image/png" : "text/html";
    res.writeHead(200, { "content-type": ct });
    res.end(data);
  });
});
await new Promise(r => server.listen(PORT, "127.0.0.1", r));
const base = `http://127.0.0.1:${PORT}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vyrecode2-chrome-"));
const cdpPort = 9556;
const chrome = spawn(CHROME, [`--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1", ...CHROME_SAFE, `--user-data-dir=${profile}`,
  "--headless=new", "--no-first-run", "--window-size=1200,1200", "about:blank"], { stdio: "ignore" });
const CDP = `http://127.0.0.1:${cdpPort}`;
for (let i = 0; i < 100; i++) { try { await fetch(`${CDP}/json/version`); break; } catch { await sleep(200); } }

async function tab() {
  const t = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pending = new Map();
  ws.onmessage = m => { const d = JSON.parse(String(m.data)); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
  const run = async js => { const r = await send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async () => { ${js} })()` });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text); return r.result.result.value; };
  const go = async url => {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 600, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url });
    await sleep(200);
  };
  const screenshotToFile = async file => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
  };
  return { send, run, go, screenshotToFile, close: () => send("Target.closeTarget", { targetId: t.id }) };
}

function degradedPageHtml(svg, deg) {
  const { blur = 0, rotate = 0, scale = 1, perspectiveDeg = 0, noise = 0 } = deg;
  const transform = `perspective(900px) rotateX(${perspectiveDeg}deg) rotate(${rotate}deg) scale(${scale})`;
  return `<!doctype html><html><body style="margin:0;width:600px;height:600px;background:#333;overflow:hidden;">
    <div id="code" style="width:600px;height:600px;filter:blur(${blur}px);transform:${transform};transform-origin:center;">${svg}</div>
    <canvas id="noise" width="600" height="600" style="position:absolute;top:0;left:0;pointer-events:none;"></canvas>
    <script>
      const c = document.getElementById('noise').getContext('2d');
      const density = ${noise};
      if (density > 0) {
        const img = c.createImageData(600, 600);
        for (let i = 0; i < img.data.length; i += 4) {
          if (Math.random() < density) {
            const v = Math.random() < 0.5 ? 0 : 255;
            img.data[i] = v; img.data[i+1] = v; img.data[i+2] = v; img.data[i+3] = 160;
          }
        }
        c.putImageData(img, 0, 0);
      }
    </script>
  </body></html>`;
}

// decodeCore2's own source is self-contained (no free variables), but its geometry argument
// isn't: a toString()'d function loses whatever it imported at module scope when re-evaluated in
// this injected, non-module page. Built once here, from the SAME vendored geometry.js the real
// decoder imports, as plain data (numbers only - JSON-safe, no live functions) and passed to
// decodeCore2(GEO) explicitly in the injected script, rather than letting it fall back to its own
// defaultGeometry() (which needs a live import this page doesn't have).
const GEO = { CENTER: geo.CENTER, FACE_R: geo.FACE_R, RING_R: geo.RING_R, TINT_MARGIN: 40, LEVELS: [0, 1, 2, 3].map(geo.tickLength), CAP_RADIUS: geo.TICK_CAP_RADIUS };

function readerPageHtml(pngUrl, decodeSrc) {
  return `<!doctype html><html><body style="margin:0;">
    <canvas id="c" width="600" height="600"></canvas>
    <script>${decodeSrc}</script>
    <script>
      window.__ready = new Promise((resolve) => {
        window.onerror = (msg) => { resolve({ error: String(msg) }); return true; };
        const img = new Image();
        img.onload = () => {
          try {
            const ctx = document.getElementById('c').getContext('2d');
            ctx.drawImage(img, 0, 0, 600, 600);
            const data = ctx.getImageData(0, 0, 600, 600);
            const getLum = (x, y) => {
              x = Math.round(x); y = Math.round(y);
              if (x < 0 || y < 0 || x >= 600 || y >= 600) return null;
              const i = (y * 600 + x) * 4;
              return 0.2126*data.data[i] + 0.7152*data.data[i+1] + 0.0722*data.data[i+2];
            };
            const { searchWithPerspective } = decodeCore2(${JSON.stringify(GEO)});
            const top = searchWithPerspective(getLum, 300, 300, {});
            resolve({ candidates: top.map(c => ({ rot: c.rot, scale: c.scale, confidence: c.confidence, levels: c.levels, correction: c.correction })) });
          } catch (e) { resolve({ error: e.message + " " + e.stack }); }
        };
        img.onerror = () => resolve({ error: "image failed to load" });
        img.src = "${pngUrl}";
      });
    </script>
  </body></html>`;
}

const decodeSrc = `const decodeCore2 = ${decodeCore2.toString()};`;

async function runScenario(name, id, bits, levels, deg) {
  // The real renderer + real identity face, not a plain test disc: exercises exactly what a
  // phone camera will actually see, including the face art inside the ring.
  const svg = renderCode2(levels, { userOption: 1, style: "ticksSunburst", theme: "dark", size: 600 });
  const pagePath = path.join(OUT, `${name}-degrade.html`);
  fs.writeFileSync(pagePath, degradedPageHtml(svg, deg));
  const t1 = await tab();
  await t1.go(`${base}/${name}-degrade.html`);
  await sleep(250);
  const pngPath = path.join(OUT, `${name}.png`);
  await t1.screenshotToFile(pngPath);
  await t1.close();

  const readerPath = path.join(OUT, `${name}-reader.html`);
  fs.writeFileSync(readerPath, readerPageHtml(`${base}/${name}.png`, decodeSrc));
  const t2 = await tab();
  await t2.go(`${base}/${name}-reader.html`);
  const readerResult = await t2.run(`return await window.__ready;`);
  await t2.close();
  if (readerResult.error) { const r = { name, deg, pass: false, error: readerResult.error }; console.log(JSON.stringify(r)); return r; }
  const candidates = readerResult.candidates;

  let recovered = null, usedCandidate = -1, usedCorrection = null;
  for (let i = 0; i < candidates.length; i++) {
    const candBits = levelsToBits(candidates[i].levels);
    const bytes = payload.bitsToBytes(candBits);
    const r = payload.recoverId(bytes);
    if (r && JSON.stringify(r.id8) === JSON.stringify(id)) { recovered = r; usedCandidate = i; usedCorrection = candidates[i].correction; break; }
  }
  const result = { name, deg, pass: !!recovered, candidateRank: usedCandidate, correction: usedCorrection, errorsCorrected: recovered?.errorsCorrected ?? null, triedCandidates: candidates.length };
  console.log(JSON.stringify(result));
  return result;
}

const id = fingerprint8("alex@harlowlegal.test:ed25519:demo");
const cw = payload.buildCodeword(id);
const bits = payload.bytesToBits(cw);
const levels = bitsToLevels(bits);

const scenarios = process.env.QUICK ? [["pristine", {}], ["blur-2", { blur: 2 }]] : [
  ["pristine", {}],
  ["blur-2", { blur: 2 }],
  ["blur-4", { blur: 4 }],
  ["blur-6", { blur: 6 }],
  ["rotate-15", { rotate: 15 }],
  ["rotate-37", { rotate: 37 }],
  ["rotate-90", { rotate: 90 }],
  ["rotate-181", { rotate: 181 }],
  ["scale-80", { scale: 0.8 }],
  ["scale-120", { scale: 1.2 }],
  ["noise-light", { noise: 0.01 }],
  ["noise-heavy", { noise: 0.03 }],
  ["perspective-15", { perspectiveDeg: 15 }],
  ["perspective-30", { perspectiveDeg: 30 }],
  ["combo-blur2-rot15-scale90", { blur: 2, rotate: 15, scale: 0.9 }],
  ["combo-blur3-rot50-scale110-noise", { blur: 3, rotate: 50, scale: 1.1, noise: 0.01 }],
  ["combo-worst", { blur: 4, rotate: 163, scale: 0.85, noise: 0.02, perspectiveDeg: 12 }],
];

const results = [];
for (const [name, deg] of scenarios) results.push(await runScenario(name, id, bits, levels, deg));

const passCount = results.filter(r => r.pass).length;
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ id: Buffer.from(id).toString("hex"), passCount, total: results.length, results }, null, 2));
console.log(`\nPASS RATE: ${passCount}/${results.length}`);

chrome.kill("SIGTERM");
  server.close();
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
main().catch(e => { console.error(e); process.exit(1); });
